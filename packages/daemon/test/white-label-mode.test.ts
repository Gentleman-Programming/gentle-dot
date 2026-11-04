import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY_SOURCE } from "../src/white-label.ts";

const moduleUrl = new URL("../src/white-label.ts", import.meta.url).href;
const canonical = readFileSync(IDENTITY_SOURCE, "utf8");

// POSIX modes do not establish Windows ACL behavior; keep these checks explicitly POSIX-only.
describe.skipIf(process.platform === "win32")("public identity prompt permissions", () => {
	it.each([
		{ name: "creates under umask 002", mask: 0o002, existing: null },
		{ name: "creates under umask 027", mask: 0o027, existing: null },
		{ name: "repairs existing 0666 under umask 077", mask: 0o077, existing: 0o666 },
		{ name: "repairs existing 0600 under umask 077", mask: 0o077, existing: 0o600 },
	])("$name", ({ mask, existing }) => {
		const dir = mkdtempSync(join(tmpdir(), "public-identity-"));
		const path = join(dir, "identity.md");
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`
					import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
					import { identityArgs } from ${JSON.stringify(moduleUrl)};
					const path = ${JSON.stringify(path)};
					process.umask(${mask});
					if (${existing} !== null) {
						writeFileSync(path, "stale prompt");
						chmodSync(path, ${existing});
					}
					const args = identityArgs(${JSON.stringify(dir)});
					console.log(JSON.stringify({
						args, content: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777,
					}));
				`,
			],
			{ encoding: "utf8", timeout: 5000, env: process.env },
		);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		const result = JSON.parse(child.stdout);
		expect(result.args).toEqual(["--append-system-prompt", path]);
		expect(result.content).toBe(canonical);
		expect(result.mode).toBe(0o644);
	});
});
