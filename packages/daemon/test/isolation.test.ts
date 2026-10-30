import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import {
	ensureGitBoundary,
	ensureMemoryProject,
	isolatedAgentEnv,
	MEMORY_PROJECT,
	PRIVATE_ENGRAM_PORT,
} from "../src/isolation.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";
import { expectPosixMode } from "./support/windows.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

describe("Windows isolation", () => {
	it("isolates the OS home and Windows temp while preserving the real memory folder", () => {
		const realHome = tempDir();
		const data = tempDir();
		const env = isolatedAgentEnv(
			{ USERPROFILE: realHome, TEMP: "/user/temp", TMP: "/user/tmp" },
			data,
			undefined,
			{
				platform: "win32",
			},
		);
		expect(env.HOME).toBe(join(data, "home"));
		expect(env.USERPROFILE).toBe(env.HOME);
		expect(env.TEMP).toBe(join(data, "home", ".cache", "tmp"));
		expect(env.TMP).toBe(env.TEMP);
		expect(env.ENGRAM_DATA_DIR).toBe(join(realHome, ".engram"));
	});

	it("gives the engine its own AppData on Windows, as XDG on Unix, and leaves Unix AppData alone", () => {
		const data = tempDir();
		const user = {
			USERPROFILE: tempDir(),
			APPDATA: "C:\\Users\\me\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
		};
		const env = isolatedAgentEnv(user, data, undefined, { platform: "win32" });
		expect(env.APPDATA).toBe(join(data, "home", "AppData", "Roaming"));
		expect(env.LOCALAPPDATA).toBe(join(data, "home", "AppData", "Local"));
		expect(existsSync(env.APPDATA as string)).toBe(true);
		expect(existsSync(env.LOCALAPPDATA as string)).toBe(true);
		const unix = isolatedAgentEnv({ ...user, HOME: tempDir() }, tempDir(), undefined, { platform: "linux" });
		expect(unix.APPDATA).toBe(user.APPDATA);
		expect(unix.LOCALAPPDATA).toBe(user.LOCALAPPDATA);
	});

	it("recognizes a source pi.cmd without a POSIX shim", () => {
		const bin = tempDir();
		writeFileSync(join(bin, "pi.cmd"), "@echo off\r\n");
		const env = isolatedAgentEnv({ HOME: tempDir(), PATH: "/tools" }, tempDir(), undefined, {
			platform: "win32",
			sourceBinDirs: [bin],
		});
		expect(env.PATH).toBe(`${bin};/tools`);
	});

	it("keeps Unix USERPROFILE and TEMP overrides unchanged", () => {
		const env = isolatedAgentEnv(
			{ HOME: tempDir(), USERPROFILE: "/user", TEMP: "/tmp/user", TMP: "/tmp/other" },
			tempDir(),
			undefined,
			{ platform: "linux" },
		);
		expect(env.USERPROFILE).toBe("/user");
		expect(env.TEMP).toBe("/tmp/user");
		expect(env.TMP).toBe("/tmp/other");
	});
});

