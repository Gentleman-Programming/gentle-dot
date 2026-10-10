// Server mode as it runs in the container (S25.8, B1): these tests need root and real engine and
// connector users, so they run only inside the image (docs/design.md §8, server mode):
//   GENTLE_DOT_TEST_ENGINE_USER=dot GENTLE_DOT_TEST_CONNECTOR_USER=dotmcp vitest run <this file>
// Everywhere else they are skipped. The engine's user plants links and commands in its own files
// before the daemon starts; the root daemon must never run, read, or write through them.
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { engineAccess } from "../src/engine-access.ts";
import { writePrivateFile } from "../src/private-file.ts";
import { lookupUser } from "../src/vps.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ENGINE_USER = process.env.GENTLE_DOT_TEST_ENGINE_USER;
const CONNECTOR_USER = process.env.GENTLE_DOT_TEST_CONNECTOR_USER;
const asRoot = process.getuid?.() === 0 && ENGINE_USER !== undefined && CONNECTOR_USER !== undefined;
const ENGINE_DIRS = ["agent", "home", "workspace", "sessions", "gentle-ai"];

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** A folder only root can enter, with a root file in it that must never change or leak. */
function rootSecret(name: string, content: object) {
	const dir = mkdtempSync(join(tmpdir(), "root-only-"));
	chmodSync(dir, 0o700);
	const file = join(dir, name);
	writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
	return { dir, file, text: readFileSync(file, "utf8") };
}

/** Every regular file in the engine's folders, with its owner and text. */
function engineFiles(dataDir: string): { path: string; uid: number; text: string }[] {
	const out: { path: string; uid: number; text: string }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile()) out.push({ path, uid: stat.uid, text: readFileSync(path, "latin1") });
		}
	};
	for (const name of ENGINE_DIRS) if (existsSync(join(dataDir, name))) walk(join(dataDir, name));
	return out;
}

async function setup(plant: (dataDir: string, engineUid: number) => void = () => {}) {
	const engine = lookupUser(ENGINE_USER ?? "", readFileSync("/etc/passwd", "utf8"));
	const connector = lookupUser(CONNECTOR_USER ?? "", readFileSync("/etc/passwd", "utf8"));
	const dataDir = mkdtempSync(join(tmpdir(), "gentle-dot-root-"));
	for (const name of ENGINE_DIRS) mkdirSync(join(dataDir, name), { recursive: true });
	plant(dataDir, engine.uid);
	const env = { ...process.env };
	delete env.OPENAI_API_KEY;
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		agentEnv: env,
		backoffMs: [50],
		vps: {
			engine,
			connector,
			secretsKey: randomBytes(32),
			authHelper: { command: process.execPath, args: [CLI, "--auth-helper"] },
		},
	});
	daemons.push(d);
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	const after = (seen: number, pick: (m: ServerMessage) => boolean) =>
		waitFor(() => messages.slice(seen).find(pick), 20_000);
	return { d, dataDir, engine, messages, send, after };
}

const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(asRoot)("engine access as root: the kernel enforces the engine's user", () => {
	const capEff = () => /^CapEff:\s*(\S+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];

	it("cannot read a root file, makes files as the engine's user, and gets root and its capabilities back", () => {
		const engine = lookupUser(ENGINE_USER ?? "", readFileSync("/etc/passwd", "utf8"));
		const secret = rootSecret("secret.json", { root: "only" });
		const open = mkdtempSync(join(tmpdir(), "engine-"));
		chmodSync(open, 0o1777);
		const before = capEff();
		const access = engineAccess(engine);
		const seen = access(() => {
			let read: string;
			try {
				read = readFileSync(secret.file, "utf8");
			} catch (error) {
				read = (error as NodeJS.ErrnoException).code ?? "error";
			}
			writeFileSync(join(open, "made"), "x");
			return { read, euid: process.geteuid?.(), capEff: capEff() };
		});
		expect(seen).toEqual({ read: "EACCES", euid: engine.uid, capEff: "0000000000000000" });
		expect(statSync(join(open, "made")).uid).toBe(engine.uid);
		expect(process.geteuid?.()).toBe(0);
		expect(capEff()).toBe(before);
	});

	it("refuses to write a root file inside a bracket, and leaves nothing behind", () => {
		const engine = lookupUser(ENGINE_USER ?? "", readFileSync("/etc/passwd", "utf8"));
		const dir = mkdtempSync(join(tmpdir(), "root-files-"));
		chmodSync(dir, 0o1777);
		expect(() => engineAccess(engine)(() => writePrivateFile(join(dir, "token"), "x"))).toThrow();
		expect(readdirSync(dir)).toEqual([]);
		writePrivateFile(join(dir, "token"), "x");
		expect(statSync(join(dir, "token")).uid).toBe(0);
	});
});

