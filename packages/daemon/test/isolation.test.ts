import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import {
	ensureMemoryProject,
	isolatedAgentEnv,
	MEMORY_PROJECT,
	PRIVATE_ENGRAM_PORT,
} from "../src/isolation.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

describe("isolatedAgentEnv PATH", () => {
	it("puts the bundled `pi` first so the engine's first-run setup works on a clean machine", () => {
		const env = isolatedAgentEnv({ PATH: "/usr/bin:/bin", HOME: tempDir() }, tempDir());
		const [first, ...rest] = (env.PATH ?? "").split(":");
		expect(first).toMatch(/node_modules\/\.bin$/);
		expect(existsSync(join(first ?? "", "pi"))).toBe(true);
		expect(rest).toEqual(["/usr/bin", "/bin"]);
	});

	it("does not add the bundled folder twice", () => {
		const once = isolatedAgentEnv({ PATH: "/bin", HOME: tempDir() }, tempDir());
		const twice = isolatedAgentEnv({ PATH: once.PATH, HOME: tempDir() }, tempDir());
		expect(twice.PATH).toBe(once.PATH);
	});
});

describe("isolatedAgentEnv memory", () => {
	it("points the engine's memory at the user's global Engram data and server", () => {
		const realHome = tempDir();
		const env = isolatedAgentEnv({ PATH: "/bin", HOME: realHome }, tempDir());
		expect(env.ENGRAM_DATA_DIR).toBe(join(realHome, ".engram"));
		// The default server (7437) unless the user configured another one.
		expect(env.ENGRAM_PORT).toBeUndefined();
		expect(env.ENGRAM_URL).toBeUndefined();
	});

	it("keeps the user's own Engram settings and honors GENTLE_DOT_ENGRAM_DATA_DIR", () => {
		const realHome = tempDir();
		const base = {
			HOME: realHome,
			ENGRAM_DATA_DIR: "/srv/engram",
			ENGRAM_PORT: "7500",
			ENGRAM_URL: "http://127.0.0.1:7500",
		};
		expect(isolatedAgentEnv(base, tempDir())).toMatchObject({
			ENGRAM_DATA_DIR: "/srv/engram",
			ENGRAM_PORT: "7500",
			ENGRAM_URL: "http://127.0.0.1:7500",
		});
		const env = isolatedAgentEnv({ ...base, GENTLE_DOT_ENGRAM_DATA_DIR: "/data/engram" }, tempDir());
		expect(env.ENGRAM_DATA_DIR).toBe("/data/engram");
	});

	it("runs a private memory on its own port with GENTLE_DOT_ENGRAM=private", () => {
		const dataDir = tempDir();
		const base = {
			HOME: tempDir(),
			GENTLE_DOT_ENGRAM: "private",
			ENGRAM_DATA_DIR: "/srv/engram",
			ENGRAM_URL: "http://127.0.0.1:7437",
			ENGRAM_PORT: "7437",
		};
		const env = isolatedAgentEnv(base, dataDir);
		expect(env.ENGRAM_PORT).toBe(PRIVATE_ENGRAM_PORT);
		expect(PRIVATE_ENGRAM_PORT).toBe("7438");
		// Engram then keeps its data under the engine's own home.
		expect(env.ENGRAM_DATA_DIR).toBeUndefined();
		expect(env.ENGRAM_URL).toBeUndefined();
		expect(isolatedAgentEnv({ ...base, GENTLE_DOT_ENGRAM_PORT: "17438" }, dataDir).ENGRAM_PORT).toBe("17438");
	});
});

describe("isolatedAgentEnv subagents", () => {
	it("turns the engine's subagents off until S25, whatever the user's environment says", () => {
		expect(isolatedAgentEnv({ HOME: tempDir() }, tempDir()).GENTLE_PI_AGENTS).toBe("0");
		expect(isolatedAgentEnv({ HOME: tempDir(), GENTLE_PI_AGENTS: "1" }, tempDir()).GENTLE_PI_AGENTS).toBe(
			"0",
		);
	});
});

describe("ensureMemoryProject", () => {
	it("names the workspace's memory project gentle-dot, replacing any other name", () => {
		const workspace = tempDir();
		const file = join(workspace, ".engram", "config.json");
		ensureMemoryProject(workspace);
		expect(MEMORY_PROJECT).toBe("gentle-dot");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ project_name: "gentle-dot" });
		writeFileSync(file, '{ "project_name": "other" }');
		ensureMemoryProject(workspace);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ project_name: "gentle-dot" });
	});
});

describe("engine memory and folders", () => {
	async function start(options: { preferredFolder?: string; env?: NodeJS.ProcessEnv } = {}) {
		const scratch = tempDir();
		const dataDir = tempDir();
		const realHome = join(scratch, "user");
		mkdirSync(realHome);
		const files = {
			env: join(scratch, "env.json"),
			args: join(scratch, "argv.json"),
			cwd: join(scratch, "cwd.txt"),
		};
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: join(dataDir, "workspace"),
			...(options.preferredFolder ? { preferredFolder: options.preferredFolder } : {}),
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			agentHome: join(dataDir, "agent"),
			agentEnv: {
				PATH: process.env.PATH,
				HOME: realHome,
				...options.env,
				FAKE_AGENT_ENV_FILE: files.env,
				FAKE_AGENT_ARGS_FILE: files.args,
				FAKE_AGENT_CWD_FILE: files.cwd,
			},
		});
		daemons.push(d);
		return {
			dataDir,
			realHome,
			env: JSON.parse(readFileSync(files.env, "utf8")) as Record<string, string | undefined>,
			argv: JSON.parse(readFileSync(files.args, "utf8")) as string[],
			cwd: readFileSync(files.cwd, "utf8"),
		};
	}

	it("uses the global Engram and the gentle-dot project from the assistant's own workspace", async () => {
		const { dataDir, realHome, env, argv, cwd } = await start();
		const workspace = join(dataDir, "workspace");
		expect(env.ENGRAM_DATA_DIR).toBe(join(realHome, ".engram"));
		expect(env.ENGRAM_PORT).toBeUndefined();
		expect(env.HOME).toBe(join(dataDir, "home"));
		expect(cwd).toBe(realpathSync(workspace));
		expect(JSON.parse(readFileSync(join(workspace, ".engram", "config.json"), "utf8"))).toEqual({
			project_name: "gentle-dot",
		});
		expect(argv.join("\n")).not.toContain("preferred working folder");
		// Nothing is written to the user's Engram data by the daemon itself.
		expect(existsSync(join(realHome, ".engram"))).toBe(false);
	});

	it("keeps the private memory opt-out", async () => {
		const { env } = await start({ env: { GENTLE_DOT_ENGRAM: "private" } });
		expect(env.ENGRAM_PORT).toBe("7438");
		expect(env.ENGRAM_DATA_DIR).toBeUndefined();
	});

	it("tells the engine about a custom folder without working or writing in it", async () => {
		const folder = tempDir();
		const { dataDir, argv, cwd } = await start({ preferredFolder: folder });
		expect(cwd).toBe(realpathSync(join(dataDir, "workspace")));
		const prompts = argv.flatMap((arg, i) => (argv[i - 1] === "--append-system-prompt" ? [arg] : []));
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toBe(
			`The user's preferred working folder is ${folder}. Use absolute paths there unless told otherwise.`,
		);
		expect(readdirSync(folder)).toEqual([]);
	});
});