describe("isolatedAgentEnv PATH", () => {
	it("puts the bundled `pi` first so the engine's first-run setup works on a clean machine", () => {
		const env = isolatedAgentEnv({ PATH: ["/usr/bin", "/bin"].join(delimiter), HOME: tempDir() }, tempDir());
		const [first, ...rest] = (env.PATH ?? "").split(delimiter);
		expect(first?.endsWith(join("node_modules", ".bin"))).toBe(true);
		const shims = process.platform === "win32" ? ["pi", "pi.cmd", "pi.exe"] : ["pi"];
		expect(shims.some((name) => existsSync(join(first ?? "", name)))).toBe(true);
		expect(rest).toEqual(["/usr/bin", "/bin"]);
	});

	it("keeps the user's Windows Path, under one spelling, after the bundled folder (Row0902's finding)", () => {
		// A copy of Windows' environment keeps the key as Windows spells it, `Path`. Reading `PATH`
		// found nothing, and a second `PATH` key beside it won: the engine had only the bundled folder.
		const bin = tempDir();
		writeFileSync(join(bin, "pi.cmd"), "");
		const env = isolatedAgentEnv(
			{ Path: "C:\\Windows\\System32;C:\\Git\\cmd", HOME: tempDir() },
			tempDir(),
			undefined,
			{
				platform: "win32",
				sourceBinDirs: [bin],
			},
		);
		expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
		expect(env.PATH).toBe([bin, "C:\\Windows\\System32", "C:\\Git\\cmd"].join(";"));
	});

	it("does not add the bundled folder twice on Windows, whatever its case or trailing separator", () => {
		const bin = tempDir();
		writeFileSync(join(bin, "pi.cmd"), "");
		const env = isolatedAgentEnv(
			{ Path: `C:\\Windows\\System32;${bin.toUpperCase()}\\;${bin}/`, HOME: tempDir() },
			tempDir(),
			undefined,
			{ platform: "win32", sourceBinDirs: [bin] },
		);
		expect(env.PATH).toBe([bin, "C:\\Windows\\System32"].join(";"));
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
	it("turns the engine's subagents on, whatever the user's own Gentle Shell setting says (S25.4)", () => {
		expect(isolatedAgentEnv({ HOME: tempDir() }, tempDir()).GENTLE_PI_AGENTS).toBe("1");
		expect(isolatedAgentEnv({ HOME: tempDir(), GENTLE_PI_AGENTS: "0" }, tempDir()).GENTLE_PI_AGENTS).toBe(
			"1",
		);
	});

	it("keeps them off with GENTLE_DOT_SUBAGENTS=off (or 0, false)", () => {
		for (const value of ["off", "0", "false", " OFF "])
			expect(
				isolatedAgentEnv({ HOME: tempDir(), GENTLE_DOT_SUBAGENTS: value }, tempDir()).GENTLE_PI_AGENTS,
			).toBe("0");
		expect(
			isolatedAgentEnv({ HOME: tempDir(), GENTLE_DOT_SUBAGENTS: "on" }, tempDir()).GENTLE_PI_AGENTS,
		).toBe("1");
	});

	it("never passes on a parent run's subagent markers or a command line for its children", () => {
		const env = isolatedAgentEnv(
			{
				HOME: tempDir(),
				GENTLE_PI_AGENTS_CHILD: "1",
				GENTLE_PI_AGENTS_OWNED_IPC: "1-abc",
				GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3",
				GENTLE_PI_AGENTS_PI: "/bin/sh -c other",
			},
			tempDir(),
		);
		for (const key of [
			"GENTLE_PI_AGENTS_CHILD",
			"GENTLE_PI_AGENTS_OWNED_IPC",
			"GENTLE_PI_AGENTS_PARENT_PERMISSION_FD",
			"GENTLE_PI_AGENTS_PI",
		])
			expect(env[key]).toBeUndefined();
	});
});

describe("isolatedAgentEnv secrets key", () => {
	it("never passes the server's secrets key to the engine, and keeps everything else (S25.8)", () => {
		const env = isolatedAgentEnv(
			{ HOME: tempDir(), GENTLE_DOT_SECRETS_KEY: "server-only-key", OPENAI_API_KEY: "sk-model", LANG: "C" },
			tempDir(),
		);
		expect(env).not.toHaveProperty("GENTLE_DOT_SECRETS_KEY");
		// The model keys and the rest of the environment are the engine's, as before.
		expect(env.OPENAI_API_KEY).toBe("sk-model");
		expect(env.LANG).toBe("C");
	});
});

describe("isolatedAgentEnv temporary folder", () => {
	it("gives the engine a private TMPDIR when none is set, so its caches never land in a shared /tmp", () => {
		const dataDir = tempDir();
		const env = isolatedAgentEnv({ HOME: tempDir() }, dataDir);
		expect(env.TMPDIR).toBe(join(dataDir, "home", ".cache", "tmp"));
		expectPosixMode(statSync(env.TMPDIR ?? "").mode, 0o700);
	});

	it("keeps the Unix user's own TMPDIR (Windows always isolates TEMP/TMP)", () => {
		expect(
			isolatedAgentEnv({ HOME: tempDir(), TMPDIR: "/var/tmp/me" }, tempDir(), undefined, {
				platform: "linux",
			}).TMPDIR,
		).toBe("/var/tmp/me");
	});
});

describe("ensureGitBoundary", () => {
	it("creates a git repo in the workspace so git never resolves upward to the user's HOME (#51)", () => {
		// The workspace sits inside a parent that is itself a git repo, like a HOME dotfiles repo.
		const outer = tempDir();
		spawnGit(outer, ["init", "-q"]);
		const workspace = join(outer, ".gentle-dot", "workspace");
		mkdirSync(workspace, { recursive: true });
		ensureGitBoundary(workspace);
		// git rev-parse from the workspace now stops at the workspace, not at the parent repo.
		const top = gitOut(["rev-parse", "--show-toplevel"], workspace);
		expect(realpathSync(top)).toBe(realpathSync(workspace));
	});

	it("leaves an existing workspace repo as it is", () => {
		const workspace = tempDir();
		spawnGit(workspace, ["init", "-q"]);
		writeFileSync(join(workspace, ".git", "sentinel"), "keep me");
		ensureGitBoundary(workspace);
		expect(readFileSync(join(workspace, ".git", "sentinel"), "utf8")).toBe("keep me");
	});

	it("writes a minimal .git when no git binary is available", () => {
		const outer = tempDir();
		spawnGit(outer, ["init", "-q"]);
		const workspace = join(outer, "workspace");
		mkdirSync(workspace, { recursive: true });
		ensureGitBoundary(workspace, undefined, () => {
			throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
		});
		expect(readFileSync(join(workspace, ".git", "HEAD"), "utf8")).toContain("refs/heads/");
		const top = gitOut(["rev-parse", "--show-toplevel"], workspace);
		expect(realpathSync(top)).toBe(realpathSync(workspace));
	});
});

function spawnGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function gitOut(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git failed: ${result.stderr}`);
	return String(result.stdout).trim();
}

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
