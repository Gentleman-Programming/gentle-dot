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
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const VERSION = "2.2.0";
const PACKAGE = `@pasympa/discord-mcp@${VERSION}`;
const PREPARE_TIMEOUT_MS = 300_000;
/** What npm needs to run and to reach the registry through a corporate proxy; none of it is a secret. */
const INHERITED =
	/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|home|https?_proxy|no_proxy|node_extra_ca_certs)$/i;
const PROXY = /^https?_proxy$/i;
const MAX_REASON = 600;
export type Command = { command: string; args: string[] };
type Acquire = (directory: string, signal: AbortSignal) => Promise<void>;

/** Only the curated Discord package; this is not an installer for user-supplied commands. */
export class DiscordPackage {
	private readonly ready: string;
	private readonly root: string;
	private readonly acquire: Acquire;
	private active: Promise<void> | undefined;
	/**
	 * The proxy asks on every lookup; the folder is walked again only after a preparation, or when
	 * the entry it validated is gone (the folder was deleted while the daemon runs).
	 */
	private cached: { command: Command | undefined } | undefined;
	constructor(root: string, acquire: Acquire = acquireDiscord) {
		this.root = root;
		this.acquire = acquire;
		this.ready = join(root, `discord-${VERSION}`);
	}

	command(): Command | undefined {
		const entry = this.cached?.command?.args[0];
		if (entry && !existsSync(entry)) this.cached = undefined;
		this.cached ??= { command: this.validated() };
		return this.cached.command;
	}

	private validated(): Command | undefined {
		if (!existsSync(this.ready)) return undefined;
		try {
			assertDirectories(this.ready, this.root);
			if (readFileSync(join(this.ready, "ready.json"), "utf8") !== `${VERSION}\n`) return undefined;
			return validatedCommand(this.ready, this.root);
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
		this.cached = undefined;
		// Only this folder and what is below it are checked: the profile or data folder holding it may
		// sit behind a link (macOS /var, a redirected Windows profile, a Dev Drive junction).
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		assertDirectories(this.root, this.root);
		if (this.command()) return;
		const stagingName = () => join(this.root, `discord-stage-${process.pid}-${randomUUID()}`);
		// A published folder that no longer validates is set aside as staging and prepared again,
		// never repaired in place.
		if (lstatSync(this.ready, { throwIfNoEntry: false })) {
			const aside = stagingName();
			renameSync(this.ready, aside);
			this.cached = undefined;
			discard(aside, this.root);
		}
		for (const name of readdirSync(this.root)) {
			const match = /^discord-stage-(\d+)-[0-9a-f-]{36}$/.exec(name);
			if (!match) continue;
			try {
				process.kill(Number(match[1]), 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") discard(join(this.root, name), this.root);
			}
		}
		const staging = stagingName();
		mkdirSync(staging, { mode: 0o700 });
		try {
			await this.acquire(staging, signal);
			signal.throwIfAborted();
			validatedCommand(staging, this.root);
			if (existsSync(join(staging, "cache"))) removeStaging(join(staging, "cache"), this.root);
			writeFileSync(join(staging, "ready.json"), `${VERSION}\n`, { flag: "wx", mode: 0o600 });
			try {
				renameSync(staging, this.ready);
			} catch (error) {
				// A concurrent owner may have published the same validated version first.
				this.cached = undefined;
				if (!this.command()) throw error;
			}
		} finally {
			this.cached = undefined;
			// Cleanup that fails must not hide why the preparation failed; a later one retries it.
			if (existsSync(staging)) discard(staging, this.root);
		}
	}
}

/** Every folder from `path` up to `base` (the packages folder, included) is a real folder, not a link. */
function assertDirectories(path: string, base: string): void {
	const top = resolve(base);
	for (let current = resolve(path); ; current = dirname(current)) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Discord package directory");
		if (current === top) break;
		if (dirname(current) === current) throw new Error("Unsafe Discord package directory");
	}
}

function validatedCommand(directory: string, base: string): Command {
	const pkg = join(directory, "node_modules", "@pasympa", "discord-mcp");
	assertDirectories(pkg, base);
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
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Unconfined Discord entry point");
	assertDirectories(dirname(entry), base);
	// Compared below the real packages folder, which may itself be reached through a linked ancestor.
	if (
		!lstatSync(entry).isFile() ||
		lstatSync(entry).isSymbolicLink() ||
		relative(realpathSync(base), realpathSync(entry)) !== relative(base, entry)
	)
		throw new Error("Invalid Discord entry point");
	return { command: process.execPath, args: [entry] };
}

/** Removes staging, or a published folder set aside; a link is removed itself, never followed. */
function removeStaging(directory: string, base: string): void {
	if (lstatSync(directory).isSymbolicLink()) {
		unlinkSync(directory);
		return;
	}
	assertDirectories(directory, base);
	const inspect = (path: string) => {
		for (const child of readdirSync(path, { withFileTypes: true })) {
			if (child.isSymbolicLink()) throw new Error("Refusing linked Discord staging cleanup");
			if (child.isDirectory()) inspect(join(path, child.name));
		}
	};
	inspect(directory);
	rmSync(directory, { recursive: true });
}

function discard(directory: string, base: string): void {
	try {
		removeStaging(directory, base);
	} catch {
		// Left for a later preparation; it never blocks this one.
	}
}

function npmCli(): string {
	const adjacent = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(adjacent)) return adjacent;
	const windows = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(windows)) return windows;
	return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
}

