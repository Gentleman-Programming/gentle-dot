// @real-agent T18b probe: the daemon's command line with the bundled engine, a stand-in model
// (OpenAI-compatible, 127.0.0.1), a temporary HOME and data folder, a private memory server on a
// free port, and a stand-in home with another app's MCP config. It checks that the engine offers
// `propose_connector` and that a draft reaches the daemon as a card; that an approved draft, an
// imported server, and a guided Discord entry (dummy token, left off so nothing reaches Discord or
// npm) render into an mcp.json the engine accepts (`mcp list --json`); and that the new servers'
// tools stay hidden from the model in read-only mode.
// Opt-in (it installs the engine's companion packages on the first start and needs `engram` and `lsof`):
//   GENTLE_DOT_T18B_PROBE=1 npx vitest run packages/daemon/test/connector-draft-probe.test.ts
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bundledMcpCli } from "../src/connectors.ts";
import { tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url));
const enabled = process.env.GENTLE_DOT_T18B_PROBE === "1";

type Rec = Record<string, unknown>;

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

/** The stand-in model: "propose" calls propose_connector when it is offered; anything else answers. */
function fakeModel(toolLists: string[][]) {
	return createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			const request = JSON.parse(body) as {
				tools?: { function?: { name?: string } }[];
				messages?: { role: string; content?: unknown }[];
			};
			const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? "");
			toolLists.push(tools);
			const last = request.messages?.at(-1);
			const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const chunk = (delta: Rec, finish: string | null) =>
				res.write(
					`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
				);
			if (last?.role === "user" && text.includes("propose") && tools.includes("propose_connector")) {
				const args = {
					name: "Probe Tools",
					description: "A stand-in server for the probe.",
					transport: "stdio",
					command: process.execPath,
					args: [FAKE_SERVER, "--drafted"],
				};
				chunk(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_propose",
								type: "function",
								function: { name: "propose_connector", arguments: JSON.stringify(args) },
							},
						],
					},
					null,
				);
				chunk({}, "tool_calls");
			} else {
				const reply = last?.role === "tool" ? `Tool said: ${text.slice(0, 200)}` : "Okay.";
				chunk({ role: "assistant", content: reply }, null);
				chunk({}, "stop");
			}
			res.end("data: [DONE]\n\n");
		});
	});
}

function listener(port: number): number | undefined {
	try {
		const pid = execFileSync("lsof", ["-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"])
			.toString()
			.trim();
		return /^\d+$/.test(pid) ? Number(pid) : undefined;
	} catch {
		return undefined;
	}
}

describe.skipIf(!enabled)("@real-agent T18b connector probe", () => {
	it("takes a draft from the engine to a card, and the engine accepts the guided, drafted, and imported servers", {
		timeout: 400_000,
	}, async () => {
		const home = tempDir();
		const importHome = tempDir();
		const dataDir = join(tempDir(), "data");
		const agentHome = join(dataDir, "agent");
		mkdirSync(agentHome, { recursive: true });
		// Another app's config (a fixture, never the user's): one stdio server with a secret value.
		mkdirSync(join(importHome, ".cursor"), { recursive: true });
		writeFileSync(
			join(importHome, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					imported: {
						command: process.execPath,
						args: [FAKE_SERVER, "--imported"],
						env: { PROBE_KEY: "pr0be-$ecret" },
					},
				},
			}),
		);
		const toolLists: string[][] = [];
		const model = fakeModel(toolLists);
		const modelPort = await freePort();
		await new Promise<void>((resolve) => model.listen(modelPort, "127.0.0.1", resolve));
		writeFileSync(
			join(agentHome, "models.json"),
			JSON.stringify({
				providers: {
					fakeprov: {
						baseUrl: `http://127.0.0.1:${modelPort}/v1`,
						api: "openai-completions",
						apiKey: "not-a-key",
						models: [{ id: "fake-model" }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentHome, "settings.json"),
			JSON.stringify({ defaultProvider: "fakeprov", defaultModel: "fake-model" }),
		);
		// Discord set up earlier with a dummy token, and turned off.
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 1,
				connectors: { discord: { enabled: false, mode: "read_only", values: { token: "dummy-token-$!x" } } },
			}),
		);
		const memoryPort = await freePort();
		const child: ChildProcess = spawn(process.execPath, [CLI], {
			env: {
				PATH: process.env.PATH,
				HOME: home,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_ENGRAM: "private",
				GENTLE_DOT_ENGRAM_PORT: String(memoryPort),
				GENTLE_DOT_IMPORT_HOME: importHome,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
		const messages: ServerMessage[] = [];
		try {
			await waitFor(() => /Gentle Dot is running|failed to start/.test(output), 300_000);
			const port = /127\.0\.0\.1:(\d+)/.exec(output)?.[1];
			const health = async () =>
				((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { agentState: string })
					.agentState;
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
			ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
			await new Promise((resolve) => ws.on("open", resolve));
			const token = readFileSync(join(dataDir, "token"), "utf8").trim();
			ws.send(JSON.stringify({ type: "hello", token, protocol: 1 }));
			await waitFor(() => messages.some((m) => m.type === "ready"), 10_000);
			const settle = async () => {
				for (;;) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					if ((await health().catch(() => "")) === "idle") return;
				}
			};
			const find = <T extends ServerMessage["type"]>(
				type: T,
				where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
			) =>
				waitFor(
					() =>
						messages.find(
							(m): m is Extract<ServerMessage, { type: T }> =>
								m.type === type && where(m as Extract<ServerMessage, { type: T }>),
						),
					120_000,
				);
			await settle();

			ws.send(JSON.stringify({ type: "send", text: "propose a connector" }));
			const card = await find("connector_draft");
			await settle();
			ws.send(JSON.stringify({ type: "connector_draft_reply", draftId: card.draft.draftId, approve: true }));
			await find("auth_done", (m) => m.providerId === "probe-tools");
			ws.send(JSON.stringify({ type: "connectors_scan" }));
			const scan = await find("connector_imports");
			const imported = scan.found.find((c) => c.name === "imported");
			ws.send(JSON.stringify({ type: "connector_import", ids: [imported?.id ?? ""] }));
			await find("connector_imported");
			await settle();
			ws.send(JSON.stringify({ type: "send", text: "which tools do you have" }));
			await waitFor(() => messages.some((m) => m.type === "agent_state" && m.state === "thinking"), 30_000);
			await settle();

			const cli = bundledMcpCli();
			const list = spawnSync(cli.command, [...cli.args, "mcp", "list", "--json"], {
				cwd: join(dataDir, "workspace"),
				env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentHome },
				encoding: "utf8",
				timeout: 60_000,
			});
			const engineList = JSON.parse(list.stdout.slice(list.stdout.indexOf("{"))) as {
				servers: { name: string; enabled: boolean; state: string; tools: string[]; toolExposure?: Rec }[];
				errors: string[];
			};
			const lastTools = toolLists.at(-1) ?? [];
			const summary = {
				card: card.draft,
				imports: scan.found,
				engineList,
				mcpJson: JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")),
				signinMcpJson: JSON.parse(readFileSync(join(dataDir, "connector-signin", "mcp.json"), "utf8")),
				toolsOfferedLast: lastTools.filter(
					(name) => name.startsWith("mcp__") || name === "propose_connector",
				),
				proposeOffered: toolLists.some((tools) => tools.includes("propose_connector")),
			};
			console.log(`T18b probe:\n${JSON.stringify(summary, null, 2)}`);
			ws.close();
			expect(summary.proposeOffered).toBe(true);
			expect(card.draft).toMatchObject({
				name: "Probe Tools",
				transport: "stdio",
				command: process.execPath,
			});
			expect(JSON.stringify(scan.found)).not.toContain("pr0be-$ecret");
			expect(engineList.errors).toEqual([]);
			const byName = Object.fromEntries(engineList.servers.map((s) => [s.name, s]));
			expect(byName.discord).toMatchObject({ enabled: false, state: "disabled" });
			expect(byName["probe-tools"]).toMatchObject({ enabled: true, state: "connected" });
			expect(byName.imported).toMatchObject({ enabled: true, state: "connected" });
			// Read only with no curated list: the proxy shows none of their tools (S25.4).
			expect(byName["probe-tools"]?.tools).toEqual([]);
			expect(lastTools.filter((name) => /^mcp__(probe_tools|imported)__/.test(name))).toEqual([]);
			// The engine's mcp.json holds only proxy addresses; the real servers are in the sign-in home.
			expect(JSON.stringify(summary.mcpJson)).not.toContain("DISCORD_TOKEN");
			expect(summary.signinMcpJson.mcpServers.discord.env.DISCORD_TOKEN).not.toBe("dummy-token-$!x");
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			await exited;
			model.close();
			// The private memory server: stopped by the daemon; if one is still there, stop it by PID,
			// only after checking it serves this probe's data folder.
			const pid = listener(memoryPort);
			const idFile = join(dataDir, "home", ".engram", ".instance-id");
			const expected = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : undefined;
			const served = await fetch(`http://127.0.0.1:${memoryPort}/health`)
				.then((r) => r.json() as Promise<{ instance_id?: string }>)
				.catch(() => undefined);
			if (pid && expected && served?.instance_id === expected) process.kill(pid, "SIGTERM");
			console.log(
				`private memory on ${memoryPort}: still listening after close: ${pid ?? "no"}; stopped by the probe: ${Boolean(pid && expected && served?.instance_id === expected)}`,
			);
			console.log(output.slice(-3000));
		}
	});
});
