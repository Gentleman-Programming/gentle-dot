import { execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDir } from "../src/isolation.ts";
import { securePrivateFile, writePrivateFile } from "../src/private-file.ts";
import { FileSecretSource } from "../src/secret-file.ts";
import { ConnectorStore } from "../src/connectors.ts";
import { PinGate } from "../src/web-pin.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { runtimeDir } from "../src/runtime.ts";
import { SOURCE_PRIVATE_STORAGE_HELPER } from "../src/runtime-build.ts";
import { windowsPrivateStorageExecutable } from "../src/windows-private-storage.ts";
import { inspectWindowsAcl } from "./windows-acl-oracle.ts";

const fixtures: string[] = [];

afterEach(() => {
	for (const root of fixtures.splice(0)) {
		const real = resolve(root);
		if (real.startsWith(resolve(tmpdir()) + "\\")) rmSync(real, { recursive: true, force: true });
	}
});

function powershell(script: string, root: string, target = ""): string {
	return execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, GENTLE_DOT_ACL_FIXTURE: root, GENTLE_DOT_ACL_TARGET: target },
		},
	);
}

function directorySddl(root: string, path: string): string {
	return powershell(
		`$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$acl = ([System.IO.DirectoryInfo]::new($env:GENTLE_DOT_ACL_TARGET)).GetAccessControl($sections)
$acl.GetSecurityDescriptorSddlForm($sections)`,
		root,
		path,
	).trim();
}

function addExplicitEveryoneAccess(root: string, path: string): void {
	powershell(
		`$ErrorActionPreference = 'Stop'
$path = $env:GENTLE_DOT_ACL_TARGET
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$file = [System.IO.FileInfo]::new($path)
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$acl = $file.GetAccessControl($sections)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
$file.SetAccessControl($acl)`,
		root,
		path,
	);
}

