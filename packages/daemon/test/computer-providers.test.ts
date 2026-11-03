import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { COMPUTER_ARTIFACTS, resolveComputerProviders, type ArtifactPin } from "../src/computer-providers.ts";
import { startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

// Fake file protection for composition only: no native helper, ACL or desktop execution.
vi.mock("../src/windows-private-storage.ts", () => ({
	windowsPrivateStorage(operation: string, path: string, input?: Buffer) {
		if (operation === "ensure-dir") mkdirSync(path, { recursive: true });
		if (operation === "write-file") writeFileSync(path, input!);
	},
}));

it.each([
	["darwin", "arm64", "native-macos"],
	["darwin", "x64", "native-macos"],
	["linux", "x64", "none"],
	["win32", "arm64", "none"],
] as const)("preserves %s/%s without inspecting component paths", async (platform, arch, kind) => {
	const components = {
		get eyes(): never { throw new Error("must not read"); },
	};
	expect(await resolveComputerProviders({ platform, arch, components }))
		.toEqual({ status: "unavailable", kind });
});

it("is unavailable by default and when either Windows component is missing", async () => {
	expect((await resolveComputerProviders()).status).toBe("unavailable");
	const { pins, components } = fixture();
	for (const kind of ["eyes", "hands"] as const) {
		expect(await resolveComputerProviders({ platform: "win32", arch: "x64",
			components: { [kind]: components[kind] } }, pins))
			.toEqual({ status: "unavailable", kind: "windows-managed" });
	}
});

it("pins only immutable ScreenView and audited responsive Dot.2 hands, not upstream or Dot.1", () => {
	expect(COMPUTER_ARTIFACTS.map((p) => [p.kind, p.version, p.entry])).toEqual([
		["eyes", "0.2.1", "screenview-mcp.exe"],
		["hands", "0.2.1-dot.2", "gentle-dot-inputcontrol.exe"],
	]);
	expect(COMPUTER_ARTIFACTS.map((p) => p.entrySha256)).toEqual([
		"1c879efe55bdc543eec68b464a4fcaf879da95e6b660752a2b76bd66c21e10dd",
		"ea581fe8a586daa3c3e0ae7521453ec60440f5af966c4ee40776b048c0a4703f",
	]);
	expect(COMPUTER_ARTIFACTS.map((p) => [p.archiveSize, p.archiveSha256])).toEqual([
		[38900095, "5903547b9cdec9463ed848cf4e2a2fc6928af47fa4d166eba240776ec410e17d"],
		[22421353, "3117d925cd397fd79bfbb786723a294cfdc1bcc775790bbd4e2e10c78aedca0a"],
	]);
	expect(Object.isFrozen(COMPUTER_ARTIFACTS)).toBe(true);
	expect(COMPUTER_ARTIFACTS.every(Object.isFrozen)).toBe(true);
});

it("composes unavailable by default while preserving app computer registration and connector policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "factory-daemon-"));
	const app = fakeApp();
	const agentHome = join(root, "agent");
	const envFile = join(root, "env.json");
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: root,
		workspace: join(root, "workspace"),
		uiDir: root,
		agentHome,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: {
			TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir(),
			HOME: root, USERPROFILE: root, FAKE_AGENT_ENV_FILE: envFile,
		},
		profilesImportPath: join(root, "no-import.json"),
		importHome: root,
		authRuntime: async () => fakeAuthRuntime().runtime,
		appChannel: app.daemonEnd,
	});
	const servers = () => JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers;
	try {
		expect(daemon.computerProviders).toEqual({ status: "unavailable",
			kind: process.platform === "darwin" ? "native-macos" :
				process.platform === "win32" && process.arch === "x64" ? "windows-managed" : "none" });
		expect(servers()).toEqual({});
		expect(JSON.parse(JSON.parse(readFileSync(envFile, "utf8")).GENTLE_DOT_CONNECTOR_POLICY).builtin)
			.toBeUndefined();
		await app.request("computer_register", {
			url: "http://127.0.0.1:51234/mcp",
			token: "fixture-computer-key-0123456789abcdef",
		});
		await waitFor(() => servers().computer);
		expect(servers().computer).toEqual({
			url: "http://127.0.0.1:51234/mcp",
			headers: { Authorization: "Bearer fixture-computer-key-0123456789abcdef" },
			exposure: "direct",
			timeout: 300,
		});
		expect(Object.keys(servers())).toEqual(["computer"]);
		await app.request("computer_unregister");
		await waitFor(() => !servers().computer);
		expect(servers()).toEqual({});
		expect(app.asked).toEqual([]);
	} finally {
		await daemon.close();
	}
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "factory-"));
	const pins: ArtifactPin[] = ["eyes", "hands"].map((kind) => ({
		kind: kind as "eyes" | "hands", version: "fixture", entry: `${kind}.exe`,
		archiveSize: 7, archiveSha256: sha("archive"), entrySha256: sha(kind),
	}));
	const components = Object.fromEntries(pins.map((pin) => {
		const archivePath = join(root, `${pin.kind}.zip`);
		const executablePath = join(root, pin.entry);
		writeFileSync(archivePath, "archive");
		writeFileSync(executablePath, pin.kind);
		return [pin.kind, { archivePath, executablePath }];
	}));
	return { pins, components };
}

it("selects exactly eyes and Dot hands on Windows x64 without executing either", async () => {
	const { pins, components } = fixture();
	const result = await resolveComputerProviders({ platform: "win32", arch: "x64", components }, pins);
	expect(result).toEqual({ status: "ready", kind: "windows-managed", providers: pins.map((p) => ({
		kind: p.kind, version: p.version, executablePath: components[p.kind]!.executablePath,
	})) });
	for (const pin of pins) expect(readFileSync(components[pin.kind]!.executablePath, "utf8")).toBe(pin.kind);
});

it.each(["archive", "archive-size", "entry", "missing-archive", "missing-entry", "identity", "upstream-hands"])("fails closed for %s without returning launch paths", async (fault) => {
	const { pins, components } = fixture();
	const hands = components.hands!;
	if (fault === "archive") writeFileSync(hands.archivePath, "corrupt");
	if (fault === "archive-size") writeFileSync(hands.archivePath, "short");
	if (fault === "entry") writeFileSync(hands.executablePath, "corrupt");
	if (fault === "missing-archive") hands.archivePath += ".absent";
	if (fault === "missing-entry") hands.executablePath = join(hands.executablePath, "..", "absent", "hands.exe");
	if (fault === "identity") {
		hands.executablePath = join(hands.executablePath, "..", "wrong.exe");
		writeFileSync(hands.executablePath, "hands");
	}
	if (fault === "upstream-hands") writeFileSync(hands.executablePath, "upstream blue");
	const before = readFileSync(components.eyes!.executablePath, "utf8");
	expect(await resolveComputerProviders({ platform: "win32", arch: "x64", components }, pins))
		.toEqual({ status: "unavailable", kind: "windows-managed" });
	expect(readFileSync(components.eyes!.executablePath, "utf8")).toBe(before);
});
