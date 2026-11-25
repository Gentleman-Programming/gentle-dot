import { statSync } from "node:fs";
import { expect } from "vitest";
import { inspectWindowsAcl } from "./windows-acl-oracle.ts";

/** Verify private-file protection without repairing or modifying the file. */
export function expectPrivateFilePermissions(path: string): void {
	if (process.platform !== "win32") {
		expect(statSync(path).mode & 0o777).toBe(0o600);
		return;
	}
	const acl = inspectWindowsAcl(path);
	expect(acl.owner).toBe(acl.currentSid);
	expect(acl.protected).toBe(true);
	expect(acl.rules.map((rule) => rule.sid).sort()).toEqual([acl.currentSid, "S-1-5-18"].sort());
	expect(acl.rules.every((rule) => rule.type === "Allow" && !rule.inherited)).toBe(true);
}
