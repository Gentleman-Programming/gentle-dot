import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const VERSION = "2.2.0";
const PACKAGE = `@pasympa/discord-mcp@${VERSION}`;
const PREPARE_TIMEOUT_MS = 300_000;
type Command = { command: string; args: string[] };
type Acquire = (directory: string, signal: AbortSignal) => Promise<void>;

/** Only the curated Discord package; this is not an installer for user-supplied commands. */
export class DiscordPackage {
	private readonly ready: string;
	private readonly root: string;
	private readonly acquire: Acquire;
	private active: Promise<void> | undefined;
	constructor(root: string, acquire: Acquire = acquireDiscord) {
		this.root = root;
		this.acquire = acquire;
		this.ready = join(root, `discord-${VERSION}`);
	}

	command(): Command | undefined {
		if (!existsSync(this.ready)) return undefined;
		try {
			assertDirectories(this.ready);
			if (readFileSync(join(this.ready, "ready.json"), "utf8") !== `${VERSION}\n`) return undefined;
			return validatedCommand(this.ready);
		} catch {
			return undefined;
		}
	}

	prepare(signal: AbortSignal): Promise<void> {
		if (this.active) return Promise.reject(new Error("Discord preparation is already running"));
		const operation = this.install(signal);
		this.active = operation;
		void operation
			.finally(() => {
				if (this.active === operation) this.active = undefined;
			})
			.catch(() => {});
		return operation;
	}

	private async install(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let ancestor = resolve(this.root);
		while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
		assertDirectories(ancestor);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		assertDirectories(this.root);
		if (this.command()) return;
		// An existing published path is not disposable staging: never overwrite it.
		if (existsSync(this.ready)) throw new Error("The prepared Discord package needs repair");
		for (const name of readdirSync(this.root)) {
			const match = /^discord-stage-(\d+)-[0-9a-f-]{36}$/.exec(name);
			if (!match) continue;
			try {
				process.kill(Number(match[1]), 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") removeStaging(join(this.root, name));
			}
		}
		const staging = join(this.root, `discord-stage-${process.pid}-${randomUUID()}`);
		mkdirSync(staging, { mode: 0o700 });
		try {
			await this.acquire(staging, signal);
			signal.throwIfAborted();
			validatedCommand(staging);
			if (existsSync(join(staging, "cache"))) removeStaging(join(staging, "cache"));
			writeFileSync(join(staging, "ready.json"), `${VERSION}\n`, { flag: "wx", mode: 0o600 });
			try {
				renameSync(staging, this.ready);
			} catch (error) {
				// A concurrent owner may have published the same validated version first.
				if (!this.command()) throw error;
			}
		} finally {
			if (existsSync(staging)) removeStaging(staging);
		}
	}
}

function assertDirectories(path: string): void {
	for (let current = resolve(path); ; current = dirname(current)) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Discord package directory");
		if (dirname(current) === current) break;
	}
}

function validatedCommand(directory: string): Command {
	const pkg = join(directory, "node_modules", "@pasympa", "discord-mcp");
	assertDirectories(pkg);
	const manifest = join(pkg, "package.json");
	if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink())
		throw new Error("Invalid Discord package manifest");
	const data = JSON.parse(readFileSync(manifest, "utf8"));
	if (data.name !== "@pasympa/discord-mcp" || data.version !== VERSION)
		throw new Error("Wrong Discord package version");
	const bin = typeof data.bin === "string" ? data.bin : data.bin?.["discord-mcp"];
	if (typeof bin !== "string" || isAbsolute(bin)) throw new Error("Invalid Discord entry point");
	const entry = resolve(pkg, bin);
	const rel = relative(pkg, entry);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unconfined Discord entry point");
	assertDirectories(dirname(entry));
	if (!lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink() || realpathSync(entry) !== entry)
		throw new Error("Invalid Discord entry point");
	return { command: process.execPath, args: [entry] };
}

function removeStaging(directory: string): void {
	assertDirectories(directory);
	const inspect = (path: string) => {
		for (const child of readdirSync(path, { withFileTypes: true })) {
			if (child.isSymbolicLink()) throw new Error("Refusing linked Discord staging cleanup");
			if (child.isDirectory()) inspect(join(path, child.name));
		}
	};
	inspect(directory);
	rmSync(directory, { recursive: true });
}

function npmCli(): string {
	const adjacent = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(adjacent)) return adjacent;
	const windows = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(windows)) return windows;
	return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
}

/** Acquisition gets no connector values and no inherited provider credentials. */
async function acquireDiscord(directory: string, signal: AbortSignal): Promise<void> {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|home)$/i.test(key)
		)
			env[key] = value;
	}
	const userconfig = join(directory, "empty.npmrc");
	Object.assign(env, {
		npm_config_userconfig: userconfig,
		npm_config_cache: join(directory, "cache"),
	});
	writeFileSync(userconfig, "", { flag: "wx", mode: 0o600 });
	await new Promise<void>((done, fail) => {
		const child = spawn(
			process.execPath,
			[
				npmCli(),
				"install",
				"--prefix",
				directory,
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
				"--bin-links=false",
				"--registry=https://registry.npmjs.org",
				PACKAGE,
			],
			{ cwd: directory, env, stdio: "ignore", windowsHide: true },
		);
		let interrupted = false;
		const stop = () => {
			interrupted = true;
			child.kill();
		};
		const timeout = setTimeout(stop, PREPARE_TIMEOUT_MS);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		child.once("error", (error) => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", stop);
			fail(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", stop);
			if (interrupted || code !== 0) fail(new Error("Discord package preparation did not finish"));
			else done();
		});
	});
}
