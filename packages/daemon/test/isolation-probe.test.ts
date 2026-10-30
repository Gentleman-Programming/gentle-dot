// @real-agent isolation probe: starts the daemon with the bundled engine for the
// first time under a seeded temporary HOME and checks that HOME is byte-identical
// afterwards, and that the engine's memory uses the user's global Engram in the
// project gentle-dot. The "global" Engram is a stand-in on a free port with a
// temporary data folder, which the engine's memory plugin starts itself, so the
// user's real one is never used. Opt-in (it installs the engine's companion
// packages and needs internet access; it needs `engram` and `lsof` on PATH):
//   GENTLE_DOT_ISOLATION_PROBE=1 npx vitest run packages/daemon/test/isolation-probe.test.ts
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const enabled = process.env.GENTLE_DOT_ISOLATION_PROBE === "1";

/** One hash over every path, type, mode, and file content under `root` (symlinks are not followed). */
function hashTree(root: string): string {
	const hash = createHash("sha256");
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			hash.update(`${relative(root, path)}\0${stat.mode}\0`);
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile()) hash.update(readFileSync(path));
		}
	};
	walk(root);
	return hash.digest("hex");
}

function seed(home: string): void {
	const files: Record<string, string> = {
		".gentle-shell/config.json": "{}\n",
		".pi/agent/settings.json": '{ "theme": "dark" }\n',
		".pi/gentle-ai/models.json": '{ "gentle-ai-worker": { "model": "seed/model" } }\n',
		".gentle-ai/state.json": '{ "seed": true }\n',
		".gitconfig": "[user]\n\tname = Seed User\n\temail = seed@example.com\n",
		".config/seed.txt": "xdg config\n",
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(home, path, ".."), { recursive: true });
		writeFileSync(join(home, path), text);
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
	return (await response.json()) as T;
}

function collect(child: ChildProcess): () => string {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return () => output;
}

/** The PID listening on `port`, if any. */
function listener(port: string): number | undefined {
	try {
		const pid = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])
			.toString()
			.trim();
		return /^\d+$/.test(pid) ? Number(pid) : undefined;
	} catch {
		return undefined;
	}
}

describe.skipIf(!enabled)("@real-agent isolation probe", () => {
	it("leaves HOME untouched and keeps memory in the global Engram, project gentle-dot", {
		timeout: 300_000,
	}, async () => {
		const home = tempDir();
		const dataDir = join(tempDir(), "data");
		// The stand-in for the user's global Engram: a temporary data folder and a free port.
		const globalData = join(tempDir(), "engram");
		const engramPort = String(await freePort());
		const engramUrl = `http://127.0.0.1:${engramPort}`;
		const globalId = execFileSync("engram", ["instance-id"], {
			env: { PATH: process.env.PATH, HOME: tempDir(), ENGRAM_DATA_DIR: globalData },
		})
			.toString()
			.trim();
		seed(home);
		const before = hashTree(home);
		const child = spawn(process.execPath, [CLI], {
			env: {
				PATH: process.env.PATH,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				XDG_DATA_HOME: join(home, ".local", "share"),
				XDG_CACHE_HOME: join(home, ".cache"),
				XDG_STATE_HOME: join(home, ".local", "state"),
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_ENGRAM_DATA_DIR: globalData,
				ENGRAM_PORT: engramPort,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output = collect(child);
		const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
		let memory: { instance_id?: string } | undefined;
		try {
			await waitFor(() => /Gentle Dot is running|failed to start/.test(output()), 240_000);
			const port = /127\.0\.0\.1:(\d+)/.exec(output())?.[1];
			const health = await json<{ agentState: string }>(`http://127.0.0.1:${port}/health`);
			// No memory server was running: the engine's memory plugin starts the global one,
			// with the user's data folder, on the user's port.
			for (let i = 0; i < 60 && !memory; i++) {
				memory = await json<{ instance_id?: string }>(`${engramUrl}/health`).catch(
					() => new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
				);
			}
			// The engine's memory plugin resolves its project with this same call on its workspace.
			const workspace = join(dataDir, "workspace");
			const current = await json<{ project?: string; project_source?: string }>(
				`${engramUrl}/project/current?cwd=${encodeURIComponent(workspace)}`,
			);
			// What the plugin's mem_save sends for a memory with no explicit project.
			const session = `gentle-dot-probe-${Date.now()}`;
			await json(`${engramUrl}/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: session, project: current.project, directory: workspace }),
			});
			const saved = await json<{ id: number }>(`${engramUrl}/observations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					session_id: session,
					title: "Probe memory",
					content: "Saved by the isolation probe",
					type: "manual",
					project: current.project,
					scope: "project",
				}),
			});
			const observation = await json<{ project?: string }>(`${engramUrl}/observations/${saved.id}`);
			child.kill("SIGTERM");
			await exited;
			const after = hashTree(home);
			console.log(
				`HOME: ${home}\nagent state: ${health.agentState}\nHOME before: ${before}\nHOME after:  ${after}\n` +
					`stand-in Engram: ${engramUrl}, data ${globalData}\n` +
					`memory server instance: ${memory?.instance_id}\nglobal data instance: ${globalId}\n` +
					`project for the workspace: ${current.project} (${current.project_source})\n` +
					`observation ${saved.id} project: ${observation.project}`,
			);
			console.log(output().slice(0, 4000));
			expect(health.agentState).toBe("idle");
			expect(memory?.instance_id).toBe(globalId);
			expect(readdirSync(join(dataDir, "home")).includes(".engram")).toBe(false);
			expect(current).toMatchObject({ project: "gentle-dot", project_source: "config" });
			expect(observation.project).toBe("gentle-dot");
			expect(output()).not.toContain("#token=");
			expect(after).toBe(before);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			// Stop the stand-in only after checking it is the one on the probe's own data folder.
			const pid = listener(engramPort);
			const id = await json<{ instance_id?: string }>(`${engramUrl}/health`).catch(() => undefined);
			if (pid && id?.instance_id === globalId) process.kill(pid, "SIGTERM");
			console.log(`stand-in Engram pid ${pid} stopped: ${Boolean(pid && id?.instance_id === globalId)}`);
		}
	});
});
