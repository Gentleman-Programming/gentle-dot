import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { lockedDependencies, lockedEnginePackages } from "../../../packages/daemon/src/runtime-build.ts";
import { runtimeManifest } from "../../../packages/daemon/src/runtime-manifest.ts";

const esbuildModule = createRequire(
	new URL("../../../packages/daemon/package.json", import.meta.url),
).resolve("esbuild");
const actualLock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

async function mockedRuntimeBuilder(platform: "win32" | "linux", addon = true, goFails = false) {
	const calls: { command: string; args: string[] }[] = [];
	const writes = new Map<string, string>();
	const bundles: unknown[] = [];
	vi.resetModules();
	vi.doMock("node:child_process", () => ({
		execFileSync: (command: string, args: string[]) => {
			calls.push({ command, args });
			if (goFails) throw new Error("synthetic Go compiler failure");
		},
	}));
	vi.doMock("node:fs", () => ({
		readFileSync: (path: string) =>
			path.endsWith("pnpm-lock.yaml") ? actualLock : JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }),
		existsSync: (path: string) => !path.endsWith("windows-stop.node") || addon,
		mkdirSync: vi.fn(),
		chmodSync: vi.fn(),
		copyFileSync: vi.fn(),
		writeFileSync: (path: string, data: string) => writes.set(path, data),
	}));
	vi.doMock(esbuildModule, () => ({
		build: async (options: unknown) => {
			bundles.push(options);
		},
	}));
	try {
		const { buildRuntime } = await import("../../../packages/daemon/src/runtime-build.ts");
		await buildRuntime("/synthetic/runtime", platform);
		return { calls, writes, bundles };
	} finally {
		vi.doUnmock("node:child_process");
		vi.doUnmock("node:fs");
		vi.doUnmock(esbuildModule);
		vi.resetModules();
	}
}

it("mocked runtime builder emits the real Go helper and exact Windows manifest", async () => {
	const { calls, writes, bundles } = await mockedRuntimeBuilder("win32");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.command).toBe("go");
	expect(calls[0]?.args.slice(0, 3)).toEqual([
		"build",
		"-o",
		join("/synthetic/runtime", "bin", "private-storage.exe"),
	]);
	expect(calls[0]?.args[3]?.replaceAll("\\", "/")).toMatch(/scripts\/windows\/private-storage\/main.go$/);
	expect(bundles).toHaveLength(1);
	const manifest = JSON.parse(writes.get(join("/synthetic/runtime", "daemon", "package.json"))!);
	expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe("1.5.0");
	expect(manifest.dependencies["gentle-pi"]).toBe("4.6.0");
	expect(manifest.overrides).toEqual({
		"@earendil-works/pi-agent-core": "1.5.0",
		"@earendil-works/pi-codemode": "1.5.0",
		"@earendil-works/pi-schema": "1.5.0",
		"@earendil-works/pi-telemetry": "1.5.0",
	});
	expect(writes.get(join("/synthetic/runtime", "bin", "pi.cmd"))).toContain("node\\bin\\node.exe");
});

it("mocked runtime builder never invokes Go on Unix", async () => {
	const { calls, writes } = await mockedRuntimeBuilder("linux");
	expect(calls).toEqual([]);
	expect(writes.has(join("/synthetic/runtime", "bin", "pi"))).toBe(true);
});

it("mocked runtime builder refuses missing addon and propagates helper compiler failure", async () => {
	await expect(mockedRuntimeBuilder("win32", false)).rejects.toThrow(/addon is missing/);
	await expect(mockedRuntimeBuilder("win32", true, true)).rejects.toThrow(/synthetic Go compiler failure/);
});

it("uses the same exact SDK manifest on every host and retains upstream engine sibling overrides", () => {
	const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
	const dependencies = lockedDependencies(lock);
	const manifest = runtimeManifest(lock, dependencies);
	expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe("1.5.0");
	expect(manifest.dependencies["gentle-pi"]).toBe("4.6.0");
	expect({ ...lockedEnginePackages(dependencies, lock), ...manifest.overrides }).toEqual({
		"@earendil-works/pi-agent-core": "1.5.0",
		"@earendil-works/pi-codemode": "1.5.0",
		"@earendil-works/pi-schema": "1.5.0",
		"@earendil-works/pi-telemetry": "1.5.0",
	});
	const fixture =
		"packages:\n  '@earendil-works/pi-codemode@1.4.0':\n  '@earendil-works/pi-codemode@1.5.0':\n";
	expect(() => lockedEnginePackages({}, fixture)).toThrow(/two versions/);
	expect(lockedEnginePackages({ "@earendil-works/pi-codemode": "1.4.0" }, fixture)).toEqual({});
});

it("stager consumes the verified archive/extraction plan, normalized npm and explicit installer environment", () => {
	// Read-only wiring checks: never import the stager (its entrypoint installs/downloads).
	const source = readFileSync(new URL("../stage-runtime.mjs", import.meta.url), "utf8");
	expect(source).toContain("checksumFor(await text(`${base}/SHASUMS256.txt`), archiveName)");
	expect(source).toContain("const plan = nodeExtractionPlan(version, target);");
	expect(source).toContain("renameWhenReleased(join(node, from), join(node, to))");
	expect(source).toContain('join(out, "node", "bin", windows ? "node.exe" : "node")');
	expect(source).toContain('join(out, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js")');
	expect(source).toContain("installerEnv(out, CACHE, target, process.env, goExecutable)");
	expect(source).toContain("engramArchiveName(version, target, listing)");
	expect(source).toContain("checksumFor(listing, archiveName)");
	expect(source).toContain("if (result.status !== 0) throw new Error(`npm install failed");
	expect(source).toContain("const compatibility = await applyConsole(out)");
	expect(source.indexOf('await import("./windows-console.mjs")')).toBeLessThan(
		source.indexOf("prepareOut(out);"),
	);
	expect(source).not.toContain('join(out, "node", "node.exe")');
	expect(source).not.toMatch(/spawnCommandSync|extractZip|MinGit/);
});

it("build and package retain fail-closed native admission before emitting or adapting artifacts", () => {
	const build = readFileSync(
		new URL("../../../packages/daemon/src/runtime-build.ts", import.meta.url),
		"utf8",
	);
	expect(build.indexOf("const nativeArtifact = runtimeWindowsStopArtifact(platform);")).toBeLessThan(
		build.indexOf("mkdirSync(join(daemon"),
	);
	expect(build).toContain('copyFileSync(nativeArtifact, join(daemon, "native", "windows-stop.node"))');
	const entry = readFileSync(new URL("../package-windows.mjs", import.meta.url), "utf8");
	expect(entry).toContain("await runWindowsCli(process.argv.slice(2), nativeIO())");
	const pack = readFileSync(new URL("../windows-runtime-policy.mjs", import.meta.url), "utf8");
	expect(pack.indexOf("assertWindowsHost(io.platform, io.arch)")).toBeLessThan(
		pack.indexOf('manifest = io.readJson(join(runtime, "MANIFEST.json"))'),
	);
	expect(pack.indexOf("const plan = windowsPackagePlan(")).toBeLessThan(
		pack.indexOf("io.applyConsole(runtime,"),
	);
	expect(pack).not.toMatch(/npm install|pnpm\.cmd/);
});
