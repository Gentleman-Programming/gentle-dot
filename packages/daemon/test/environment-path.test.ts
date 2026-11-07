import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { environmentPath } from "../src/environment-path.ts";

const bin = "C:\\Gentle\\bin";
const inherited = "C:\\Tools;C:\\Windows\\System32";
const pathKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter((key) => key.toUpperCase() === "PATH");

describe("Windows child PATH (synthetic platform, not native spawn proof)", () => {
	it.each(["Path", "PATH", "path", "pAtH"])("preserves %s as one PATH", (key) => {
		const env = environmentPath({ [key]: inherited }, bin, "win32");
		expect(pathKeys(env)).toEqual(["PATH"]);
		expect(env.PATH).toBe(`${bin};${inherited}`);
	});

	it("selects the first lexicographic defined key regardless of insertion order", () => {
		for (const base of [
			{ Path: "ignored", path: "ignored", PATH: inherited },
			{ PATH: inherited, path: "ignored", Path: "ignored" },
			{ path: "ignored", pAtH: "ignored", Path: inherited },
		]) {
			expect(environmentPath(base, bin, "win32")).toEqual({ PATH: `${bin};${inherited}` });
		}
	});

	it("skips undefined aliases but treats an empty value as defined", () => {
		expect(environmentPath({ PATH: undefined, Path: inherited }, bin, "win32")).toEqual({
			PATH: `${bin};${inherited}`,
		});
		expect(environmentPath({ PATH: "", Path: inherited }, bin, "win32")).toEqual({ PATH: bin });
	});

	it("normalizes aliases without a bundled bin, including empty and undefined", () => {
		for (const value of [inherited, ""]) {
			expect(environmentPath({ Path: value, path: "ignored" }, undefined, "win32")).toEqual({
				PATH: value,
			});
		}
		expect(environmentPath({ Path: undefined }, undefined, "win32")).toEqual({});
	});

	it.each([undefined, ""])("prepends to missing or empty PATH (%s)", (PATH) => {
		expect(environmentPath({ PATH }, bin, "win32").PATH).toBe(bin);
	});

	it("removes only bundled-bin duplicates ignoring case and trailing separators", () => {
		const PATH = `${bin.toUpperCase()}\\/;${inherited};${bin}/;C:\\Tools;C:\\Gentle\\bin-extra`;
		expect(environmentPath({ PATH }, bin, "win32").PATH).toBe(
			`${bin};${inherited};C:\\Tools;C:\\Gentle\\bin-extra`,
		);
	});

	it("is idempotent after alias normalization and bundled prepend", () => {
		const once = environmentPath({ Path: `${inherited};${bin.toUpperCase()}\\` }, bin, "win32");
		expect(environmentPath(once, bin, "win32")).toEqual(once);
	});

	it("returns a new environment without mutating input or unrelated field order", () => {
		const base = Object.freeze({ FIRST: "one", Path: inherited, LAST: undefined, LANG: "C" });
		const env = environmentPath(base, bin, "win32");
		expect(env).not.toBe(base);
		expect(base).toEqual({ FIRST: "one", Path: inherited, LAST: undefined, LANG: "C" });
		const { PATH, ...unrelated } = env;
		expect(PATH).toBe(`${bin};${inherited}`);
		expect(Object.entries(unrelated)).toEqual([
			["FIRST", "one"],
			["LAST", undefined],
			["LANG", "C"],
		]);
	});
});

it("POSIX keeps Path distinct and the existing prepend, filtering and precedence", () => {
	const base = { Path: "case-sensitive", PATH: `/tools${delimiter}/bin${delimiter}/tools` };
	const once = environmentPath(base, "/bin", "linux");
	expect(once).toEqual({ Path: "case-sensitive", PATH: `/bin${delimiter}/tools${delimiter}/tools` });
	expect(environmentPath(once, "/bin", "linux")).toEqual(once);
	expect(environmentPath({ Path: "keep" }, undefined, "linux")).toEqual({ Path: "keep" });
	expect(environmentPath({ Path: "keep" }, "/bin", "linux")).toEqual({
		Path: "keep",
		PATH: "/bin",
	});
});

it("public isolatedAgentEnv derives PATH from the input and sanitizes the returned environment", async () => {
	const spy = vi.spyOn(await import("../src/environment-path.ts"), "environmentPath");
	try {
		const { isolatedAgentEnv } = await import("../src/isolation.ts");
		const data = join(process.env.TMPDIR ?? ".cache", "path-wiring");
		const base = Object.freeze({
			HOME: data,
			TMPDIR: data,
			PATH: "/tools",
			PI_CODING_AGENT_DIR: "synthetic-home",
			GENTLE_PI_AGENT_HOME: "synthetic-home",
			GENTLE_SHELL_CONFIG: "synthetic-config",
			GENTLE_DOT_SECRETS_KEY: "synthetic-only",
			GENTLE_PI_AGENTS_CHILD: "1",
			GENTLE_PI_AGENTS_OWNED_IPC: "synthetic-ipc",
			GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3",
			GENTLE_PI_AGENTS_PI: "synthetic-command",
		});
		const env = isolatedAgentEnv(base, data, <T>() => undefined as T);
		expect(spy).toHaveBeenCalledOnce();
		const [input, bundled, platform] = spy.mock.calls[0] ?? [];
		expect(platform).toBe(process.platform);
		expect(input).toBe(base);
		expect(input?.HOME).toBe(data);
		expect(env.HOME).toBe(join(data, "home"));
		for (const key of Object.keys(base).filter((key) => !["HOME", "TMPDIR", "PATH"].includes(key))) {
			expect(env).not.toHaveProperty(key);
		}
		expect(env.PATH).toBe(environmentPath(base, bundled, process.platform).PATH);
	} finally {
		spy.mockRestore();
	}
});