describe.skipIf(process.platform !== "win32")("Windows private storage DACL", () => {
	it("does not retain broad inherited access on a private directory", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-acl-")).replace(/[\\/]$/, "");
		fixtures.push(root);
		const target = join(root, "private");
		powershell(
			`$ErrorActionPreference = 'Stop'
$path = $env:GENTLE_DOT_ACL_FIXTURE
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$directory = [System.IO.DirectoryInfo]::new($path)
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$acl = $directory.GetAccessControl($sections)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$directory.SetAccessControl($acl)`,
			root,
		);
		const inheritedParentDacl = directorySddl(root, root);

		// This exercises the existing Node primitive against an inherited Everyone ACE.
		ensurePrivateDir(target);
		const privateFile = join(target, "secret.json");
		writePrivateFile(privateFile, "first secret\n");
		writePrivateFile(privateFile, "replacement secret\n");
		const assertPrivate = (acl: ReturnType<typeof inspectWindowsAcl>) => {
			expect(acl.owner).toBe(acl.currentSid);
			expect(acl.protected).toBe(true);
			expect(acl.rules.map((rule) => rule.sid)).toEqual(expect.arrayContaining([acl.currentSid, "S-1-5-18"]));
			expect(acl.rules).toHaveLength(2);
			expect(acl.rules.every((rule) => !rule.inherited)).toBe(true);
			expect(acl.rules.every((rule) => rule.type === "Allow")).toBe(true);
			expect(acl.rules.map((rule) => rule.sid)).not.toContain("S-1-1-0");
		};
		assertPrivate(inspectWindowsAcl(target));
		assertPrivate(inspectWindowsAcl(privateFile));

		expect(directorySddl(root, root)).toBe(inheritedParentDacl);
		expect(readFileSync(privateFile, "utf8")).toBe("replacement secret\n");
	});

	it("tightens an existing owned directory without changing its parent", () => {
		const parent = mkdtempSync(join(tmpdir(), "gentle-dot-existing-parent-"));
		fixtures.push(parent);
		const existing = join(parent, "existing");
		mkdirSync(existing);
		const parentDacl = directorySddl(parent, parent);
		powershell(
			`$ErrorActionPreference = 'Stop'
$path = $env:GENTLE_DOT_ACL_TARGET
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$directory = [System.IO.DirectoryInfo]::new($path)
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
$acl = $directory.GetAccessControl($sections)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$directory.SetAccessControl($acl)`,
			existing,
			existing,
		);
		ensurePrivateDir(existing);
		const acl = inspectWindowsAcl(existing);
		expect(acl.owner).toBe(acl.currentSid);
		expect(acl.protected).toBe(true);
		expect(acl.rules.map((rule) => rule.sid)).toEqual(expect.arrayContaining([acl.currentSid, "S-1-5-18"]));
		expect(acl.rules.map((rule) => rule.sid)).not.toContain("S-1-1-0");
		expect(directorySddl(parent, parent)).toBe(parentDacl);
	});

	it("secures a legacy private file before reading it and preserves its contents", async () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-legacy-file-"));
		fixtures.push(root);
		ensurePrivateDir(root);
		const file = join(root, "secrets.enc.json");
		const contents = JSON.stringify({ version: 1, records: {} });
		writeFileSync(file, contents);
		addExplicitEveryoneAccess(root, file);
		const parentDacl = inspectWindowsAcl(root);
		const before = inspectWindowsAcl(file);
		expect(before.rules.map((rule) => rule.sid)).toContain("S-1-1-0");

		const source = new FileSecretSource({ file, key: Buffer.alloc(32, 7) });
		await expect(source.list()).resolves.toEqual([]);

		const after = inspectWindowsAcl(file);
		expect(after.owner).toBe(after.currentSid);
		expect(after.protected).toBe(true);
		expect(after.rules.map((rule) => rule.sid)).not.toContain("S-1-1-0");
		expect(readFileSync(file, "utf8")).toBe(contents);
		expect(inspectWindowsAcl(root)).toEqual(parentDacl);
	});

	it("preserves the missing encrypted-secret file contract", async () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-missing-secret-"));
		fixtures.push(root);
		ensurePrivateDir(root);
		const source = new FileSecretSource({ file: join(root, "secrets.enc.json"), key: Buffer.alloc(32, 4) });
		await expect(source.list()).resolves.toEqual([]);
	});

	it("repairs legacy connector, PIN, and supervisor files at their read boundaries", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-private-readers-"));
		fixtures.push(root);
		ensurePrivateDir(root);
		const assertRepairedRead = (file: string, contents: string, read: () => unknown, expected: unknown) => {
			writeFileSync(file, contents);
			addExplicitEveryoneAccess(root, file);
			const parentDacl = inspectWindowsAcl(dirname(file));
			expect(read()).toEqual(expected);
			const acl = inspectWindowsAcl(file);
			expect(acl.owner).toBe(acl.currentSid);
			expect(acl.protected).toBe(true);
			expect(acl.rules.map((rule) => rule.sid)).not.toContain("S-1-1-0");
			expect(readFileSync(file, "utf8")).toBe(contents);
			expect(inspectWindowsAcl(dirname(file))).toEqual(parentDacl);
		};

		const connectorsDir = join(root, "connectors");
		ensurePrivateDir(connectorsDir);
		const connectorsFile = join(connectorsDir, "connectors.json");
		const connectorsText = JSON.stringify({ version: 2, connectors: {} });
		assertRepairedRead(
			connectorsFile,
			connectorsText,
			() => new ConnectorStore({ dataDir: connectorsDir, agentHome: join(root, "agent") }).state(),
			{ connectors: {} },
		);

		const pinFile = join(root, "web-pin.json");
		const damagedPin = "{broken";
		assertRepairedRead(pinFile, damagedPin, () => new PinGate({ file: pinFile }).status(), {
			set: true,
			locked: true,
		});

		const supervisorState = JSON.stringify({ sessionFile: "C:\\scratch\\session.jsonl", chains: {} });
		const supervisorDir = join(root, "supervisor");
		ensurePrivateDir(supervisorDir);
		const stateFile = join(supervisorDir, "state.json");
		assertRepairedRead(
			stateFile,
			supervisorState,
			() => new AgentSupervisor({ command: "unused.exe", cwd: root, dataDir: supervisorDir }).sessionFile,
			"C:\\scratch\\session.jsonl",
		);
	});

	it("refuses to change a hard-linked private file or its external alias", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-hardlink-"));
		fixtures.push(root);
		ensurePrivateDir(root);
		const privateDir = join(root, "private");
		ensurePrivateDir(privateDir);
		const alias = join(root, "legacy-secret.json");
		const target = join(privateDir, "legacy-secret.json");
		const contents = "legacy value must remain unchanged\n";
		writeFileSync(alias, contents);
		addExplicitEveryoneAccess(root, alias);
		linkSync(alias, target);
		const before = inspectWindowsAcl(alias);
		const parentBefore = inspectWindowsAcl(privateDir);

		expect(() => securePrivateFile(target)).toThrow(/hard-linked files/);
		expect(() => writePrivateFile(target, "replacement\n")).toThrow(/hard-linked files/);
		expect(inspectWindowsAcl(alias)).toEqual(before);
		expect(inspectWindowsAcl(privateDir)).toEqual(parentBefore);
		expect(readFileSync(alias, "utf8")).toBe(contents);
		expect(readFileSync(target, "utf8")).toBe(contents);
	});

	it("refuses reparse-point targets and does not mutate their destination", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-reparse-"));
		fixtures.push(root);
		const outside = join(root, "outside");
		const link = join(root, "linked");
		mkdirSync(outside);
		symlinkSync(outside, link, "junction");
		expect(() => ensurePrivateDir(link)).toThrow(/reparse points/);
		expect(() => writePrivateFile(join(link, "secret.json"), "no write")).toThrow(/reparse points/);
		expect(existsSync(outside)).toBe(true);
		expect(existsSync(join(outside, "created-by-test"))).toBe(false);
	});

	it("uses the source helper from this checkout without changing runtime identity", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-dot-source-mode-"));
		fixtures.push(root);
		const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
		const stagingRoot = join(repositoryRoot, "build", "windows", "runtime");
		const relativeToStaging = relative(stagingRoot, SOURCE_PRIVATE_STORAGE_HELPER);
		expect(
			relativeToStaging === "" || (!relativeToStaging.startsWith("..") && !isAbsolute(relativeToStaging)),
		).toBe(false);
		const identity = runtimeDir();
		const executable = windowsPrivateStorageExecutable(identity);
		if (identity === undefined) {
			expect(executable).toBe(SOURCE_PRIVATE_STORAGE_HELPER);
			expect(executable).toContain("build\\windows\\local-tools\\bin\\private-storage.exe");
		}
		else expect(executable).toBe(join(identity, "bin", "private-storage.exe"));
		expect(existsSync(executable)).toBe(true);
		ensurePrivateDir(join(root, "private"));
		expect(runtimeDir()).toBe(identity);
	});
});
