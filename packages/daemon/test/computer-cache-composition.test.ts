import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { discoverComputerComponents } from "../src/computer-components.ts";
import { resolveComputerProviders, type AcquiredComponent } from "../src/computer-providers.ts";
import { startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

vi.mock("../src/computer-components.ts", async (original) => {
	const actual = await original<typeof import("../src/computer-components.ts")>();
	return { ...actual, discoverComputerComponents: vi.fn(actual.discoverComputerComponents) };
});
vi.mock("../src/computer-providers.ts", async (original) => {
	const actual = await original<typeof import("../src/computer-providers.ts")>();
	return { ...actual, resolveComputerProviders: vi.fn(actual.resolveComputerProviders) };
});
// Composition only, not proof of native ACLs or artifact hashes.
vi.mock("../src/windows-private-storage.ts", () => ({
	windowsPrivateStorage(operation: string, path: string, input?: Buffer) {
		if (operation === "ensure-dir") mkdirSync(path, { recursive: true });
		if (operation === "write-file") writeFileSync(path, input!);
	},
}));
beforeEach(() => { vi.mocked(discoverComputerComponents).mockClear(); vi.mocked(resolveComputerProviders).mockClear(); });
const kind = process.platform === "darwin" ? "native-macos" :
	process.platform === "win32" && process.arch === "x64" ? "windows-managed" : "none";
const pair = {
	eyes: { archivePath: "C:/private/eyes.zip", executablePath: "C:/private/eyes.exe" },
	hands: { archivePath: "C:/private/hands.zip", executablePath: "C:/private/hands.exe" },
};

async function observe(components?: Partial<Record<"eyes" | "hands", AcquiredComponent>>, invalid = false) {
	const root = mkdtempSync(join(tmpdir(), "cache-composition-")), app = fakeApp();
	const cache = join(root, "components"), agentHome = join(root, "agent"), envFile = join(root, "env.json");
	if (invalid) writeFileSync(cache, "invalid cache: never repair");
	const daemon = await startDaemon({
		port: 0, host: "127.0.0.1", dataDir: root, workspace: join(root, "workspace"), uiDir: root,
		agentHome, agentCommand: process.execPath, agentArgs: [FAKE_AGENT],
		agentEnv: { TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir(), HOME: root, USERPROFILE: root,
			FAKE_AGENT_ENV_FILE: envFile, GENTLE_DOT_ENGRAM: "0" },
		profilesImportPath: join(root, "absent"), importHome: root,
		authRuntime: async () => fakeAuthRuntime().runtime, appChannel: app.daemonEnd,
		...(components === undefined ? {} : { computerComponents: components }),
	});
	try {
		const status = daemon.computerProviders;
		expect(Object.isFrozen(status)).toBe(true);
		expect(Object.keys(status).sort()).toEqual(["kind", "status"]);
		expect(JSON.stringify(status)).not.toMatch(/private|archive|executable|token|providers/);
		const servers = () => JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers;
		expect(servers()).toEqual({});
		expect(JSON.parse(JSON.parse(readFileSync(envFile, "utf8")).GENTLE_DOT_CONNECTOR_POLICY).builtin)
			.toBeUndefined();
		if (invalid) expect(readFileSync(cache, "utf8")).toBe("invalid cache: never repair");
		else expect(readdirSync(root)).not.toContain("components");
		await app.request("computer_register", { url: "http://127.0.0.1:51234/mcp",
			token: "fixture-computer-key-0123456789abcdef" });
		await waitFor(() => servers().computer);
		expect(servers()).toEqual({ computer: { url: "http://127.0.0.1:51234/mcp",
			headers: { Authorization: "Bearer fixture-computer-key-0123456789abcdef" }, exposure: "direct", timeout: 300 } });
		await app.request("computer_unregister");
		await waitFor(() => !servers().computer);
		expect(servers()).toEqual({});
		expect(app.asked).toEqual([]);
		return { root, status };
	} finally { await daemon.close(); }
}

it("passes read-only discovery records to the fixed-pin resolver without exposing ready providers", async () => {
	vi.mocked(discoverComputerComponents).mockReturnValueOnce(pair);
	vi.mocked(resolveComputerProviders).mockResolvedValueOnce({ status: "ready", kind: "windows-managed",
		providers: [{ kind: "eyes", version: "fixture", executablePath: pair.eyes.executablePath }] });
	const { root, status } = await observe();
	expect(discoverComputerComponents).toHaveBeenCalledExactlyOnceWith(root);
	expect(resolveComputerProviders).toHaveBeenCalledExactlyOnceWith({ components: pair });
	expect(vi.mocked(resolveComputerProviders).mock.calls[0]![0]!.components).toBe(pair);
	expect(status).toEqual({ status: "ready", kind: "windows-managed" });
});

it.each([{}, { eyes: pair.eyes }])("retains explicit host priority without discovery or merging: %j", async (components) => {
	const { status } = await observe(components);
	expect(discoverComputerComponents).not.toHaveBeenCalled();
	expect(resolveComputerProviders).toHaveBeenCalledExactlyOnceWith({ components });
	expect(vi.mocked(resolveComputerProviders).mock.calls[0]![0]!.components).toBe(components);
	expect(status).toEqual({ status: "unavailable", kind });
});

it.each([false, true])("missing/invalid cache stays unavailable without cache mutation or startup failure: %s", async (invalid) => {
	const { root, status } = await observe(undefined, invalid);
	expect(discoverComputerComponents).toHaveBeenCalledExactlyOnceWith(root);
	expect(resolveComputerProviders).toHaveBeenCalledExactlyOnceWith({ components: undefined });
	expect(status).toEqual({ status: "unavailable", kind });
});
