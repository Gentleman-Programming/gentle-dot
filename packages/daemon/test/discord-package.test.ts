import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquisitionEnv, DiscordPackage, runAcquisition } from "../src/discord-package.ts";
import { tempDir } from "./helpers.ts";

// Directory links: a junction on Windows needs no privilege; file links are skipped there.
const linkDir = (target: string, path: string) =>
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
const noFileLinks = process.platform === "win32";

function installed(folder: string, manifest: Record<string, unknown> = {}) {
	const pkg = join(folder, "node_modules", "@pasympa", "discord-mcp");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@pasympa/discord-mcp",
			version: "2.2.0",
			bin: { "discord-mcp": "dist/index.js" },
			...manifest,
		}),
	);
	writeFileSync(join(pkg, "dist/index.js"), "// synthetic server; never executed\n");
}

/** A published folder as a previous preparation left it, then changed by `damage`. */
function published(root: string, damage: (ready: string, pkg: string) => void = () => {}) {
	const ready = join(root, "discord-2.2.0");
	installed(ready);
	writeFileSync(join(ready, "ready.json"), "2.2.0\n");
	damage(ready, join(ready, "node_modules", "@pasympa", "discord-mcp"));
	return ready;
}

const packagesRoot = () => join(tempDir(), "connector-packages");

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

it("prepares when the data folder sits behind a linked ancestor (macOS /var, a Windows junction)", async () => {
	const real = tempDir();
	const linked = join(tempDir(), "linked-profile");
	linkDir(real, linked);
	const root = join(linked, "data", "connector-packages");
	const owner = new DiscordPackage(root, async (folder) => installed(folder));
	await owner.prepare(new AbortController().signal);
	expect(owner.command()?.command).toBe(process.execPath);
	expect(new DiscordPackage(root).command()).toEqual(owner.command());
});

it("still refuses a linked connector-packages folder", async () => {
	const parent = tempDir();
	const elsewhere = tempDir();
	const root = join(parent, "connector-packages");
	linkDir(elsewhere, root);
	let calls = 0;
	const owner = new DiscordPackage(root, async (folder) => {
		calls++;
		installed(folder);
	});
	await expect(owner.prepare(new AbortController().signal)).rejects.toThrow(
		"Unsafe Discord package directory",
	);
	expect(calls).toBe(0);
	expect(readdirSync(elsewhere)).toEqual([]);
});

it("prepares again over a published folder that no longer validates, instead of dead-ending", async () => {
	const root = packagesRoot();
	const ready = published(root, (_ready, pkg) => rmSync(join(pkg, "dist", "index.js")));
	writeFileSync(join(root, "unrelated"), "keep");
	let calls = 0;
	const owner = new DiscordPackage(root, async (folder) => {
		calls++;
		installed(folder);
	});
	expect(owner.command()).toBeUndefined();
	await owner.prepare(new AbortController().signal);
	expect(calls).toBe(1);
	expect(owner.command()?.args).toEqual([
		join(ready, "node_modules", "@pasympa", "discord-mcp", "dist", "index.js"),
	]);
	expect(readdirSync(root).sort()).toEqual(["discord-2.2.0", "unrelated"]);
});

it("sets a linked published folder aside without following it", async () => {
	const root = packagesRoot();
	mkdirSync(root, { recursive: true });
	const outside = tempDir();
	writeFileSync(join(outside, "keep"), "outside");
	linkDir(outside, join(root, "discord-2.2.0"));
	const owner = new DiscordPackage(root, async (folder) => installed(folder));
	await owner.prepare(new AbortController().signal);
	expect(owner.command()).toBeDefined();
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
});

it("keeps answering from what it validated until a preparation publishes", async () => {
	const root = packagesRoot();
	published(root);
	const owner = new DiscordPackage(root);
	const command = owner.command();
	expect(command).toBeDefined();
	// Proxy lookups do not walk the folder again while the entry is still there.
	unlinkSync(join(root, "discord-2.2.0", "ready.json"));
	expect(owner.command()).toEqual(command);
	expect(new DiscordPackage(root).command()).toBeUndefined();
	writeFileSync(join(root, "discord-2.2.0", "ready.json"), "2.2.0\n");
	renameSync(join(root, "discord-2.2.0"), join(root, "moved"));
	const fresh = new DiscordPackage(root, async (folder) => installed(folder));
	expect(fresh.command()).toBeUndefined();
	await fresh.prepare(new AbortController().signal);
	expect(fresh.command()).toEqual(command);
});

it("stops answering once the prepared folder is deleted, so it is prepared again", async () => {
	const root = packagesRoot();
	const ready = published(root);
	let calls = 0;
	const owner = new DiscordPackage(root, async (folder) => {
		calls++;
		installed(folder);
	});
	const command = owner.command();
	expect(command).toBeDefined();
	rmSync(ready, { recursive: true });
	expect(owner.command()).toBeUndefined();
	await owner.prepare(new AbortController().signal);
	expect(calls).toBe(1);
	expect(owner.command()).toEqual(command);
});

