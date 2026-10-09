#!/usr/bin/env node
// Launches an installed Gentle Dot binary under Xvfb on a clean HOME, as a desktop session would,
// and waits until the daemon the app spawned reports idle on a free port:
// `node scripts/package/linux-app-smoke.mjs --binary /usr/bin/gentle-dot [--runtime <dir>] [--timeout <s>]`.
// Runs inside a Linux container (docker/linux-package/check-package.sh); needs xvfb-run and lsof.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const RESERVED_PORTS = new Set([4317, 7437, 7438]);

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
	return new Promise((done, fail) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => (RESERVED_PORTS.has(port) ? freePort().then(done, fail) : done(port)));
		});
	});
}

/** The command line of the process listening on `port`, when `lsof` can tell. */
function listener(port) {
	try {
		const pid = execFileSync("lsof", ["-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], {
			encoding: "utf8",
			env: { PATH: SYSTEM_PATH },
		})
			.trim()
			.split("\n")[0];
		return execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

async function health(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
		return await response.json();
	} catch {
		return undefined;
	}
}

async function main() {
	const binary = flag("--binary");
	if (!binary || !existsSync(binary))
		throw new Error(
			"usage: linux-app-smoke --binary <installed gentle-dot> [--runtime <dir>] [--timeout <s>]",
		);
	const runtime = flag("--runtime");
	const timeoutMs = Number(flag("--timeout") ?? 240) * 1000;
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-app-smoke-"));
	const home = join(scratch, "home");
	const dataDir = join(scratch, "data");
	const runDir = join(scratch, "run");
	mkdirSync(home);
	mkdirSync(runDir, { mode: 0o700 });
	const port = await freePort();
	const engramPort = await freePort();
	say(`scratch ${scratch}`);
	say(`app port ${port}, private Engram port ${engramPort}`);

	const logFile = join(scratch, "app.log");
	const log = openSync(logFile, "a");
	const started = Date.now();
	// A new process group, so stopping it stops Xvfb, the app, and the daemon the app spawned.
	const app = spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x800x24", binary], {
		detached: true,
		env: {
			HOME: home,
			PATH: SYSTEM_PATH,
			XDG_RUNTIME_DIR: runDir,
			GENTLE_DOT_PORT: String(port),
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_ENGRAM: "private",
			GENTLE_DOT_ENGRAM_PORT: String(engramPort),
		},
		stdio: ["ignore", log, log],
	});
	let exited = false;
	app.on("exit", () => {
		exited = true;
	});
	say(`xvfb-run pid ${app.pid}, log ${logFile}`);

	let state;
	while (Date.now() - started < timeoutMs && !exited) {
		state = (await health(port))?.agentState;
		if (state === "idle" || state === "error") break;
		await sleep(1000);
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	say(
		`app ${exited ? "exited early" : "running"}; /health on ${port}: agentState ${state ?? "unknown"} after ${seconds} s`,
	);
	const daemon = listener(port);
	say(`daemon: ${daemon ?? "not listening"}`);
	const fromRuntime = runtime ? daemon?.includes(join(runtime, "daemon", "cli.mjs")) === true : true;
	if (runtime) say(`daemon launched from the packaged runtime: ${fromRuntime}`);
	const engram = listener(engramPort);
	say(`engram on ${engramPort}: ${engram ?? "not listening"}`);

	if (!exited) {
		process.kill(-app.pid, "SIGTERM");
		for (let i = 0; i < 100 && !exited; i++) await sleep(100);
	}
	await sleep(1000);
	const daemonLeft = listener(port);
	const engramLeft = listener(engramPort);
	say(
		`after stop: daemon ${daemonLeft ? "still listening" : "stopped"}, engram ${engramLeft ? "still listening" : "stopped"}`,
	);
	const daemonLog = join(dataDir, "daemon.log");
	if (existsSync(daemonLog)) {
		const lines = readFileSync(daemonLog, "utf8").trim().split("\n");
		say(`daemon.log: ${lines.length} lines, last: ${lines.at(-1)}`);
	}
	const appLines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
	say(`app output: ${appLines.length} lines`);
	for (const line of appLines.slice(-8)) say(`  ${line}`);

	const ok = state === "idle" && fromRuntime && !daemonLeft && !engramLeft;
	say(ok ? "app smoke: ok" : "app smoke: FAILED");
	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`linux-app-smoke: ${error.message}\n`);
	process.exit(1);
});
