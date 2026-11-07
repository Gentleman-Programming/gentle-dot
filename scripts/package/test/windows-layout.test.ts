import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	installerEnv,
	layoutWindowsNode,
	npmWrapper,
	RUNTIME_HASH_SAMPLE,
	WINDOWS_RUNTIME_FILES,
} from "../lib.mjs";

const LAUNCH = new URL("../../../apps/desktop/src-tauri/src/daemon/launch.rs", import.meta.url);
const launch = readFileSync(LAUNCH, "utf8");

/** The relative paths `validate_packaged_runtime` requires, read from its `for relative in [...]` list. */
function requiredRuntimeFiles(): string[] {
	const list = /for relative in \[([^\]]+)\]/.exec(launch)?.[1];
	if (!list) throw new Error("launch.rs has no `for relative in [...]` required-file list.");
	return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** The Node path the Windows launch spec runs, read from its `#[cfg(windows)]` block. */
function launchNodePath(): string {
	const path = /dir\.join\("([^"]+node\.exe)"\)\.display\(\)\.to_string\(\)/.exec(launch)?.[1];
	if (!path) throw new Error("launch.rs has no Windows node.exe launch path.");
	return path;
}

/** The runtime folders the Windows launch spec puts on PATH, read from its `format!("{};{};...")` block. */
function launchPathDirs(source: string): string[] {
	// Up to the closing `),` of the format! call: its arguments hold `)` themselves.
	const block = /format!\("\{\};\{\};[^"]*",([\s\S]*?)\),\s*\n/.exec(source)?.[1];
	if (!block) throw new Error("launch.rs has no Windows PATH format! block.");
	return [...block.matchAll(/dir\.join\("([^"]+)"\)/g)].map((match) => match[1]);
}

describe("Windows runtime layout against launch.rs", () => {
	it("puts the folder of the Node it runs on the PATH it builds", () => {
		const nodeDir = launchNodePath().replace(/\/node\.exe$/, "");
		expect(launchPathDirs(launch)).toContain(nodeDir);
		// A PATH entry that drifts from the Node path is caught, not only a moved node.exe.
		const drifted = launch.replace('dir.join("node/bin").display()', 'dir.join("node").display()');
		expect(drifted).not.toBe(launch);
		expect(launchPathDirs(drifted)).not.toContain(nodeDir);
	});

	it("reads a non-trivial required-file list and a Node path from launch.rs", () => {
		expect(requiredRuntimeFiles().length).toBeGreaterThan(5);
		expect(launchNodePath()).toBe("node/bin/node.exe");
		expect(requiredRuntimeFiles()).toContain(launchNodePath());
	});

	it("puts the Node directory launch.rs runs on the installer PATH", () => {
		const nodeDir = launchNodePath()
			.replace(/\/node\.exe$/, "")
			.replace(/\//g, "\\");
		const env = installerEnv("C:\\stage", "C:\\cache", "win-x64", { SystemRoot: "C:\\Windows" });
		expect(env.PATH.split(";")).toContain(`C:\\stage\\${nodeDir}`);
	});

	it("hashes the Node binary launch.rs requires when the installer payload is checked", () => {
		expect(RUNTIME_HASH_SAMPLE).toContain(launchNodePath());
	});

	it("lays Node out where launch.rs runs it, with the npm shims beside it", () => {
		const scratch = mkdtempSync(join(tmpdir(), "windows-layout-"));
		try {
			// Node's Windows zip: node.exe and the cmd shims at the root, npm one folder down.
			const extracted = join(scratch, "node-v24-win-x64");
			mkdirSync(join(extracted, "node_modules", "npm", "bin"), { recursive: true });
			for (const name of ["node.exe", "npm.cmd", "npx.cmd", "LICENSE", "node_modules/npm/bin/npm-cli.js"])
				writeFileSync(join(extracted, name), name);
			const node = join(scratch, "runtime", "node");
			layoutWindowsNode(extracted, node);
			const runtime = join(scratch, "runtime");
			expect(existsSync(join(runtime, launchNodePath()))).toBe(true);
			expect(readFileSync(join(runtime, launchNodePath()), "utf8")).toBe("node.exe");
			expect(existsSync(join(node, "bin", "npm.cmd"))).toBe(true);
			expect(existsSync(join(node, "bin", "npx.cmd"))).toBe(true);
			expect(readFileSync(join(node, "bin", "npm.cmd"), "utf8")).toBe(npmWrapper("npm-cli.js", "win32"));
			expect(existsSync(join(node, "lib", "node_modules", "npm", "bin", "npm-cli.js"))).toBe(true);
			expect(existsSync(join(node, "node.exe"))).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("declares every required file the stages produce, and none launch.rs does not require", () => {
		expect([...WINDOWS_RUNTIME_FILES].sort()).toEqual([...requiredRuntimeFiles()].sort());
	});
});

describe("desktop bundle config", () => {
	it("lists the tracked Windows icon, which the MSI step needs", () => {
		const tauri = new URL("../../../apps/desktop/src-tauri/", import.meta.url);
		const config = JSON.parse(readFileSync(new URL("tauri.conf.json", tauri), "utf8"));
		expect(config.bundle.icon).toContain("icons/icon.ico");
		expect(existsSync(new URL("icons/icon.ico", tauri))).toBe(true);
	});
});
