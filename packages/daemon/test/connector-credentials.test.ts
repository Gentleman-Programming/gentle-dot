// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${NAME}` is the reference syntax under test.
// `!command` connector values (W21). The engine resolves them through `getShellConfig`, which picks
// Git Bash on Windows; the daemon mirrors that decision in a pure `commandShell` instead of importing
// the engine (the import costs about two seconds of daemon startup and `resolveValue` is synchronous).
// The parity guard at the end holds the mirror to the engine's real answer.
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandShell, resolveValue } from "../src/connector-credentials.ts";

const GIT_BASH = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
const GIT_BASH_X86 = win32.join("C:\\Program Files (x86)", "Git", "bin", "bash.exe");

describe("commandShell", () => {
	it("picks Git Bash under %ProgramFiles% on Windows", () => {
		const shell = commandShell({ ProgramFiles: "C:\\Program Files" }, "win32", (path) => path === GIT_BASH);
		expect(shell).toEqual({ shell: GIT_BASH, args: ["-c"] });
		expect(shell?.stdin).toBeUndefined();
	});

	it("falls back to %ProgramFiles(x86)% when the first Git Bash is absent", () => {
		const shell = commandShell(
			{ ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
			"win32",
			(path) => path === GIT_BASH_X86,
		);
		expect(shell).toEqual({ shell: GIT_BASH_X86, args: ["-c"] });
	});

	it("falls back to bash.exe on the injected PATH", () => {
		const bash = win32.join("C:\\second", "bash.exe");
		const shell = commandShell(
			{ PATH: ["C:\\first", "C:\\second"].join(";") },
			"win32",
			(path) => path === bash,
		);
		expect(shell).toEqual({ shell: bash, args: ["-c"] });
	});

	it("reads a legacy WSL bash from PATH as the stdin form", () => {
		const system32 = win32.join("C:\\Windows\\System32", "bash.exe");
		expect(commandShell({ PATH: "C:\\Windows\\System32" }, "win32", (path) => path === system32)).toEqual({
			shell: system32,
			args: ["-s"],
			stdin: true,
		});
		// The engine's check is case-insensitive and accepts either separator; `/` normalizes here too.
		const sysnative = win32.join("c:\\windows\\sysnative", "bash.exe");
		expect(commandShell({ PATH: "c:/windows/sysnative" }, "win32", (path) => path === sysnative)).toEqual({
			shell: sysnative,
			args: ["-s"],
			stdin: true,
		});
	});

	it("returns undefined when no bash exists", () => {
		expect(commandShell({ PATH: "C:\\one" }, "win32", () => false)).toBeUndefined();
	});

	it("keeps POSIX at /bin/sh -c without consulting the environment or the filesystem", () => {
		const exists = vi.fn(() => {
			throw new Error("exists must not be consulted on POSIX");
		});
		expect(commandShell({ PATH: "/usr/bin" }, "linux", exists)).toEqual({ shell: "/bin/sh", args: ["-c"] });
		expect(commandShell({}, "darwin", exists)).toEqual({ shell: "/bin/sh", args: ["-c"] });
		expect(exists).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform !== "win32")("matches the engine's real getShellConfig", async () => {
		const { getShellConfig } = await import("@earendil-works/pi-coding-agent");
		const ours = commandShell(process.env, "win32", existsSync);
		const engine = (() => {
			try {
				return getShellConfig();
			} catch {
				return undefined;
			}
		})();
		if (!engine) {
			expect(ours).toBeUndefined();
			return;
		}
		expect(ours?.shell).toBe(engine.shell);
		expect(ours?.args).toEqual(engine.args);
		expect(Boolean(ours?.stdin)).toBe(engine.commandTransport === "stdin");
	});
});

describe("resolveValue", () => {
	it("runs a !command through the resolved shell", () => {
		expect(resolveValue("!echo hi", process.env, "probe")).toBe("hi");
	});

	it("names the failure when the command cannot run instead of blaming the command", () => {
		let message = "";
		try {
			resolveValue("!definitely-not-a-real-command-w21", process.env, "probe");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/^probe could not be read: /);
		expect(message).not.toContain("gave nothing");
		expect(message).toMatch(/could not run \(|exited with status|was stopped/);
	});

	it("reports a command that runs and gives nothing", () => {
		expect(() => resolveValue("!echo", process.env, "probe")).toThrow(
			"probe could not be read: its command gave nothing.",
		);
	});

	it("still resolves environment references and escapes", () => {
		expect(resolveValue("$NAME", { NAME: "value" }, "probe")).toBe("value");
		expect(resolveValue("${NAME}", { NAME: "value" }, "probe")).toBe("value");
		expect(resolveValue("$$", {}, "probe")).toBe("$");
		expect(resolveValue("$!", {}, "probe")).toBe("!");
		expect(() => resolveValue("$MISSING", {}, "probe")).toThrow(
			"probe needs the environment variable MISSING.",
		);
	});
});