/** The installer's environment: no connector values and no inherited provider credentials. */
export function acquisitionEnv(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) if (INHERITED.test(key)) env[key] = value;
	const empty = join(directory, "empty.npmrc");
	return {
		...env,
		npm_config_userconfig: empty,
		npm_config_globalconfig: empty,
		npm_config_cache: join(directory, "cache"),
	};
}

async function acquireDiscord(directory: string, signal: AbortSignal): Promise<void> {
	const env = acquisitionEnv(process.env, directory);
	writeFileSync(join(directory, "empty.npmrc"), "", { flag: "wx", mode: 0o600 });
	await runAcquisition(
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
		{ cwd: directory, env, signal },
	);
}

/**
 * Runs the installer with Node. When it fails, the error says how it ended and the end of what it
 * printed, without the proxy settings it was given (a proxy address may carry a password).
 */
export function runAcquisition(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number },
): Promise<void> {
	const { cwd, env, signal } = options;
	return new Promise<void>((done, fail) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env,
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let cut = false;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
			if (output.length <= 4 * MAX_REASON) return;
			output = output.slice(-4 * MAX_REASON);
			cut = true;
		});
		let interrupted = false;
		const stop = () => {
			interrupted = true;
			child.kill();
		};
		const timeout = setTimeout(stop, options.timeoutMs ?? PREPARE_TIMEOUT_MS);
		const settle = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", stop);
		};
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		child.once("error", (error) => {
			settle();
			fail(error);
		});
		child.once("close", (code, killed) => {
			settle();
			if (!interrupted && code === 0) return done();
			const ended = interrupted ? "stopped" : killed ? `signal ${killed}` : `exit code ${code}`;
			// What the cut left of its first word (maybe `user:pass@host` without its scheme) is dropped.
			const reason = redacted(cut ? output.replace(/^\S*/, "") : output, env);
			fail(new Error(`Discord package preparation did not finish (${ended})${reason ? `: ${reason}` : ""}`));
		});
	});
}

function redacted(output: string, env: NodeJS.ProcessEnv): string {
	let text = output;
	for (const [key, value] of Object.entries(env))
		if (PROXY.test(key) && value) text = text.split(value).join("[proxy]");
	return text
		.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1[hidden]@")
		.replace(/\s+/g, " ")
		.trim()
		.slice(-MAX_REASON);
}
