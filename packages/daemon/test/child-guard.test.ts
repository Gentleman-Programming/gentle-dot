// Subagents behind the proxy (S25.4, T23f): the assistant's engine runs with subagents on, and its
// subagent child engines load the approval guard through a small file in the engine's own
// extensions folder, which they discover on their own. That file does nothing in the main engine
// (it loads the guard with `-e`) or in any engine Gentle Dot did not start, and the daemon writes it
// at every engine start and puts it back when it changes. The proxy and the native approvals stay
// the boundary; the guard in children is defense in depth.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_GUARD } from "../src/connectors.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { type ConnectorPolicy, POLICY_ENV, PROPOSE_TOOL } from "../src/extensions/approval-guard.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const SHIM = "gentle-dot-child-guard.ts";

const daemons: DotDaemon[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

async function start(options: { env?: NodeJS.ProcessEnv; before?: (agentHome: string) => void } = {}) {
	const scratch = tempDir();
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	options.before?.(agentHome);
	const envFile = join(scratch, "env.json");
	const lines: string[] = [];
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome,
		agentEnv: { PATH: process.env.PATH, HOME: scratch, ...options.env, FAKE_AGENT_ENV_FILE: envFile },
		log: (line) => lines.push(line),
	});
	daemons.push(d);
	const env = () => JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | undefined>;
	return { d, dataDir, agentHome, shim: join(agentHome, "extensions", SHIM), env, lines };
}

/** What an extension registered when the engine called it. */
function fakePi() {
	const tools: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		getAllTools: () => [],
	};
	return { pi, tools, handlers };
}

/** Loads the file the daemon wrote, as an engine would, and runs it with `env` as the engine's environment (read when it runs). */
async function runShim(shim: string, env: NodeJS.ProcessEnv) {
	const { default: extension } = (await import(shim)) as {
		default: (pi: unknown) => void;
	};
	for (const key of ["GENTLE_PI_AGENTS_CHILD", POLICY_ENV]) delete process.env[key];
	Object.assign(process.env, env);
	const fake = fakePi();
	extension(fake.pi);
	return fake;
}

describe("subagents in the assistant's engine (S25.4)", () => {
	it("starts the engine with subagents on and the child guard in its extensions folder", async () => {
		const { env, shim } = await start({ env: { GENTLE_PI_AGENTS: "0" } });
		expect(env().GENTLE_PI_AGENTS).toBe("1");
		// The guard comes from the daemon's own install, never from a path in the environment.
		expect(readFileSync(shim, "utf8")).toContain(`import guard from ${JSON.stringify(APPROVAL_GUARD)};`);
		expect(lstatSync(shim).mode & 0o777).toBe(0o600);
	});

	it("keeps subagents off with GENTLE_DOT_SUBAGENTS=off", async () => {
		const { env } = await start({ env: { GENTLE_DOT_SUBAGENTS: "off" } });
		expect(env().GENTLE_PI_AGENTS).toBe("0");
	});

	it("protects the child guard's file like the guard's own", async () => {
		const { env, shim } = await start();
		const policy = JSON.parse(env()[POLICY_ENV] ?? "{}") as ConnectorPolicy;
		expect(policy.protectedPaths).toContain(shim);
		expect(policy.protectedPaths).toContain(APPROVAL_GUARD);
	});

	it("is inert in the main engine and in engines Gentle Dot did not start; a child of the assistant's engine gets the guard", async () => {
		const { env, shim } = await start();
		const policy = env()[POLICY_ENV] ?? "";
		// The main engine already loads the guard with -e: no second copy.
		const main = await runShim(shim, { [POLICY_ENV]: policy });
		expect(main.tools).toEqual([]);
		expect(main.handlers.size).toBe(0);
		// A subagent of some other engine sharing this home (no policy from the daemon).
		const foreign = await runShim(shim, { GENTLE_PI_AGENTS_CHILD: "1" });
		expect(foreign.tools).toEqual([]);
		expect(foreign.handlers.size).toBe(0);

		const child = await runShim(shim, { GENTLE_PI_AGENTS_CHILD: "1", [POLICY_ENV]: policy });
		const toolCall = child.handlers.get("tool_call");
		expect(toolCall).toBeDefined();
		const mcpJson = JSON.parse(policy).protectedPaths[0] as string;
		expect(
			await toolCall?.({ toolName: "read", input: { path: mcpJson } }, { cwd: "/", hasUI: true }),
		).toMatchObject({
			block: true,
		});
		expect(
			await toolCall?.({ toolName: "bash", input: { command: `cat ${shim}` } }, { cwd: "/" }),
		).toMatchObject({
			block: true,
		});
		// A child's drafts could never reach the app (its status goes to the parent engine, not the
		// daemon), so it has no propose_connector at all.
		expect(child.tools).not.toContain(PROPOSE_TOOL.name);
	});

	it("puts the child guard back when it changes or disappears while running, and says so", async () => {
		const { shim, lines } = await start();
		const original = readFileSync(shim, "utf8");
		writeFileSync(shim, "export default function () {}\n");
		await waitFor(() => readFileSync(shim, "utf8") === original, 5000);
		rmSync(shim);
		await waitFor(() => existsSync(shim) && readFileSync(shim, "utf8") === original, 5000);
		expect(
			lines.filter((line) => line.includes("put back") && line.includes(shim)).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("replaces an extensions folder that became a link, never touching where it points", async () => {
		const { agentHome, shim } = await start();
		const original = readFileSync(shim, "utf8");
		const elsewhere = tempDir();
		writeFileSync(join(elsewhere, "keep.txt"), "mine\n");
		rmSync(join(agentHome, "extensions"), { recursive: true });
		symlinkSync(elsewhere, join(agentHome, "extensions"));
		await waitFor(() => !lstatSync(join(agentHome, "extensions")).isSymbolicLink(), 5000);
		await waitFor(() => existsSync(shim) && readFileSync(shim, "utf8") === original, 5000);
		expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("mine\n");
		expect(existsSync(join(elsewhere, SHIM))).toBe(false);
	});

	it("starts the engine with subagents off when the child guard cannot be put in place", async () => {
		const { env, lines } = await start({
			before: (agentHome) => {
				mkdirSync(agentHome, { recursive: true });
				writeFileSync(join(agentHome, "extensions"), "not a folder\n");
			},
		});
		expect(env().GENTLE_PI_AGENTS).toBe("0");
		expect(lines.some((line) => /subagents are off/i.test(line))).toBe(true);
	});
});
