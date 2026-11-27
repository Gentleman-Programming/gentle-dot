import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createModelAuthRuntime } from "../src/auth.ts";
import { startDaemon } from "../src/daemon.ts";
import { ENGINE_HOME_MARKER } from "../src/isolation.ts";
import { ProviderStorageInitializationError } from "../src/private-file.ts";
import { windowsPrivateStorage } from "../src/windows-private-storage.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

vi.mock("node:child_process", { spy: true });

const fixture = vi.hoisted(() => ({
	events: [] as string[],
	refusal: false,
	refusedDirectory: undefined as string | undefined,
	admitted: new Set<string>(),
}));
vi.mock("../src/windows-private-storage.ts", () => ({
	windowsPrivateStorage: vi.fn((operation: string, path: string, input?: Buffer) => {
		if (operation === "ensure-dir") {
			if (path === fixture.refusedDirectory) throw new Error("fixture home owner mismatch");
			mkdirSync(path, { recursive: true });
			fixture.admitted.add(path);
		}
		if (operation === "write-file") writeFileSync(path, input!);
		if (operation === "secure-file" && path.endsWith("auth.json")) fixture.events.push("secure");
		if (operation === "create-file-if-absent") {
			fixture.events.push("initialize");
			if (!fixture.admitted.delete(dirname(path))) throw new Error("fixture parent not admitted for this attempt");
			if (fixture.refusal) throw new Error("fixture owner mismatch");
			try {
				writeFileSync(path, "{}", { flag: "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	}),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: ({ authPath }: { authPath: string }) => {
		fixture.events.push(`sdk:${readFileSync(authPath, "utf8")}`);
		return { registerNativeProvider() {} };
	} },
	SettingsManager: { create: () => ({}) },
}));
vi.mock("jiti", () => ({ createJiti: () => ({
	import: async () => ({ createNanProviderConfig: () => ({ id: "fixture" }) }),
}) }));

function syntheticRoot() {
	fixture.events.length = 0;
	fixture.refusal = false;
	fixture.refusedDirectory = undefined;
	fixture.admitted.clear();
	vi.mocked(windowsPrivateStorage).mockClear();
	vi.mocked(spawn).mockClear();
	return mkdtempSync(join(tmpdir(), "dot-provider-order-"));
}

it.skipIf(process.platform !== "win32")("prepares the selected Accounts home before the SDK, retaining legacy normalization", async () => {
	const root = syntheticRoot();
	const home = join(root, "selected");
	await createModelAuthRuntime(home, root);
	expect(fixture.events).toEqual(["secure", "initialize", "sdk:{}", "secure"]);
	const path = join(home, "auth.json");
	expect(windowsPrivateStorage).toHaveBeenCalledWith("create-file-if-absent", path);
	writeFileSync(path, '{ "example": "synthetic" }\n');
	fixture.events.length = 0;
	await createModelAuthRuntime(home, root);
	expect(fixture.events).toEqual(["secure", "initialize", 'sdk:{ "example": "synthetic" }\n', "secure"]);
	fixture.events.length = 0;
	fixture.refusal = true;
	await expect(createModelAuthRuntime(home, root)).rejects.toThrow(/fixture owner mismatch/);
	expect(fixture.events).toEqual(["secure", "initialize"]);
	expect(readFileSync(path, "utf8")).toBe('{ "example": "synthetic" }\n');
});

it.skipIf(process.platform === "win32")("keeps an existing POSIX Accounts file on the SDK-only path", async () => {
	const root = syntheticRoot();
	const path = join(root, "auth.json");
	writeFileSync(path, '{}\n');
	await createModelAuthRuntime(root, root);
	expect(fixture.events).toEqual(["sdk:{}\n"]);
	expect(windowsPrivateStorage).not.toHaveBeenCalled();
	expect(readFileSync(path, "utf8")).toBe('{}\n');
});

it.skipIf(process.platform !== "win32")("keeps health available on owner refusal, checks each managed attempt, and preserves an unmanaged home", async () => {
	const root = syntheticRoot();
	const dataDir = join(root, "data");
	// A non-default home inside dataDir is not separately prepared by the directory claim.
	const agentHome = join(dataDir, "selected-engine");
	expect(existsSync(agentHome)).toBe(false);
	const unrelated = join(root, "unrelated.json");
	const logs: string[] = [];
	writeFileSync(unrelated, "untouched");
	fixture.refusal = true;
	// On ready, the bridge queries provider names for the model picker. Keep that
	// Accounts actor observable but separate from the managed spawn's storage calls.
	const { runtime } = fakeAuthRuntime();
	const authRuntime = vi.fn(async () => runtime);
	const options = {
		port: 0, host: "127.0.0.1", dataDir, workspace: join(root, "workspace"), uiDir: root,
		agentCommand: process.execPath, agentArgs: [FAKE_AGENT], backoffMs: [10], computerComponents: {},
		agentEnv: { HOME: root, USERPROFILE: root, GENTLE_DOT_ENGRAM: "0" },
		profilesImportPath: join(root, "absent"), importHome: root, authRuntime, log: (line: string) => logs.push(line),
	};
	const fakeSpawns = () => vi.mocked(spawn).mock.calls.flatMap(([, args], index) =>
		Array.isArray(args) && args[0] === FAKE_AGENT ? [vi.mocked(spawn).mock.invocationCallOrder[index]!] : [],
	);
	const initializationCalls = () => vi.mocked(windowsPrivateStorage).mock.calls.flatMap(([operation, path], index) =>
		operation === "create-file-if-absent" && path === join(agentHome, "auth.json")
			? [vi.mocked(windowsPrivateStorage).mock.invocationCallOrder[index]!]
			: [],
	);
	const daemon = await startDaemon({ ...options, agentHome });
	try {
		expect((await fetch(`http://127.0.0.1:${daemon.port}/health`)).ok).toBe(true);
		expect(daemon.supervisor.pid).toBeUndefined();
		expect(daemon.supervisor.state).toBe("stopped");
		expect(logs.find((line) => line.startsWith("agent failed to start:"))).toMatch(/fixture owner mismatch/);
		expect(logs.find((line) => line.startsWith("agent failed to start:"))).not.toMatch(/retrying/);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(fixture.events).toEqual(["initialize"]);
		expect(fakeSpawns()).toEqual([]);
		fixture.refusal = false;
		await daemon.supervisor.restart();
		expect(daemon.supervisor.state).toBe("ready");
		expect(readFileSync(join(agentHome, "auth.json"), "utf8")).toBe("{}");
		expect(existsSync(join(agentHome, ENGINE_HOME_MARKER))).toBe(false);
		expect(authRuntime).toHaveBeenCalledTimes(1);
		expect(initializationCalls()).toHaveLength(2);
		fixture.refusedDirectory = agentHome;
		const refusedRestart = daemon.supervisor.restart();
		await expect(refusedRestart).rejects.toBeInstanceOf(ProviderStorageInitializationError);
		await expect(refusedRestart).rejects.toThrow(/fixture home owner mismatch/);
		expect(daemon.supervisor.state).toBe("stopped");
		expect(daemon.supervisor.pid).toBeUndefined();
		expect(initializationCalls()).toHaveLength(2);
		expect(fakeSpawns()).toHaveLength(1);
		fixture.refusedDirectory = undefined;
		await daemon.supervisor.restart();
		fixture.refusal = true;
		await expect(daemon.supervisor.restart()).rejects.toThrow(/fixture owner mismatch/);
		expect(daemon.supervisor.state).toBe("stopped");
		expect(daemon.supervisor.pid).toBeUndefined();
		expect(fixture.events).toEqual(Array(4).fill("initialize"));
		fixture.refusal = false;
		await daemon.supervisor.restart();
		const pid = daemon.supervisor.pid;
		if (pid === undefined) throw new Error("fixture agent did not start");
		fixture.refusal = true;
		process.kill(pid, "SIGKILL");
		await waitFor(() => logs.some((line) => /agent restart failed:.*fixture owner mismatch/.test(line)));
		expect(daemon.supervisor.state).toBe("stopped");
		expect(daemon.supervisor.pid).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(fixture.events).toEqual(Array(6).fill("initialize"));
		expect(fakeSpawns()).toHaveLength(3);
		expect(initializationCalls()).toHaveLength(6);
		expect(initializationCalls()[1]!).toBeLessThan(fakeSpawns()[0]!);
		expect(initializationCalls()[2]!).toBeLessThan(fakeSpawns()[1]!);
		expect(initializationCalls()[4]!).toBeLessThan(fakeSpawns()[2]!);
		expect(readFileSync(unrelated, "utf8")).toBe("untouched");
	} finally {
		await daemon.close();
	}
	const unmanaged = await startDaemon(options);
	try {
		expect(unmanaged.supervisor.state).toBe("ready");
		expect(fixture.events).toHaveLength(6);
	} finally {
		await unmanaged.close();
	}
});
