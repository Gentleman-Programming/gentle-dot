import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { ServerMessage, UploadedFile } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

type Prompt = { type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: string };

async function setup() {
	const dataDir = tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir);
	writeFileSync(join(uiDir, "index.html"), "<!doctype html>");
	const workspace = join(dataDir, "workspace");
	const promptsFile = join(dataDir, "prompts.jsonl");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace,
		uiDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env, FAKE_AGENT_PROMPTS_FILE: promptsFile },
		backoffMs: [50],
	});
	daemons.push(d);
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (message: object) => ws.send(JSON.stringify(message));
	const find = <T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
	) =>
		waitFor(() =>
			messages.find(
				(m): m is Extract<ServerMessage, { type: T }> =>
					m.type === type && where(m as Extract<ServerMessage, { type: T }>),
			),
		);
	const prompts = (): Prompt[] =>
		existsSync(promptsFile)
			? readFileSync(promptsFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Prompt)
			: [];
	const upload = (name: string, body: Buffer | string, uploadId?: string) =>
		new Promise<UploadedFile>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: d.port,
					path: "/upload",
					method: "POST",
					headers: {
						Authorization: `Bearer ${d.token}`,
						"X-File-Name": encodeURIComponent(name),
						...(uploadId ? { "X-Upload-Id": uploadId } : {}),
					},
				},
				(res) => {
					let text = "";
					res.on("data", (chunk) => {
						text += chunk;
					});
					res.on("end", () =>
						res.statusCode === 200 ? resolve(JSON.parse(text) as UploadedFile) : reject(new Error(text)),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	return { d, workspace, messages, send, find, prompts, upload };
}

describe("sending files to the assistant", () => {
	it("leaves a plain message unchanged (regression)", async () => {
		const { send, find, prompts } = await setup();
		send({ type: "send", text: "hello", requestId: "r1" });
		const shown = await find("user_message");
		expect(shown).toEqual({
			type: "user_message",
			messageId: shown.messageId,
			text: "hello",
			seq: shown.seq,
		});
		await find("message_done");
		expect(prompts()).toEqual([{ type: "prompt", message: "hello" }]);
	});

	it("tells the assistant each file's path, shows chips instead, and passes images to a model that sees them", async () => {
		const { send, find, prompts, upload, workspace } = await setup();
		const doc = await upload("report.txt", "quarterly numbers");
		const shot = await upload("shot.png", PNG, doc.uploadId);
		send({
			type: "send",
			text: "what do you see?",
			requestId: "r1",
			attachments: [
				{ uploadId: doc.uploadId, name: doc.name },
				{ uploadId: shot.uploadId, name: shot.name },
			],
		});
		const shown = await find("user_message");
		expect(shown.text).toBe("what do you see?");
		expect(shown.attachments).toEqual([
			{ name: "report.txt", size: 17, mime: "application/octet-stream" },
			{ name: "shot.png", size: PNG.length, mime: "image/png" },
		]);
		await find("message_done");
		const [prompt] = prompts();
		expect(prompt?.message.startsWith("what do you see?\n\n<attachments>\n")).toBe(true);
		expect(prompt?.message).toContain(JSON.stringify(join(workspace, doc.path)));
		expect(prompt?.message).toContain(JSON.stringify(join(workspace, shot.path)));
		expect(prompt?.images).toEqual([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);

		// History keeps the chips and hides the block.
		send({ type: "get_history" });
		const history = await find("history", (h) => h.messages.length >= 2);
		const user = history.messages.find((m) => m.role === "user");
		expect(user?.text).toBe("what do you see?");
		expect(user?.attachments?.map((a) => a.name)).toEqual(["report.txt", "shot.png"]);
	});

	it("keeps images out of the prompt when the model cannot see them, and says so", async () => {
		const { d, send, find, prompts, upload } = await setup();
		await d.supervisor.request({ type: "set_model", provider: "fake", modelId: "fake-fast" });
		const shot = await upload("shot.png", PNG);
		send({ type: "send", text: "", attachments: [{ uploadId: shot.uploadId, name: shot.name }] });
		const shown = await find("user_message");
		expect(shown.text).toBe("");
		await find("message_done");
		const [prompt] = prompts();
		expect(prompt?.images).toBeUndefined();
		expect(prompt?.message).toMatch(/cannot see images/);
	});

	it("refuses unknown and already sent uploads without prompting", async () => {
		const { send, find, prompts, upload, messages } = await setup();
		const refusals = () => messages.filter((m) => m.type === "error" && m.code === "attachment_not_found");
		send({
			type: "send",
			text: "here",
			attachments: [{ uploadId: "u_00000000000000000000", name: "a.txt" }],
		});
		expect((await find("error")).code).toBe("attachment_not_found");
		const doc = await upload("a.txt", "hi");
		const ref = { uploadId: doc.uploadId, name: doc.name };
		send({ type: "send", text: "first", attachments: [ref] });
		await find("message_done");
		send({ type: "send", text: "again", attachments: [ref] });
		await waitFor(() => refusals().length === 2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(prompts().map((p) => p.message.split("\n")[0])).toEqual(["first"]);
	});
});
