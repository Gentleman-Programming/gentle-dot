// Both answers of both predicates, and the exact line the absent one prints, asserted on every OS:
// the host is injected, so nothing here depends on where the suite runs (W23's pattern). The
// announcement's channel is raw stderr, so the test captures `process.stderr.write` the way
// `fixture-capabilities.test.ts` does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { absenceLine, hasInheritedAppChannel, hasServerMode } from "./platform-absence.ts";

/** Captures the helper's skip announcements, which go to raw stderr (see the helper's comment). */
function captureStderr() {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a subject the host has", () => {
	it("answers true and prints nothing on Linux and on macOS", () => {
		const stderr = captureStderr();
		for (const host of ["linux", "darwin"] as const) {
			expect(hasInheritedAppChannel("the fd-3 suite", host)).toBe(true);
			expect(hasServerMode("the server-mode suite", host)).toBe(true);
		}
		expect(stderr).not.toHaveBeenCalled();
	});
});

describe("a subject Windows does not have", () => {
	it("answers false and names the subject, the reason and what Windows uses instead", () => {
		const stderr = captureStderr();

		expect(hasInheritedAppChannel("the app channel on fd 3 (S25.1)", "win32")).toBe(false);
		expect(stderr).toHaveBeenCalledTimes(1);
		const fd3 = String(stderr.mock.calls[0]?.[0]);
		expect(fd3).toBe(
			absenceLine(
				"the app channel on fd 3 (S25.1)",
				"Windows inherits no fd 3, and the app's channel there is the named pipe it names in " +
					"GENTLE_DOT_CHANNEL_PIPE (W7); app-channel-pipe.test.ts covers it on every platform",
			),
		);
		expect(fd3).toContain("platform-absence: skipping the app channel on fd 3 (S25.1)");
		expect(fd3).toContain("app-channel-pipe.test.ts");

		stderr.mockClear();
		expect(hasServerMode("server mode: the engine as another user (S25.8)", "win32")).toBe(false);
		expect(stderr).toHaveBeenCalledTimes(1);
		const serverMode = String(stderr.mock.calls[0]?.[0]);
		expect(serverMode).toBe(
			absenceLine(
				"server mode: the engine as another user (S25.8)",
				"Windows has no setuid/setegid, so the daemon never takes the engine's user; it runs the " +
					"desktop path (directAccess) instead",
			),
		);
		expect(serverMode).toContain("setuid/setegid");
		expect(serverMode).toContain("directAccess");
	});

	it("prints once per call, so a second gated suite cannot go silent behind the first", () => {
		const stderr = captureStderr();
		hasServerMode("the first suite", "win32");
		hasServerMode("the second suite", "win32");
		expect(stderr).toHaveBeenCalledTimes(2);
		expect(String(stderr.mock.calls[0]?.[0])).toContain("the first suite");
		expect(String(stderr.mock.calls[1]?.[0])).toContain("the second suite");
	});
});
