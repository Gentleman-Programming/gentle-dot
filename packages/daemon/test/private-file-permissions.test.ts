import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writePrivateFile } from "../src/private-file.ts";
import { tempDir } from "./helpers.ts";
import { expectPrivateFilePermissions } from "./private-file-permissions.ts";
import { inspectWindowsAcl } from "./windows-acl-oracle.ts";

const contents = "synthetic private-file permission fixture\n";

it("accepts a real private file without changing its bytes", () => {
	const file = join(tempDir(), "private.txt");
	writePrivateFile(file, contents);
	expectPrivateFilePermissions(file);
	expect(readFileSync(file, "utf8")).toBe(contents);
});

it(process.platform === "win32"
	? "rejects an explicit Everyone Allow ACE without repairing ACLs or changing bytes"
	: "rejects a world-readable file without repairing permissions or changing bytes", () => {
	const root = tempDir();
	const secure = join(root, "secure.txt");
	const insecure = join(root, "insecure.txt");
	writePrivateFile(secure, contents);
	writePrivateFile(insecure, readFileSync(secure, "utf8"));
	if (process.platform === "win32") {
		const script = `$ErrorActionPreference = 'Stop'
$file = [System.IO.FileInfo]::new($env:GENTLE_DOT_ACL_TARGET)
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$acl = $file.GetAccessControl($sections)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
$file.SetAccessControl($acl)`;
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64")], {
			env: { ...process.env, GENTLE_DOT_ACL_TARGET: insecure }, windowsHide: true,
		});
		const before = inspectWindowsAcl(insecure);
		expect(before.rules).toContainEqual({ sid: "S-1-1-0", type: "Allow", inherited: false });
		expect(() => expectPrivateFilePermissions(insecure)).toThrow();
		expect(inspectWindowsAcl(insecure)).toEqual(before);
	} else {
		chmodSync(insecure, 0o644);
		expect(() => expectPrivateFilePermissions(insecure)).toThrow();
		expect(statSync(insecure).mode & 0o777).toBe(0o644);
	}
	expect(readFileSync(insecure, "utf8")).toBe(contents);
	expect(readFileSync(secure, "utf8")).toBe(contents);
});