const rejections: [string, (ready: string, pkg: string) => void, boolean?][] = [
	["no ready.json", (ready) => unlinkSync(join(ready, "ready.json"))],
	["a ready.json for another version", (ready) => writeFileSync(join(ready, "ready.json"), "2.1.0\n")],
	["another version", (_r, pkg) => installed(join(pkg, "..", "..", ".."), { version: "2.1.0" })],
	["another package name", (_r, pkg) => installed(join(pkg, "..", "..", ".."), { name: "discord-mcp" })],
	["no manifest", (_r, pkg) => unlinkSync(join(pkg, "package.json"))],
	["no bin", (_r, pkg) => installed(join(pkg, "..", "..", ".."), { bin: {} })],
	[
		"an absolute bin",
		(_r, pkg) => installed(join(pkg, "..", "..", ".."), { bin: join(pkg, "dist", "index.js") }),
	],
	["a bin outside the package", (_r, pkg) => installed(join(pkg, "..", "..", ".."), { bin: "../escape.js" })],
	["a missing entry", (_r, pkg) => unlinkSync(join(pkg, "dist", "index.js"))],
	["an entry that is a folder", (_r, pkg) => installed(join(pkg, "..", "..", ".."), { bin: "dist" })],
	[
		"a linked package folder",
		(ready, pkg) => {
			renameSync(pkg, join(ready, "real-package"));
			linkDir(join(ready, "real-package"), pkg);
		},
	],
	[
		"a linked entry folder",
		(_r, pkg) => {
			renameSync(join(pkg, "dist"), join(pkg, "real-dist"));
			linkDir(join(pkg, "real-dist"), join(pkg, "dist"));
		},
	],
	[
		"a linked entry",
		(_r, pkg) => {
			renameSync(join(pkg, "dist", "index.js"), join(pkg, "dist", "real.js"));
			symlinkSync(join(pkg, "dist", "real.js"), join(pkg, "dist", "index.js"));
		},
		true,
	],
	[
		"a linked manifest",
		(_r, pkg) => {
			renameSync(join(pkg, "package.json"), join(pkg, "real.json"));
			symlinkSync(join(pkg, "real.json"), join(pkg, "package.json"));
		},
		true,
	],
];

for (const [name, damage, fileLink] of rejections)
	it.skipIf(fileLink && noFileLinks)(`does not run a published package with ${name}`, () => {
		const root = packagesRoot();
		published(root, damage);
		expect(new DiscordPackage(root).command()).toBeUndefined();
	});

it("accepts an entry whose name only starts with two dots", () => {
	const root = packagesRoot();
	published(root, (_r, pkg) => {
		mkdirSync(join(pkg, "..dist"));
		writeFileSync(join(pkg, "..dist", "index.js"), "// synthetic\n");
		installed(join(pkg, "..", "..", ".."), { bin: "..dist/index.js" });
	});
	expect(new DiscordPackage(root).command()?.args[0]).toMatch(/\.\.dist[\\/]index\.js$/);
});

it("refuses to publish an acquisition that does not validate", async () => {
	const root = packagesRoot();
	const owner = new DiscordPackage(root, async (folder) => installed(folder, { version: "2.1.0" }));
	await expect(owner.prepare(new AbortController().signal)).rejects.toThrow("Wrong Discord package version");
	expect(owner.command()).toBeUndefined();
	expect(readdirSync(root)).toEqual([]);
});

it("gives npm the proxy and CA settings it reads, and nothing else from the environment", () => {
	const env = acquisitionEnv(
		{
			PATH: "/usr/bin",
			HTTPS_PROXY: "http://proxy.example:8080",
			https_proxy: "http://lower.example:8080",
			HTTP_PROXY: "http://plain.example:8080",
			http_proxy: "http://plain-lower.example:8080",
			NO_PROXY: "localhost",
			no_proxy: ".internal",
			NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
			DISCORD_TOKEN: "synthetic-discord-token",
			ANTHROPIC_API_KEY: "synthetic-key",
			NODE_OPTIONS: "--require /tmp/x.js",
			npm_config_registry: "https://evil.example",
		},
		"/stage",
	);
	expect(env).toEqual({
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://proxy.example:8080",
		https_proxy: "http://lower.example:8080",
		HTTP_PROXY: "http://plain.example:8080",
		http_proxy: "http://plain-lower.example:8080",
		NO_PROXY: "localhost",
		no_proxy: ".internal",
		NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
		npm_config_userconfig: join("/stage", "empty.npmrc"),
		npm_config_globalconfig: join("/stage", "empty.npmrc"),
		npm_config_cache: join("/stage", "cache"),
	});
});

it("says why the installer failed without repeating proxy credentials", async () => {
	const folder = tempDir();
	const script =
		"process.stderr.write('npm error request to https://registry.npmjs.org failed via http://user:hunter2@proxy.example\\nnpm error code E404\\n'); process.exit(3)";
	const failure = runAcquisition(["-e", script], {
		cwd: folder,
		env: { PATH: process.env.PATH, HTTPS_PROXY: "http://user:hunter2@proxy.example" },
		signal: new AbortController().signal,
	});
	await expect(failure).rejects.toThrow(/exit code 3.*E404/s);
	await failure.catch((error: Error) => expect(error.message).not.toContain("hunter2"));
});

it("hides credentials in an address it was not given", async () => {
	const script =
		"process.stderr.write('npm error request failed via https://bob:s3cret@other-proxy.example:3128/x\\n'); process.exit(1)";
	const failure = runAcquisition(["-e", script], {
		cwd: tempDir(),
		env: { PATH: process.env.PATH },
		signal: new AbortController().signal,
	});
	await expect(failure).rejects.toThrow("https://[hidden]@other-proxy.example:3128/x");
	await failure.catch((error: Error) => expect(error.message).not.toMatch(/bob|s3cret/));
});

it("hides credentials whose address was cut where the kept output starts", async () => {
	// Kept output is the last 2400 characters; the cut lands inside the user name.
	const tail = `er:s3cret@proxy.example ${"\n".repeat(2400 - 24)}`;
	const script = `process.stderr.write('npm error via http://us' + ${JSON.stringify(tail)}); process.exit(1)`;
	const failure = runAcquisition(["-e", script], {
		cwd: tempDir(),
		env: { PATH: process.env.PATH },
		signal: new AbortController().signal,
	});
	await expect(failure).rejects.toThrow("exit code 1");
	await failure.catch((error: Error) => expect(error.message).not.toContain("s3cret"));
});
