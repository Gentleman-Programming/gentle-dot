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
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineAccess, insideEngineAccess } from "../src/engine-access.ts";
import { writePrivateFile } from "../src/private-file.ts";
import { tempDir } from "./helpers.ts";

const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
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
		const target = join(dir, "target");
		writeFileSync(target, "keep");
		symlinkSync(target, join(dir, "state.json"));
		writePrivateFile(join(dir, "state.json"), "new\n");
		expect(readFileSync(target, "utf8")).toBe("keep");
		expect(lstatSync(join(dir, "state.json")).isFile()).toBe(true);
		expect(readFileSync(join(dir, "state.json"), "utf8")).toBe("new\n");
		expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
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
