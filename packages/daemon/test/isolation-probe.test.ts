// @real-agent isolation probe: starts the daemon with the bundled engine for the
// first time under a seeded temporary HOME and checks that HOME is byte-identical
// afterwards, and that the engine's memory server belongs to the assistant's own
// home. Opt-in (it installs the engine's companion packages and needs internet
// access; it needs `engram` and `lsof` on PATH):
//   GENTLE_DOT_ISOLATION_PROBE=1 npx vitest run packages/daemon/test/isolation-probe.test.ts
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ENGRAM_PORT = "17438";
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

describe.skipIf(!enabled)("@real-agent isolation probe", () => {
	it("leaves the user's HOME untouched on a first start", { timeout: 300_000 }, async () => {
		const home = tempDir();
		const dataDir = join(tempDir(), "data");
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
				GENTLE_DOT_ENGRAM_PORT: ENGRAM_PORT,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
		await waitFor(() => /Gentle Dot is running|failed to start/.test(output), 240_000);
		const port = /127\.0\.0\.1:(\d+)/.exec(output)?.[1];
		const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { agentState: string };
		// The engine starts the assistant's own memory server when it loads.
		let memory: { instance_id?: string } | undefined;
		for (let i = 0; i < 60 && !memory; i++) {
			memory = await fetch(`http://127.0.0.1:${ENGRAM_PORT}/health`).then(
				(r) => r.json() as Promise<{ instance_id?: string }>,
				() => new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
			);
		}
		const ownId = execFileSync("engram", ["instance-id"], {
			env: { PATH: process.env.PATH, HOME: join(dataDir, "home") },
		})
			.toString()
			.trim();
		child.kill("SIGTERM");
		await exited;
		const memoryPid = execFileSync("lsof", ["-t", `-iTCP:${ENGRAM_PORT}`, "-sTCP:LISTEN"])
			.toString()
			.trim();
		if (/^\d+$/.test(memoryPid)) process.kill(Number(memoryPid), "SIGTERM");
		const after = hashTree(home);
		console.log(
			`HOME: ${home}\nagent state: ${health.agentState}\nHOME before: ${before}\nHOME after:  ${after}`,
		);
		console.log(`memory server: ${memory?.instance_id}\nassistant home instance: ${ownId}`);
		console.log(output.slice(0, 4000));
		expect(health.agentState).toBe("idle");
		expect(memory?.instance_id).toBe(ownId);
		expect(output).not.toContain("#token=");
		expect(after).toBe(before);
	});
});
