import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY_SOURCE } from "../src/white-label.ts";
import { tempDir } from "./helpers.ts";

const moduleUrl = new URL("../src/white-label.ts", import.meta.url).href;
const script = `
import { statSync, readFileSync } from 'node:fs';
import { identityArgs } from ${JSON.stringify(moduleUrl)};
process.umask(Number(process.argv[2]));
const args = identityArgs(process.argv[1]);
console.log(JSON.stringify({ args, mode: statSync(args[1]).mode & 0o777, text: readFileSync(args[1], 'utf8') }));
`;

// POSIX mode semantics only; this is not Windows ACL/native acceptance.
describe.skipIf(process.platform === "win32")("identity prompt mode for the separate engine user", () => {
	function check(dataDir: string, mask: number) {
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dataDir, String(mask)], {
			encoding: "utf8",
		});
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({
			args: ["--append-system-prompt", join(dataDir, "identity.md")],
			mode: 0o644,
			text: readFileSync(IDENTITY_SOURCE, "utf8"),
		});
	}

	it.each([0o002, 0o027])("creates the exact engine-readable mode despite umask %i", (mask) => {
		check(tempDir(), mask);
	});

	it.each([0o666, 0o600])(
		"repairs existing identity mode %i without changing content or arguments",
		(mode) => {
			const dataDir = tempDir();
			const path = join(dataDir, "identity.md");
			writeFileSync(path, "old prompt");
			chmodSync(path, mode);
			check(dataDir, 0o077);
		},
	);
});
