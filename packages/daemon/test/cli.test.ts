import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("gentle-dot command", () => {
	it("keeps the access key out of redirected output, such as a log file", async () => {
		const dataDir = join(tempDir(), "data");
		const child = spawn(process.execPath, [CLI], {
			env: {
				...process.env,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_AGENT_BIN: process.execPath,
				GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const exited = new Promise((resolve) => child.on("close", resolve));
		try {
			await waitFor(() => output.includes("Gentle Dot is running"), 15_000);
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
		const token = readFileSync(join(dataDir, "token"), "utf8").trim();
		expect(output).not.toContain(token);
		expect(output).toContain(`the access key is in ${join(dataDir, "token")}`);
		expect(statSync(dataDir).mode & 0o777).toBe(0o700);
	});
});
