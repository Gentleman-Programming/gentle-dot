// The approval guard inside the real bundled engine (pi-coding-agent's own command line), with a
// stand-in model (an OpenAI-compatible server on 127.0.0.1) and a stand-in MCP server over stdio.
// No account, network, or Gentle Shell setup is needed.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_GUARD, bundledMcpCli } from "../src/connectors.ts";
import { POLICY_ENV } from "../src/extensions/approval-guard.ts";
import { encodeRecord, JsonlDecoder } from "../src/jsonl.ts";
import { tempDir, waitFor } from "./helpers.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url));

type Rec = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Answers the first request with the given tool calls once the MCP tools are offered, then with text. */
function fakeModel(calls: { name: string; args: Rec }[]): Promise<Server> {
	let called = false;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			const tools = ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map(
				(tool) => tool.function?.name,
			);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const chunk = (delta: Rec, finish: string | null) =>
				res.write(
					`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
				);
			if (!called && calls.every((call) => tools.includes(call.name))) {
				called = true;
				chunk(
					{
						role: "assistant",
						tool_calls: calls.map((call, index) => ({
							index,
							id: `call_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.args) },
						})),
					},
					null,
				);
				chunk({}, "tool_calls");
			} else {
				chunk({ role: "assistant", content: called ? "done" : `missing tools: ${tools.join(",")}` }, null);
				chunk({}, "stop");
			}
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function startEngine(port: number) {
	const dir = tempDir();
	const agentDir = join(dir, "agent");
	const workspace = join(dir, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const callsFile = join(dir, "server-calls.jsonl");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fakeprov: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "not-a-key",
					models: [{ id: "fake-model" }],
				},
			},
		}),
	);
	const mcpFile = join(agentDir, "mcp.json");
	writeFileSync(
		mcpFile,
		JSON.stringify({
			mcpServers: { fake: { command: process.execPath, args: [FAKE_SERVER], exposure: "direct" } },
		}),
	);
	const policy = {
		connectors: { fake: { name: "Fake Chat", mode: "read_write", readOnlyTools: ["list_messages"] } },
		protectedPaths: [mcpFile, join(agentDir, "mcp-auth.json")],
	};
	const cli = bundledMcpCli();
	const child: ChildProcess = spawn(
		cli.command,
		[...cli.args, "--mode", "rpc", "--no-session", "--model", "fakeprov/fake-model", "-e", APPROVAL_GUARD],
		{
			cwd: workspace,
			env: {
				...process.env,
				HOME: dir,
				PI_CODING_AGENT_DIR: agentDir,
				FAKE_MCP_SERVER_CALLS: callsFile,
				[POLICY_ENV]: JSON.stringify(policy),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	cleanups.push(() => child.kill("SIGKILL"));
	const records: Rec[] = [];
	let stderr = "";
	const decoder = new JsonlDecoder((record) => records.push(record as Rec));
	child.stdout?.on("data", (chunk: Buffer) => decoder.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const send = (record: Rec) => child.stdin?.write(encodeRecord(record));
	const serverCalls = () =>
		existsSync(callsFile)
			? readFileSync(callsFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as { name: string }).name)
			: [];
	return { child, records, send, serverCalls, mcpFile, stderr: () => stderr };
}

const engineAvailable = (() => {
	try {
		bundledMcpCli();
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!engineAvailable)("approval guard in the real engine", () => {
	it("runs read-only tools, asks before sending, and blocks a declined send and a write to mcp.json", async () => {
		const engine = { mcp: "" };
		const model = await fakeModel([
			{ name: "mcp__fake__list_messages", args: {} },
			{ name: "mcp__fake__send_message", args: { to: "bob@example.com", body: "Hello Bob" } },
			{ name: "write", args: { path: "../agent/mcp.json", content: "{}" } },
		]);
		cleanups.push(() => model.close());
		const { records, send, serverCalls, mcpFile, stderr } = startEngine(
			(model.address() as AddressInfo).port,
		);
		engine.mcp = readFileSync(mcpFile, "utf8");
		send({ type: "get_state", id: "s" });
		await waitFor(() => records.find((r) => r.id === "s"), 20_000).catch(() => {
			throw new Error(`the engine did not start: ${stderr().slice(-800)}`);
		});
		expect(stderr()).not.toMatch(/Failed to load extension/);

		// The MCP server connects in the background; prompt again until the model sees its tools.
		let prompts = 0;
		const ask = await waitFor(() => {
			const found = records.find((r) => r.type === "extension_ui_request" && r.method === "confirm");
			if (found) return found;
			if (records.filter((r) => r.type === "agent_settled").length >= prompts)
				send({ type: "prompt", id: `p${prompts++}`, message: "check my messages" });
			return undefined;
		}, 20_000);
		expect(ask).toMatchObject({
			title: "Allow Fake Chat to send message?",
			message: expect.stringContaining("to: bob@example.com\nbody: Hello Bob"),
		});
		send({ type: "extension_ui_response", id: ask.id, confirmed: false });

		const ends = await waitFor(() => {
			const found = records.filter((r) => r.type === "tool_execution_end");
			return found.length >= 3 ? found : undefined;
		}, 20_000);
		const byTool = Object.fromEntries(ends.map((r) => [r.toolName, r]));
		const text = (r: Rec | undefined) => JSON.stringify((r?.result as Rec | undefined)?.content ?? r?.result);
		expect(byTool.mcp__fake__list_messages?.isError).toBe(false);
		expect(byTool.mcp__fake__send_message?.isError).toBe(true);
		expect(text(byTool.mcp__fake__send_message)).toContain("did not allow");
		expect(byTool.write?.isError).toBe(true);
		expect(text(byTool.write)).toContain("Connectors screen");
		expect(serverCalls()).toEqual(["list_messages"]);
		expect(readFileSync(mcpFile, "utf8")).toBe(engine.mcp);
		expect(records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm")).toHaveLength(
			1,
		);
	}, 60_000);
});
