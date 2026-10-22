// How the root daemon reaches the engine's files in server mode (S25.8, B1): synchronously, as the
// engine's user, and never while it writes a file of its own. The root-only half of these checks runs
// in the container (vps-root.test.ts); here, the rules that hold for any user.
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineAccess, insideEngineAccess } from "../src/engine-access.ts";
import { ensurePrivateDir } from "../src/isolation.ts";
import { writePrivateFile } from "../src/private-file.ts";
import { tempDir } from "./helpers.ts";
import { inspectWindowsAcl } from "./windows-acl-oracle.ts";

// Bracket semantics use an explicit POSIX identity fixture, not a fabricated Windows root.
const own = { uid: process.getuid?.() ?? 1001, gid: process.getgid?.() ?? 1001 };
const euidDescriptor = Object.getOwnPropertyDescriptor(process, "geteuid");
beforeEach(() => {
	if (!euidDescriptor)
		Object.defineProperty(process, "geteuid", { configurable: true, value: () => own.uid });
});
afterEach(() => {
	if (euidDescriptor) Object.defineProperty(process, "geteuid", euidDescriptor);
	else Reflect.deleteProperty(process, "geteuid");
});
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("engine access", () => {
	it("runs a synchronous call and says it is inside while it runs", () => {
		const access = engineAccess(own);
		expect(insideEngineAccess()).toBe(false);
		expect(access(() => insideEngineAccess())).toBe(true);
		expect(access(() => access(() => 42))).toBe(42);
		expect(insideEngineAccess()).toBe(false);
	});

	it("refuses a call that would go on asynchronously", async () => {
		const access = engineAccess(own);
		expect(() => access(() => Promise.resolve(1))).toThrow(/synchronously/);
		expect(insideEngineAccess()).toBe(false);
	});

	it("fails closed when the host cannot provide a POSIX effective identity", () => {
		Object.defineProperty(process, "geteuid", { configurable: true, value: undefined });
		let ran = false;
		expect(() =>
			engineAccess(own)(() => {
				ran = true;
			}),
		).toThrow(/without root/);
		expect(ran).toBe(false);
	});

	it.skipIf(own.uid === 0)("refuses, without running it, a call as a user it cannot become", () => {
		let ran = false;
		expect(() =>
			engineAccess({ uid: own.uid + 1, gid: own.gid })(() => {
				ran = true;
			}),
		).toThrow(/without root/);
		expect(ran).toBe(false);
	});
});

describe("the daemon's own files", () => {
	it("are written whole, private, and replace a link at their place without following it", () => {
		const dir = tempDir();
		if (process.platform === "win32") ensurePrivateDir(dir);
		const target = join(dir, "target");
		writeFileSync(target, "keep");
		const file = join(dir, "state.json");
		symlinkSync(target, file);
		if (process.platform === "win32") {
			expect(() => writePrivateFile(file, "new\n")).toThrow(/reparse points/);
			expect(readFileSync(target, "utf8")).toBe("keep");
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			unlinkSync(file);
		} else writePrivateFile(file, "new\n");
		writePrivateFile(file, "new\n");
		expect(readFileSync(target, "utf8")).toBe("keep");
		expect(lstatSync(file).isFile()).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("new\n");
		if (process.platform === "win32") {
			const acl = inspectWindowsAcl(file);
			expect(acl.owner).toBe(acl.currentSid);
			expect(acl.protected).toBe(true);
			expect(acl.rules.map((rule) => rule.sid)).toEqual(expect.arrayContaining([acl.currentSid, "S-1-5-18"]));
			expect(acl.rules).toHaveLength(2);
			expect(acl.rules.every((rule) => rule.type === "Allow" && !rule.inherited)).toBe(true);
		} else expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).sort()).toEqual(["state.json", "target"]);
	});

	it("are never written inside an engine-access call, and nothing is left behind", () => {
		const dir = tempDir();
		expect(() => engineAccess(own)(() => writePrivateFile(join(dir, "token"), "x"))).toThrow(/engine's user/);
		expect(existsSync(join(dir, "token"))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("no file work on libuv's thread pool (S25.8, B1)", () => {
	// A bracket changes the ids of every thread: asynchronous file work in flight meanwhile would run
	// as the engine's user. The daemon does none, apart from the uploads' stream on an open file.
	it("imports no asynchronous file functions", () => {
		const allowed = new Set(["constants", "watch", "FSWatcher", "Stats", "Dirent"]);
		const found: string[] = [];
		for (const name of readdirSync(SRC, { recursive: true }) as string[]) {
			if (!name.endsWith(".ts")) continue;
			const text = readFileSync(join(SRC, name), "utf8");
			if (/["']node:fs\/promises["']|["']fs\/promises["']|\bfs\.promises\b/.test(text))
				found.push(`${name}: fs/promises`);
			for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](?:node:)?fs["']/g)) {
				for (const raw of (match[1] ?? "").split(",")) {
					const imported = raw.trim().replace(/^type\s+/, "");
					if (!imported || imported.endsWith("Sync") || allowed.has(imported)) continue;
					if (imported === "createWriteStream" && name === "uploads.ts") continue;
					found.push(`${name}: ${imported}`);
				}
			}
		}
		expect(found).toEqual([]);
	});

	it("opens every upload synchronously and streams only to the open file", () => {
		const text = readFileSync(join(SRC, "uploads.ts"), "utf8");
		expect(text.match(/createWriteStream\(([^)]*)\)/g)).toEqual([
			'createWriteStream("", { fd, autoClose: true })',
		]);
	});
});
