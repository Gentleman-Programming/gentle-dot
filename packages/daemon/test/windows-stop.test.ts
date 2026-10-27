import { describe, expect, it, vi } from "vitest";
import { startWithWindowsStop, windowsStopArtifact } from "../src/windows-stop.ts";

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
