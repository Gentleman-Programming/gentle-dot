import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../src/process-tree.ts";

function taskkillProcess(code = 0): ChildProcess {
	const process = new EventEmitter() as ChildProcess;
	process.kill = vi.fn(() => true);
	queueMicrotask(() => process.emit("close", code, null));
	return process;
}

describe("terminateProcessTree", () => {
	it("uses bounded Windows tree termination and adds force only for hard escalation", async () => {
		const calls: { command: string; args: readonly string[]; windowsHide?: boolean }[] = [];
		const spawnTaskkill = vi.fn(
			(command: string, args: readonly string[], options: { windowsHide?: boolean }) => {
				calls.push({ command, args, windowsHide: options.windowsHide });
				return taskkillProcess();
			},
		);
		const child = { pid: 321 } as ChildProcess;

		await terminateProcessTree(child, false, { platform: "win32", spawnTaskkill });
		await terminateProcessTree(child, true, { platform: "win32", spawnTaskkill });

		expect(calls).toEqual([
			{ command: "taskkill.exe", args: ["/PID", "321", "/T"], windowsHide: true },
			{ command: "taskkill.exe", args: ["/PID", "321", "/F", "/T"], windowsHide: true },
		]);
	});

	it.each([undefined, 0, -1, 1.5, Number.NaN])("never invokes taskkill for invalid pid %s", async (pid) => {
		const spawnTaskkill = vi.fn(() => taskkillProcess());
		await expect(
			terminateProcessTree({ pid } as ChildProcess, false, { platform: "win32", spawnTaskkill }),
		).rejects.toThrow(/positive process id/i);
		expect(spawnTaskkill).not.toHaveBeenCalled();
	});

	it("rechecks ownership immediately before taskkill and skips a stale child", async () => {
		const spawnTaskkill = vi.fn(() => taskkillProcess());
		const ownership = [true, false];
		await expect(
			terminateProcessTree({ pid: 321 } as ChildProcess, false, {
				platform: "win32",
				spawnTaskkill,
				isCurrent: () => ownership.shift() ?? false,
			}),
		).resolves.toBe(false);
		expect(spawnTaskkill).not.toHaveBeenCalled();
	});

	it("allows a Windows tree command to finish after six seconds without timing out", async () => {
		vi.useFakeTimers();
		try {
			const taskkill = new EventEmitter() as ChildProcess;
			taskkill.kill = vi.fn(() => true);
			const result = terminateProcessTree({ pid: 321 } as ChildProcess, true, {
				platform: "win32",
				spawnTaskkill: () => {
					setTimeout(() => taskkill.emit("close", 0, null), 6500);
					return taskkill;
				},
			}).then(
				(value) => ({ value }),
				(error) => ({ error: String(error) }),
			);
			await vi.advanceTimersByTimeAsync(6500);
			expect(await result).toEqual({ value: true });
			expect(taskkill.kill).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("still bounds the default Windows taskkill command at ten seconds", async () => {
		vi.useFakeTimers();
		try {
			const taskkill = new EventEmitter() as ChildProcess;
			taskkill.kill = vi.fn(() => true);
			let failure: string | undefined;
			const result = terminateProcessTree({ pid: 321 } as ChildProcess, false, {
				platform: "win32",
				spawnTaskkill: () => taskkill,
			}).catch((error) => {
				failure = String(error);
			});
			await vi.advanceTimersByTimeAsync(9999);
			expect(failure).toBeUndefined();
			expect(taskkill.kill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await result;
			expect(failure).toMatch(/taskkill timed out/i);
			expect(taskkill.kill).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds a hung taskkill command", async () => {
		const taskkill = new EventEmitter() as ChildProcess;
		taskkill.kill = vi.fn(() => true);
		await expect(
			terminateProcessTree({ pid: 321 } as ChildProcess, false, {
				platform: "win32",
				commandTimeoutMs: 1,
				spawnTaskkill: () => taskkill,
			}),
		).rejects.toThrow(/taskkill timed out/i);
		expect(taskkill.kill).toHaveBeenCalledOnce();
	});

	it.each(["linux", "darwin"] as const)("keeps the existing %s signal path", async (platform) => {
		const kill = vi.fn(() => true);
		const child = { pid: 321, kill } as unknown as ChildProcess;
		await expect(terminateProcessTree(child, false, { platform })).resolves.toBe(true);
		await expect(terminateProcessTree(child, true, { platform })).resolves.toBe(true);
		expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});
});
