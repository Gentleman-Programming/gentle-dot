#!/usr/bin/env node
// Starts a staged runtime's daemon the way the installed app does, on a clean HOME:
// `node scripts/package/smoke-runtime.mjs --runtime <dir> [--read-only] [--timeout <seconds>]`.
// It waits until the engine finished its first-run setup (`/health` idle), stops what it
// started, and reports any file the run changed inside the runtime folder.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const RESERVED_PORTS = new Set([4317, 7437, 7438]);

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Path → size and modification time of every entry under `dir`, links not followed. */
function snapshot(dir, prefix = "", into = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		const stat = lstatSync(join(dir, entry.name));
		into.set(relative, `${stat.size}:${stat.mtimeMs}:${stat.mode}`);
		if (entry.isDirectory()) snapshot(join(dir, entry.name), relative, into);
	}
	return into;
}

function changes(before, after) {
	const changed = [];
	for (const [path, value] of after) if (before.get(path) !== value) changed.push(path);
	for (const path of before.keys()) if (!after.has(path)) changed.push(`${path} (removed)`);
	return changed;
}

function freePort() {
	return new Promise((done, fail) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => (RESERVED_PORTS.has(port) ? freePort().then(done, fail) : done(port)));
		});
	});
}

/** The PID listening on `port` and its command line, when `lsof` can tell. */
function listener(port) {
	try {
		const pid = execFileSync("lsof", ["-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], {
			encoding: "utf8",
			env: { PATH: SYSTEM_PATH },
		})
			.trim()
			.split("\n")[0];
		const command = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
		return { pid: Number(pid), command };
	} catch {
		return undefined;
	}
}

async function health(url) {
	try {
		const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
		return await response.json();
	} catch {
		return undefined;
	}
}

async function main() {
	const source = flag("--runtime");
	if (!source || !existsSync(join(source, "daemon", "cli.mjs")))
		throw new Error("usage: smoke-runtime --runtime <staged runtime dir> [--read-only] [--timeout <s>]");
	const timeoutMs = Number(flag("--timeout") ?? 240) * 1000;
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-smoke-"));
	let runtime = resolve(source);
	if (args.includes("--read-only")) {
		runtime = join(scratch, "runtime");
		cpSync(source, runtime, { recursive: true, verbatimSymlinks: true });
		execFileSync("chmod", ["-R", "a-w", runtime]);
	}
	const home = join(scratch, "home");
	const dataDir = join(scratch, "data");
	mkdirSync(home);
	const engramPort = await freePort();
	say(`scratch ${scratch}`);
	say(`runtime ${runtime}${args.includes("--read-only") ? " (read-only copy)" : ""}`);
	say(`private Engram port ${engramPort}`);

	const before = snapshot(runtime);
	const logFile = join(scratch, "daemon.log");
	const log = openSync(logFile, "a");
	const started = Date.now();
	// The app's bundled launch (apps/desktop daemon.rs), with nothing else from this shell.
	const daemon = spawn(join(runtime, "node", "bin", "node"), [join(runtime, "daemon", "cli.mjs")], {
		env: {
			HOME: home,
			PATH: `${join(runtime, "bin")}:${join(runtime, "node", "bin")}:${SYSTEM_PATH}`,
			GENTLE_DOT_RUNTIME: runtime,
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_PORT: "0",
			GENTLE_DOT_ENGRAM: "private",
			GENTLE_DOT_ENGRAM_PORT: String(engramPort),
		},
		stdio: ["ignore", "pipe", log],
	});
	say(`daemon pid ${daemon.pid}, log ${logFile}`);
	let url;
	daemon.stdout.on("data", (chunk) => {
		url ??= /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk))?.[1];
	});
	let exited = false;
	daemon.on("exit", () => {
		exited = true;
	});

	let state;
	while (Date.now() - started < timeoutMs && !exited) {
		if (url) state = (await health(url))?.agentState;
		if (state === "idle" || state === "error") break;
		await sleep(1000);
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	say(`daemon ${url ?? "(no URL)"}: agentState ${state ?? "unknown"} after ${seconds} s`);
	const engram = listener(engramPort);
	say(`engram on ${engramPort}: ${engram ? `pid ${engram.pid} ${engram.command}` : "not listening"}`);
	const firstRun = join(dataDir, "agent", "npm", "node_modules");
	const installed = existsSync(firstRun) ? readdirSync(firstRun) : [];
	const companions = installed.filter((name) => /^(gentle-|pi-)/.test(name));
	say(`first-run npm install: ${installed.length} entries (${companions.join(", ") || "no companions"})`);
	const engineTmp = join(dataDir, "home", ".cache", "tmp");
	say(
		`engine TMPDIR ${engineTmp}: ${existsSync(engineTmp) ? readdirSync(engineTmp).join(", ") || "empty" : "missing"}`,
	);

	if (!exited) {
		daemon.kill("SIGTERM");
		for (let i = 0; i < 100 && !exited; i++) await sleep(100);
	}
	say(`daemon stopped: ${exited}`);
	const left = listener(engramPort);
	say(`engram on ${engramPort} after stop: ${left ? `still pid ${left.pid}` : "stopped"}`);

	const changed = changes(before, snapshot(runtime));
	say(`runtime files changed by the run: ${changed.length}`);
	for (const path of changed.slice(0, 20)) say(`  ${path}`);
	const ok = state === "idle" && exited && !left && changed.length === 0;
	say(ok ? "smoke: ok" : "smoke: FAILED");
	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`smoke-runtime: ${error.message}\n`);
	process.exit(1);
});
