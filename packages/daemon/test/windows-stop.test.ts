import { describe, expect, it, vi } from "vitest";
import type { WindowsAppChannelCloseResult } from "../src/windows-app-channel.ts";
import * as stopModule from "../src/windows-stop.ts";
import { startWithWindowsStop, windowsShutdownExitCode, windowsStopArtifact } from "../src/windows-stop.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const capability = Buffer.alloc(32, 17);
	let deliver!: (frame: Buffer) => void;
	const listenerClose = vi.fn(async () => {});
	const nativeFactory = vi.fn((_path: string, callback: (frame: Buffer) => void) => {
		deliver = callback;
		return { capability, close: listenerClose };
	});
	const loadNative = vi.fn(() => ({ createStopListener: nativeFactory }));
	const done = deferred<void>();
	const close = vi.fn(async () => {
		done.resolve();
	});
	const daemon = { close, closed: done.promise };
	const frame = Buffer.concat([Buffer.from("GDS1"), capability]);
	return {
		loadNative,
		nativeFactory,
		listenerClose,
		daemon,
		done,
		frame,
		deliver: (frame: Buffer) => deliver(frame),
	};
}

describe("managed Windows fd3 startup orchestration", () => {
	it("a first abort cannot become successful managed drain or CLI exit zero", async () => {
		const f = fixture();
		let first: Promise<WindowsAppChannelCloseResult> | undefined;
		const channel = {
			close: vi.fn(
				(mode: "drain" | "abort") => (first ??= Promise.resolve({ mode, drained: mode === "drain" })),
			),
		};
		await channel.close("abort");
		const owner = await stopModule.startWithWindowsAppChannel("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
			createAppChannel: () => channel,
		});
		const processLike = { exit: vi.fn(), exitCode: undefined as number | undefined };
		const exitObserved = stopModule.finishWindowsShutdown(owner, processLike);
		await expect(owner.close()).rejects.toThrow("not drained");
		await expect(owner.closed).rejects.toThrow("not drained");
		await exitObserved;
		expect(channel.close.mock.calls.map((call) => call[0])).toEqual(["abort", "drain"]);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
		expect(processLike.exit).not.toHaveBeenCalled();
		expect(processLike.exitCode).toBe(1);
	});
	it.each<WindowsAppChannelCloseResult>([
		{ mode: "drain", drained: false },
		{ mode: "abort", drained: true },
	])("refuses incomplete or non-drain close result %j", async (result) => {
		const f = fixture();
		const channel = { close: vi.fn(async () => result) };
		const owner = await stopModule.startWithWindowsAppChannel("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
			createAppChannel: () => channel,
		});
		await expect(owner.close()).rejects.toThrow("not drained");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("preserves daemon failure over an earlier abort result and listener failure", async () => {
		const f = fixture();
		const failure = new Error("first daemon failure");
		f.daemon.close.mockRejectedValue(failure);
		f.listenerClose.mockRejectedValue(new Error("listener failure"));
		const aborted: WindowsAppChannelCloseResult = { mode: "abort", drained: false };
		const channel = { close: vi.fn(async () => aborted) };
		const owner = await stopModule.startWithWindowsAppChannel("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
			createAppChannel: () => channel,
		});
		await expect(owner.close()).rejects.toBe(failure);
		await expect(owner.closed).rejects.toBe(failure);
		expect(channel.close).toHaveBeenCalledExactlyOnceWith("drain");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("startup failure may abort successfully without certifying drain", async () => {
		const f = fixture();
		const failure = new Error("startup failure");
		const channel = {
			close: vi.fn(async (): Promise<WindowsAppChannelCloseResult> => ({ mode: "abort", drained: false })),
		};
		await expect(
			stopModule.startWithWindowsAppChannel(
				"data/daemon.pid",
				async () => {
					throw failure;
				},
				{ platform: "win32", loadNative: f.loadNative, createAppChannel: () => channel },
			),
		).rejects.toBe(failure);
		expect(channel.close).toHaveBeenCalledExactlyOnceWith("abort");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("validates listener, adopts, then starts; waits for channel and listener drain", async () => {
		const f = fixture();
		const order: string[] = [];
		const drain = deferred<WindowsAppChannelCloseResult>();
		const channel = { close: vi.fn(() => drain.promise) };
		const owner = await stopModule.startWithWindowsAppChannel(
			"data/daemon.pid",
			async (stream) => {
				order.push("start");
				expect(stream).toBe(channel);
				return f.daemon;
			},
			{
				platform: "win32",
				loadNative: () => {
					order.push("listener");
					return f.loadNative();
				},
				createAppChannel: () => {
					order.push("adopt");
					return channel;
				},
			},
		);
		expect(order).toEqual(["listener", "adopt", "start"]);
		const closed = owner.close();
		let finished = false;
		void closed.then(() => {
			finished = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(finished).toBe(false);
		drain.resolve({ mode: "drain", drained: true });
		await closed;
		expect(channel.close).toHaveBeenCalledExactlyOnceWith("drain");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("adoption failure refuses startup, drains listener, and preserves first failure", async () => {
		const f = fixture();
		const failure = new Error("missing or invalid fd3");
		const start = vi.fn();
		f.listenerClose.mockRejectedValue(new Error("listener drain failed"));
		await expect(
			stopModule.startWithWindowsAppChannel("data/daemon.pid", start, {
				platform: "win32",
				loadNative: f.loadNative,
				createAppChannel: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(start).not.toHaveBeenCalled();
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("startup failure independently aborts adopted channel and drains listener", async () => {
		const f = fixture();
		const failure = new Error("startup failed");
		const channel = {
			close: vi.fn(async () => {
				throw new Error("channel cleanup failed");
			}),
		};
		await expect(
			stopModule.startWithWindowsAppChannel(
				"data/daemon.pid",
				async () => {
					throw failure;
				},
				{ platform: "win32", loadNative: f.loadNative, createAppChannel: () => channel },
			),
		).rejects.toBe(failure);
		expect(channel.close).toHaveBeenCalledExactlyOnceWith("abort");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("attempts channel and listener cleanup after daemon failure and preserves it", async () => {
		const f = fixture();
		const failure = new Error("daemon failed");
		f.daemon.close.mockRejectedValue(failure);
		const channel = {
			close: vi.fn(async () => {
				throw new Error("channel drain failed");
			}),
		};
		const owner = await stopModule.startWithWindowsAppChannel("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
			createAppChannel: () => channel,
		});
		await expect(owner.close()).rejects.toBe(failure);
		await expect(owner.closed).rejects.toBe(failure);
		expect(channel.close).toHaveBeenCalledTimes(1);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
});

describe("Windows production stop bootstrap (S8, S10, S11)", () => {
	it("does not load native code on Unix", async () => {
		const f = fixture();
		const started = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "linux",
			loadNative: f.loadNative,
		});
		expect(f.loadNative).not.toHaveBeenCalled();
		expect(started.daemon).toBe(f.daemon);
	});
	it("creates the listener before startup and latches a stop during asynchronous startup", async () => {
		const f = fixture();
		const ready = deferred<typeof f.daemon>();
		const started = startWithWindowsStop(
			"data/daemon.pid",
			() => {
				expect(f.nativeFactory).toHaveBeenCalledWith("data/daemon.pid", expect.any(Function));
				f.deliver(f.frame);
				return ready.promise;
			},
			{ platform: "win32", loadNative: f.loadNative },
		);
		expect(f.daemon.close).not.toHaveBeenCalled();
		ready.resolve(f.daemon);
		const owner = await started;
		await owner.closed;
		expect(f.daemon.close).toHaveBeenCalledTimes(1);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
		expect(await windowsShutdownExitCode(owner)).toBe(0);
	});
	it("rejects wrong capability, version, short and extra frames without shutdown", async () => {
		const f = fixture();
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		for (const frame of [
			Buffer.concat([Buffer.from("GDS1"), Buffer.alloc(32)]),
			Buffer.concat([Buffer.from("GDS2"), f.frame.subarray(4)]),
			Buffer.concat([Buffer.from([0xc7, 0x44, 0x53, 0x31]), f.frame.subarray(4)]),
			f.frame.subarray(0, 35),
			Buffer.concat([f.frame, Buffer.alloc(1)]),
		])
			f.deliver(frame);
		await Promise.resolve();
		expect(f.daemon.close).not.toHaveBeenCalled();
		const first = owner.close();
		expect(owner.close()).toBe(first);
		f.deliver(f.frame);
		await first;
		expect(f.daemon.close).toHaveBeenCalledTimes(1);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("never throws from onRequest for hostile inputs", async () => {
		const f = fixture();
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		const callback = f.nativeFactory.mock.calls[0]?.[1] as (frame: unknown) => void;
		for (const input of [
			undefined,
			null,
			"GDS1",
			{},
			new Uint8Array(36),
			Buffer.alloc(0),
			f.frame.subarray(0, 35),
			Buffer.concat([f.frame, Buffer.alloc(1)]),
			Buffer.concat([Buffer.from("GDS2"), f.frame.subarray(4)]),
			Buffer.concat([Buffer.from("GDS1"), Buffer.alloc(32)]),
		])
			expect(() => callback(input)).not.toThrow();
		await Promise.resolve();
		expect(f.daemon.close).not.toHaveBeenCalled();
		expect(() => callback(f.frame)).not.toThrow();
		await owner.closed;
		expect(f.daemon.close).toHaveBeenCalledTimes(1);
	});
	it("observes the real close rejection even when daemon.closed reports settlement", async () => {
		const f = fixture();
		f.daemon.close.mockImplementation(async () => {
			f.done.resolve();
			throw new Error("close failed");
		});
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		f.done.resolve();
		await expect(owner.closed).rejects.toThrow("close failed");
		expect(await windowsShutdownExitCode(owner)).toBe(1);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("attempts drain after daemon failure and preserves the original error when both fail", async () => {
		const f = fixture();
		const original = new Error("daemon failure");
		f.daemon.close.mockRejectedValue(original);
		f.listenerClose.mockRejectedValue(new Error("secondary drain failure"));
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		await expect(owner.close()).rejects.toBe(original);
		await expect(owner.closed).rejects.toBe(original);
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("validates a synchronous factory frame after capability assignment and before startup completes", async () => {
		const f = fixture();
		const ready = deferred<typeof f.daemon>();
		const started = startWithWindowsStop("data/daemon.pid", () => ready.promise, {
			platform: "win32",
			loadNative: () => ({
				createStopListener: (_path: string, callback: (frame: Buffer) => void) => {
					callback(f.frame);
					return { capability: Buffer.from(f.frame.subarray(4)), close: f.listenerClose };
				},
			}),
		});
		expect(f.daemon.close).not.toHaveBeenCalled();
		ready.resolve(f.daemon);
		const owner = await started;
		await Promise.resolve();
		await Promise.resolve();
		expect(f.daemon.close).toHaveBeenCalledTimes(1);
		await owner.closed;
	});
	it("rejects unauthenticated synchronous frames without early shutdown but retains a later valid frame", async () => {
		const f = fixture();
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: () => ({
				createStopListener: (_path: string, callback: (frame: Buffer) => void) => {
					callback(f.frame.subarray(0, 35));
					callback(Buffer.concat([Buffer.from("GDS2"), f.frame.subarray(4)]));
					callback(Buffer.concat([Buffer.from("GDS1"), Buffer.alloc(32)]));
					expect(f.daemon.close).not.toHaveBeenCalled();
					callback(f.frame);
					return { capability: f.frame.subarray(4), close: f.listenerClose };
				},
			}),
		});
		await owner.closed;
		expect(f.daemon.close).toHaveBeenCalledTimes(1);
	});
	it("bounds synchronous preinitialization retention and fails closed on overflow", async () => {
		const f = fixture();
		const start = vi.fn(async () => f.daemon);
		await expect(
			startWithWindowsStop("data/daemon.pid", start, {
				platform: "win32",
				loadNative: () => ({
					createStopListener: (_path: string, callback: (frame: Buffer) => void) => {
						for (let count = 0; count < 5; count++) callback(f.frame);
						return { capability: f.frame.subarray(4), close: f.listenerClose };
					},
				}),
			}),
		).rejects.toThrow("Windows stop listener initialization failed");
		expect(start).not.toHaveBeenCalled();
		expect(f.daemon.close).not.toHaveBeenCalled();
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("dispatches only through the weak handler association while the owner retains its handler", async () => {
		const f = fixture();
		const deref = vi.fn();
		const associate = vi.fn((handler: { onRequest(frame: Buffer): void }) => {
			deref.mockReturnValue(handler);
			return { deref };
		});
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
			handlerReference: associate,
		});
		expect(associate).toHaveBeenCalledTimes(1);
		// Simulate a collected weak target without depending on GC scheduling.
		deref.mockReturnValue(undefined);
		f.deliver(f.frame);
		await Promise.resolve();
		expect(deref).toHaveBeenCalled();
		expect(f.daemon.close).not.toHaveBeenCalled();
		// The explicit owner still controls shutdown, independently of the native callback.
		await owner.close();
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("sets a failing CLI status without forcing exit, and exits zero only after success", async () => {
		const exit = vi.fn();
		const processLike = { exit, exitCode: undefined as number | undefined };
		const log = vi.fn();
		expect(stopModule.finishWindowsShutdown).toBeTypeOf("function");
		const f = fixture();
		f.daemon.close.mockRejectedValue(new Error("close failed"));
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		const observed = stopModule.finishWindowsShutdown(owner, processLike, log);
		await expect(owner.close()).rejects.toThrow("close failed");
		await observed;
		expect(processLike.exitCode).toBe(1);
		expect(exit).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("the assistant did not stop cleanly; retaining failed owner");
		const good = fixture();
		const success = await startWithWindowsStop("data/daemon.pid", async () => good.daemon, {
			platform: "win32",
			loadNative: good.loadNative,
		});
		const completed = stopModule.finishWindowsShutdown(success, processLike, log);
		await success.close();
		await completed;
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});
	it("does not force exit when native drain rejects", async () => {
		const f = fixture();
		f.listenerClose.mockRejectedValue(new Error("drain failed"));
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		const processLike = { exit: vi.fn(), exitCode: undefined as number | undefined };
		const observed = stopModule.finishWindowsShutdown(owner, processLike);
		await expect(owner.close()).rejects.toThrow("drain failed");
		await observed;
		expect(processLike.exitCode).toBe(1);
		expect(processLike.exit).not.toHaveBeenCalled();
	});
	it("propagates native drain failure instead of claiming shutdown succeeded", async () => {
		const f = fixture();
		f.listenerClose.mockRejectedValue(new Error("drain failed"));
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		await expect(owner.close()).rejects.toThrow("drain failed");
		await expect(owner.closed).rejects.toThrow("drain failed");
		expect(await windowsShutdownExitCode(owner)).toBe(1);
	});
	it("does not report success while native drain remains pending", async () => {
		const f = fixture();
		const drain = deferred<void>();
		f.listenerClose.mockImplementation(() => drain.promise);
		const owner = await startWithWindowsStop("data/daemon.pid", async () => f.daemon, {
			platform: "win32",
			loadNative: f.loadNative,
		});
		let exited = false;
		void windowsShutdownExitCode(owner).then(() => {
			exited = true;
		});
		const stopping = owner.close();
		await Promise.resolve();
		await Promise.resolve();
		expect(exited).toBe(false);
		drain.resolve();
		await stopping;
		expect(await windowsShutdownExitCode(owner)).toBe(0);
	});
	it.each(["missing module", "unsafe record"])("fails closed before startup: %s", async (reason) => {
		const start = vi.fn();
		await expect(
			startWithWindowsStop("data/daemon.pid", start, {
				platform: "win32",
				loadNative: () => {
					if (reason === "missing module") throw new Error(reason);
					return {
						createStopListener: () => {
							throw new Error(reason);
						},
					};
				},
			}),
		).rejects.toThrow("Windows stop listener initialization failed");
		expect(start).not.toHaveBeenCalled();
	});
	it("refuses a malformed native export or capability before startup", async () => {
		for (const native of [
			{},
			{ createStopListener: () => ({ capability: Buffer.alloc(31), close: async () => {} }) },
		]) {
			const start = vi.fn();
			await expect(
				startWithWindowsStop("data/daemon.pid", start, { platform: "win32", loadNative: () => native }),
			).rejects.toThrow("Windows stop listener initialization failed");
			expect(start).not.toHaveBeenCalled();
		}
	});
	it("drains the listener on startup failure without leaking native error details", async () => {
		const f = fixture();
		await expect(
			startWithWindowsStop(
				"data/daemon.pid",
				async () => {
					throw new Error("startup failed");
				},
				{ platform: "win32", loadNative: f.loadNative },
			),
		).rejects.toThrow("startup failed");
		expect(f.listenerClose).toHaveBeenCalledTimes(1);
	});
	it("preserves startup failure even when listener cleanup also fails", async () => {
		const f = fixture();
		f.listenerClose.mockRejectedValue(new Error("native private details"));
		await expect(
			startWithWindowsStop(
				"data/daemon.pid",
				async () => {
					throw new Error("startup failed");
				},
				{ platform: "win32", loadNative: f.loadNative },
			),
		).rejects.toThrow("startup failed");
	});
	it("uses the same native artifact relative to source and staged daemon entry", () => {
		expect(windowsStopArtifact(new URL("file:///repo/packages/daemon/src/windows-stop.ts")).pathname).toBe(
			"/repo/packages/daemon/native/windows-stop.node",
		);
		expect(windowsStopArtifact(new URL("file:///runtime/daemon/cli.mjs")).pathname).toBe(
			"/runtime/daemon/native/windows-stop.node",
		);
	});
});