describe.runIf(asRoot)("server mode as root: the daemon never acts on the engine's files as root", () => {
	it("a planted `!command` API key runs only as the engine's user, never as root", async () => {
		const drop = mkdtempSync(join(tmpdir(), "drop-"));
		chmodSync(drop, 0o1777);
		const marker = join(drop, "who");
		const s = await setup((dataDir) =>
			writeFileSync(
				join(dataDir, "agent", "auth.json"),
				JSON.stringify({ openai: { type: "api_key", key: `!id -u > '${marker}'; echo sk-x` } }),
			),
		);
		await waitFor(() => s.d.supervisor.state === "ready", 20_000);
		const seen = s.messages.length;
		s.send({ type: "auth_list" });
		await s.after(seen, (m) => m.type === "auth_providers" || m.type === "error");
		await settle();
		// It ran (the helper resolved the key for voice), and as the engine's user, never as root.
		await waitFor(() => existsSync(marker), 5000);
		expect(readFileSync(marker, "utf8").trim()).toBe(String(s.engine.uid));
		expect(statSync(marker).uid).toBe(s.engine.uid);
		// Nothing the daemon wrote in the engine's folders is root's.
		expect(
			engineFiles(s.dataDir)
				.filter((f) => f.uid === 0)
				.map((f) => f.path),
		).toEqual([]);
	});

	it("a link at auth.json never makes root write through it or copy the target", async () => {
		const target = rootSecret("auth.json", { anthropic: { type: "api_key", key: "root-only-auth-secret" } });
		const s = await setup((dataDir) => symlinkSync(target.file, join(dataDir, "agent", "auth.json")));
		await waitFor(() => s.d.supervisor.state === "ready", 20_000);
		const seen = s.messages.length;
		s.send({ type: "auth_login", providerId: "openai", method: "api_key" });
		const prompt = await s.after(seen, (m) => m.type === "auth_prompt");
		if (prompt.type !== "auth_prompt") throw new Error("no prompt");
		s.send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "sk-new-not-real" });
		await s.after(seen, (m) => m.type === "auth_done");
		await settle();
		expect(readFileSync(target.file, "utf8")).toBe(target.text);
		expect(statSync(target.file).uid).toBe(0);
		expect(engineFiles(s.dataDir).filter((f) => f.text.includes("root-only-auth-secret"))).toEqual([]);
	});

	it("a link at settings.json never makes root copy its target when the model changes", async () => {
		const target = rootSecret("settings.json", { rootOnly: "root-only-settings-secret" });
		const s = await setup((dataDir) => symlinkSync(target.file, join(dataDir, "agent", "settings.json")));
		await waitFor(() => s.d.supervisor.state === "ready", 20_000);
		const seen = s.messages.length;
		s.send({ type: "model_set", provider: "fake", id: "fake-fast" });
		await s.after(seen, (m) => m.type === "models" || m.type === "error");
		await settle();
		expect(readFileSync(target.file, "utf8")).toBe(target.text);
		expect(engineFiles(s.dataDir).filter((f) => f.text.includes("root-only-settings-secret"))).toEqual([]);
	});

	it("a link at the workspace's memory setting never makes root write through it", async () => {
		const target = rootSecret("config.json", { keep: "root-only-config" });
		await setup((dataDir) => {
			mkdirSync(join(dataDir, "workspace", ".engram"), { recursive: true });
			symlinkSync(target.file, join(dataDir, "workspace", ".engram", "config.json"));
		});
		expect(readFileSync(target.file, "utf8")).toBe(target.text);
	});

	it("an uploads folder that is a link never makes root write into its target", async () => {
		const target = rootSecret("keep.json", {});
		const s = await setup((dataDir) => symlinkSync(target.dir, join(dataDir, "workspace", "uploads")));
		const response = await fetch(`http://127.0.0.1:${s.d.port}/upload`, {
			method: "POST",
			headers: { authorization: `Bearer ${s.d.token}`, "x-file-name": "notes.txt" },
			body: "hello",
		});
		expect(response.ok).toBe(false);
		expect(readdirSync(target.dir)).toEqual(["keep.json"]);
		expect(statSync(target.dir).mode & 0o777).toBe(0o700);
	});
});
