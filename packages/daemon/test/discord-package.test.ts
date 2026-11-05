import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DiscordPackage } from "../src/discord-package.ts";
import { tempDir } from "./helpers.ts";

function installed(folder: string) {
	const pkg = join(folder, "node_modules", "@pasympa", "discord-mcp");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@pasympa/discord-mcp",
			version: "2.2.0",
			bin: { "discord-mcp": "dist/index.js" },
		}),
	);
	writeFileSync(join(pkg, "dist/index.js"), "// synthetic server; never executed\n");
}

it("publishes a cold preparation only after acquisition and reuses it after owner recreation", async () => {
	const root = tempDir();
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const acquire = async (folder: string) => {
		calls++;
		await gate;
		installed(folder);
	};
	const owner = new DiscordPackage(root, acquire);
	const signal = new AbortController().signal;
	const pending = owner.prepare(signal);
	expect(owner.command()).toBeUndefined();
	release();
	await pending;
	expect(calls).toBe(1);
	const command = owner.command();
	expect(command?.command).toBe(process.execPath);
	expect(existsSync(command?.args[0] ?? "")).toBe(true);
	const reopened = new DiscordPackage(root, async () => {
		throw new Error("warm start downloaded");
	});
	await reopened.prepare(signal);
	expect(reopened.command()).toEqual(command);
});

it("does not publish interrupted staging and retries without removing unrelated data", async () => {
	const root = tempDir();
	writeFileSync(join(root, "unrelated"), "keep");
	let calls = 0;
	const owner = new DiscordPackage(root, async (folder) => {
		calls++;
		writeFileSync(join(folder, "partial"), "incomplete");
		if (calls === 1) throw new Error("download interrupted");
		installed(folder);
	});
	await expect(owner.prepare(new AbortController().signal)).rejects.toThrow("download interrupted");
	expect(owner.command()).toBeUndefined();
	expect(readdirSync(root)).toContain("unrelated");
	await owner.prepare(new AbortController().signal);
	expect(owner.command()).toBeDefined();
	expect(calls).toBe(2);
	expect(existsSync(join(root, "unrelated"))).toBe(true);
});

it("recovers staging from an exited owner without touching a live owner's staging", async () => {
	const root = tempDir();
	const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	expect(exited.status).toBe(0);
	const stale = join(root, `discord-stage-${exited.pid}-00000000-0000-0000-0000-000000000000`);
	const live = join(root, `discord-stage-${process.pid}-11111111-1111-1111-1111-111111111111`);
	mkdirSync(stale);
	writeFileSync(join(stale, "partial"), "interrupted");
	mkdirSync(live);
	writeFileSync(join(live, "partial"), "active");
	const owner = new DiscordPackage(root, async (folder) => {
		installed(folder);
	});
	await owner.prepare(new AbortController().signal);
	expect(existsSync(stale)).toBe(false);
	expect(existsSync(join(live, "partial"))).toBe(true);
	expect(owner.command()).toBeDefined();
});

it("refuses to publish a cancelled acquisition even if the installer completes", async () => {
	const root = tempDir();
	const controller = new AbortController();
	const owner = new DiscordPackage(root, async (folder) => {
		installed(folder);
		controller.abort();
	});
	await expect(owner.prepare(controller.signal)).rejects.toThrow();
	expect(owner.command()).toBeUndefined();
});
