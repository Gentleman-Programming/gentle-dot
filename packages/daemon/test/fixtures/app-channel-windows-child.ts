#!/usr/bin/env node
// Native anonymous-pipe stand-in, not the Unix fd-identity/leak probe or a Rust Job test.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openInheritedChannel } from "../../src/app-channel.ts";

const mode = process.argv[2];
if (mode === "descendant") {
	let input = "";
	for await (const chunk of process.stdin) input += chunk.toString();
	process.stdout.write(`${JSON.stringify({ input, selector: process.env.GENTLE_DOT_APP_STDIO ?? null })}\n`);
	process.stderr.write(`descendant-${process.argv[3]}\n`);
} else {
	try {
		const channel = openInheritedChannel();
		if (!channel) throw new Error("Expected the Windows app channel.");
		channel.handler = (method, params) => {
			if (method !== "echo") throw new Error(`Unexpected method: ${method}`);
			return params;
		};
		try {
			const fixture = fileURLToPath(import.meta.url);
			const fromSpawn = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(process.execPath, [fixture, "descendant", "async"], {
						stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
					});
					let stdout = "";
					let stderr = "";
					let failure: Error | undefined;
					child.on("error", (error) => { failure = error; });
					child.stdin.on("error", (error) => { failure = error; });
					child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
					child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
					child.on("close", (code) => {
						if (failure) reject(failure);
						else resolve({ code, stdout, stderr });
					});
					child.stdin.end("fresh-async-stdin\n");
				},
			);
			const sync = spawnSync(process.execPath, [fixture, "descendant", "sync"], {
				stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", timeout: 5000,
				input: "fresh-sync-stdin\n",
			});
			if (sync.error) throw sync.error;
			// Only these static fixture arguments go through cmd.exe; no user/shell input.
			const shell = spawnSync(process.env.ComSpec ?? "cmd.exe", [
				"/d", "/s", "/c", `""${process.execPath}" "${fixture}" descendant shell"`,
			], {
				windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"],
				encoding: "utf8", timeout: 5000, input: "fresh-shell-stdin\n",
			});
			if (shell.error) throw shell.error;
			const acknowledgement = await channel.request("report", {
				selector: process.env.GENTLE_DOT_APP_STDIO ?? null,
				fromSpawn,
				fromSpawnSync: { code: sync.status, stdout: sync.stdout, stderr: sync.stderr },
				fromShell: { code: shell.status, stdout: shell.stdout, stderr: shell.stderr },
			}, 5000);
			if (JSON.stringify(acknowledgement) !== JSON.stringify({ accepted: "private-report-ack" })) {
				throw new Error("Unexpected app response.");
			}
		} finally {
			channel.close();
		}
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\nselector=${process.env.GENTLE_DOT_APP_STDIO ?? "consumed"}\n`);
		process.exitCode = 2;
	}
}
