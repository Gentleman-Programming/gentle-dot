import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import {
	createWindowsAppChannelForTesting,
	isProductionWindowsAppChannel,
	type NativeAppChannelOwner,
	type NativeAppChannelSnapshot,
	WindowsAppChannel,
} from "../src/windows-app-channel.ts";

// These fakes verify JS orchestration only, not Windows adoption or native I/O.
const startupFacts = {
	mainThread: true,
	ipcChannel: false,
	ipcConnected: false,
	channelFdPresent: false,
	platform: "win32" as const,
};
function fixture() {
	const status: NativeAppChannelSnapshot = {
		phase: "open",
		error: 0,
		eof: false,
		pendingIo: true,
		readableBytes: 0,
		queuedBytes: 0,
		queuedItems: 0,
		acceptedWrite: 0n,
		completedWrite: 0n,
	};
	let bytes: Buffer = Buffer.alloc(0);
	let pressure = false;
	let uncertain = false;
	let released: NativeAppChannelSnapshot | undefined;
	const calls: string[] = [];
	const writes: Buffer[] = [];
	const owner: NativeAppChannelOwner = {
		status() {
			expect(this).toBe(owner);
			return { ...status };
		},
		poll() {
			expect(this).toBe(owner);
			calls.push("poll");
			return { ...status };
		},
		read(max) {
			expect(this).toBe(owner);
			calls.push("read");
			const result = bytes.subarray(0, max);
			bytes = bytes.subarray(result.length);
			status.readableBytes = bytes.length;
			return result;
		},
		write(chunk) {
			writes.push(chunk);
			expect(this).toBe(owner);
			calls.push(`write:${chunk.toString()}`);
			if (pressure) return { admission: "backpressure", ticket: 0n };
			status.acceptedWrite++;
			status.queuedBytes += chunk.length;
			status.queuedItems++;
			if (uncertain) throw new Error("allocation after acceptance");
			return { admission: "accepted", ticket: status.acceptedWrite };
		},
		stop(mode) {
			expect(this).toBe(owner);
			calls.push(`stop:${mode}`);
			if (status.phase === "open") status.phase = "stopping";
			return { ...status };
		},
		release() {
			expect(this).toBe(owner);
			calls.push("release");
			return released ?? { ...status };
		},
	};
	const factory = vi.fn(() => ({
		adoptAppChannelFd3: (reservation: true) => {
			expect(reservation).toBe(true);
			return owner;
		},
	}));
	const stream = () => {
		const result = createWindowsAppChannelForTesting(
			{ exclusiveFd3Startup: true, loadNative: factory, closeTimeoutMs: 100 },
			startupFacts,
		);
		result.on("error", () => {});
		return result;
	};
	return {
		status,
		calls,
		writes,
		factory,
		stream,
		data(value: Buffer) {
			bytes = value;
			status.readableBytes = bytes.length;
		},
		pressure(value: boolean) {
			pressure = value;
		},
		uncertain() {
			uncertain = true;
		},
		releaseReturns(snapshot: NativeAppChannelSnapshot) {
			released = snapshot;
		},
	};
}
async function tick() {
	await vi.advanceTimersByTimeAsync(10);
}
async function terminate(f: ReturnType<typeof fixture>, stream: WindowsAppChannel) {
	const closing = stream.close("abort");
	f.status.phase = "closed";
	f.status.pendingIo = false;
	await tick();
	await closing;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Windows app channel lifecycle integration", () => {
	it("decodes string writes into Buffer bytes before native admission", async () => {
		const f = fixture();
		const s = f.stream();
		s.write("é");
		expect(f.writes).toHaveLength(1);
		expect(Buffer.isBuffer(f.writes[0])).toBe(true);
		expect(f.writes[0]).toEqual(Buffer.from("é"));
		f.status.completedWrite = f.status.acceptedWrite;
		await tick();
		await terminate(f, s);
	});
	it("a first abort makes later AppChannel drain reject instead of certifying closure", async () => {
		const f = fixture();
		const s = f.stream();
		const app = new AppChannel(s);
		const aborted = s.close("abort");
		const closing = app.close();
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await expect(aborted).resolves.toEqual({ mode: "abort", drained: false });
		await expect(closing).rejects.toThrow("not drained");
		expect(app.close()).toBe(closing);
		expect(app.connected).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("logically refuses approvals before awaited native drain without recursive close", async () => {
		const f = fixture();
		const s = f.stream();
		const app = new AppChannel(s);
		const approval = app.approve({ connector: "test", action: "send", preview: [] });
		let notifications = 0;
		app.onClose(() => {
			notifications++;
			void app.close();
		});
		const closing = app.close();
		expect(app.connected).toBe(false);
		expect(notifications).toBe(1);
		await expect(approval).resolves.toBe(false);
		await expect(app.approve({ connector: "test", action: "send", preview: [] })).rejects.toThrow(
			"not connected",
		);
		let finished = false;
		void Promise.resolve(closing).then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		f.status.completedWrite = f.status.acceptedWrite;
		await tick();
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await closing;
		expect(notifications).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(["eof", "error"])(
		"unexpected native %s logically closes while disposal is still pending",
		async (cause) => {
			const f = fixture();
			const s = f.stream();
			const app = new AppChannel(s);
			const notify = vi.fn();
			app.onClose(notify);
			const approval = app.approve({ connector: "test", action: "send", preview: [] });
			if (cause === "eof") f.status.eof = true;
			else f.status.error = 123;
			await tick();
			expect(app.connected).toBe(false);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(f.calls).not.toContain("release");
			await expect(approval).resolves.toBe(false);
			f.status.phase = "closed";
			f.status.pendingIo = false;
			await tick();
			await expect(app.close()).rejects.toThrow();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("Windows app channel orchestration", () => {
	it("reads normally and leaves native bytes buffered under readable backpressure", async () => {
		const f = fixture();
		const s = f.stream();
		f.data(Buffer.alloc(65536, 65));
		s.read(0);
		await tick();
		expect(f.calls.filter((x) => x === "read")).toHaveLength(1);
		f.data(Buffer.from("later"));
		await tick();
		expect(f.calls.filter((x) => x === "read")).toHaveLength(1);
		expect(s.read(65536).length).toBe(65536);
		await tick();
		expect(s.read().toString()).toBe("later");
		await terminate(f, s);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("settles ordered writes only at completed BigInt tickets, not partial progress", async () => {
		const f = fixture();
		const s = f.stream();
		const callbacks: string[] = [];
		f.status.acceptedWrite = 9007199254740992n;
		f.status.completedWrite = f.status.acceptedWrite;
		s.write("one", () => callbacks.push("one"));
		s.write("two", () => callbacks.push("two"));
		await tick();
		expect(callbacks).toEqual([]);
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one"]);
		f.status.completedWrite++;
		await tick();
		expect(callbacks).toEqual(["one"]);
		f.status.completedWrite++;
		await tick();
		expect(callbacks).toEqual(["one", "two"]);
		await terminate(f, s);
	});
	it("retries queue-full only after capacity drops without discarding or reordering", async () => {
		const f = fixture();
		f.pressure(true);
		f.status.queuedBytes = 100;
		f.status.queuedItems = 64;
		const s = f.stream();
		s.write("one");
		s.write("two");
		await tick();
		await tick();
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one"]);
		f.pressure(false);
		f.status.queuedBytes = 0;
		f.status.queuedItems = 0;
		await tick();
		f.status.completedWrite = 1n;
		await tick();
		// Completing the first callback queues Node's next write without reentering
		// the active native poll. Admission occurs on the next scheduled poll.
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one", "write:one"]);
		await tick();
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one", "write:one", "write:two"]);
		await terminate(f, s);
	});
	it("preserves first native error and rejects undelivered callbacks", async () => {
		const f = fixture();
		const s = f.stream();
		const errors: Array<Error | null | undefined> = [];
		s.write("one", (e) => errors.push(e));
		s.write("two", (e) => errors.push(e));
		f.status.error = 123;
		await tick();
		f.status.error = 456;
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		expect(errors).toHaveLength(2);
		expect(errors.every((e) => e?.message.includes("123"))).toBe(true);
		await expect(s.close()).rejects.toThrow("123");
		expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
	});
	it("never retries a write whose thrown result could follow acceptance", async () => {
		const f = fixture();
		f.uncertain();
		const s = f.stream();
		s.write("one", () => {});
		await tick();
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one"]);
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await expect(s.close()).rejects.toThrow();
	});
	it("drain waits for Node queued writes and terminal delivery before release; close is idempotent", async () => {
		const f = fixture();
		const s = f.stream();
		s.write("one");
		s.write("two");
		const close = s.close();
		expect(s.close()).toBe(close);
		await tick();
		expect(f.calls).not.toContain("stop:drain");
		f.status.completedWrite = 1n;
		await tick();
		f.status.completedWrite = 2n;
		await tick();
		expect(f.calls).toContain("stop:drain");
		expect(f.calls).not.toContain("release");
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await expect(close).resolves.toEqual({ mode: "drain", drained: true });
		expect(vi.getTimerCount()).toBe(0);
	});
	it("rejects an interrupted drain even when admitted tickets were all completed", async () => {
		const f = fixture();
		const s = f.stream();
		const callbacks: Array<{ name: string; error: Error | null | undefined }> = [];
		s.write("one", (error) => callbacks.push({ name: "one", error }));
		s.write("two", (error) => callbacks.push({ name: "two", error }));
		f.status.completedWrite = 1n;
		const close = s.close("drain"); // settles one, but two is still only Node-buffered
		s.destroy();
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		expect(f.status.acceptedWrite).toBe(f.status.completedWrite);
		await expect(close).rejects.toThrow("drain interrupted");
		expect(s.close("abort")).toBe(close);
		expect(callbacks.map((x) => x.name)).toEqual(["one", "two"]);
		expect(callbacks[0]?.error == null).toBe(true);
		expect(callbacks[1]?.error?.message).toContain("drain interrupted");
		expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one"]);
		expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		await tick();
		expect(callbacks).toHaveLength(2);
	});
	it.each(["EOF", "native error"])(
		"settles delivered ticket before rejecting remaining work on terminal %s",
		async (cause) => {
			const f = fixture();
			const s = f.stream();
			const callbacks: Array<{ name: string; error: Error | null | undefined }> = [];
			s.write("one", (error) => callbacks.push({ name: "one", error }));
			s.write("two", (error) => callbacks.push({ name: "two", error }));
			f.status.completedWrite = 1n;
			if (cause === "EOF") f.status.eof = true;
			else f.status.error = 123;
			f.status.phase = "closed";
			f.status.pendingIo = false;
			await tick();
			const firstCause = cause === "EOF" ? "EOF" : "123";
			expect(callbacks.map((x) => x.name)).toEqual(["one", "two"]);
			expect(callbacks[0]?.error == null).toBe(true);
			expect(callbacks[1]?.error?.message).toContain(firstCause);
			expect(f.calls.filter((x) => x.startsWith("write:"))).toEqual(["write:one"]);
			f.status.error = 456;
			await tick();
			await expect(s.close()).rejects.toThrow(firstCause);
			expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
			expect(callbacks).toHaveLength(2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("abort is disposal, not successful drain", async () => {
		const f = fixture();
		const s = f.stream();
		s.write("one", () => {});
		const close = s.close("abort");
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await expect(close).resolves.toEqual({ mode: "abort", drained: false });
		expect(f.calls).toContain("release");
	});
	it("waits through the native stopping phase and certifies drain only at closed", async () => {
		const f = fixture();
		const s = f.stream();
		let settled = false;
		const close = s.close("drain");
		void close.then(
			() => (settled = true),
			() => (settled = true),
		);
		await tick();
		expect(f.calls).toContain("stop:drain");
		expect(f.status.phase).toBe("stopping");
		await tick();
		await tick();
		expect(settled).toBe(false);
		expect(f.calls).not.toContain("release");
		f.status.phase = "closed";
		f.status.pendingIo = false;
		await tick();
		await expect(close).resolves.toEqual({ mode: "drain", drained: true });
		expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
	});
	it("rejects drain at retained_failure even with every admitted ticket completed", async () => {
		const f = fixture();
		const s = f.stream();
		const close = s.close("drain");
		await tick();
		f.status.phase = "retained_failure";
		f.status.pendingIo = false;
		await tick();
		expect(f.status.acceptedWrite).toBe(f.status.completedWrite);
		await expect(close).rejects.toThrow("native ownership retained");
		expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("never takes release()'s pre-release snapshot as drain evidence", async () => {
		const drainedLooking: NativeAppChannelSnapshot = {
			phase: "closed",
			error: 0,
			eof: false,
			pendingIo: false,
			readableBytes: 0,
			queuedBytes: 0,
			queuedItems: 0,
			acceptedWrite: 0n,
			completedWrite: 0n,
		};
		const failed = fixture();
		failed.releaseReturns(drainedLooking);
		const failing = failed.stream().close("drain");
		await tick();
		failed.status.phase = "retained_failure";
		failed.status.pendingIo = false;
		await tick();
		await expect(failing).rejects.toThrow("native ownership retained");

		const drained = fixture();
		drained.releaseReturns({ ...drainedLooking, phase: "open", pendingIo: true, acceptedWrite: 5n });
		const draining = drained.stream().close("drain");
		await tick();
		drained.status.phase = "closed";
		drained.status.pendingIo = false;
		await tick();
		await expect(draining).resolves.toEqual({ mode: "drain", drained: true });
		expect(drained.calls.filter((x) => x === "release")).toHaveLength(1);
	});
	it("rejects false drain, EOF and deadline while safely disposing uncertain ownership", async () => {
		for (const cause of ["mismatch", "eof", "deadline"]) {
			const f = fixture();
			const s = f.stream();
			const close = s.close();
			if (cause === "mismatch") {
				f.status.phase = "closed";
				f.status.acceptedWrite = 1n;
			}
			if (cause === "eof") f.status.eof = true;
			await vi.advanceTimersByTimeAsync(100);
			await expect(close).rejects.toThrow();
			expect(f.calls.filter((x) => x === "release")).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	});
	it("rejects each injected visible IPC collision before loading or adoption", () => {
		for (const key of ["ipcChannel", "ipcConnected", "channelFdPresent"] as const) {
			const f = fixture();
			expect(() =>
				createWindowsAppChannelForTesting(
					{ exclusiveFd3Startup: true, loadNative: f.factory },
					{ ...startupFacts, [key]: true },
				),
			).toThrow("IPC");
			expect(f.factory).not.toHaveBeenCalled();
		}
	});
	it.each([undefined, null, 17])("rejects invalid JS test loader %s before construction", (loader) => {
		const f = fixture();
		// An independently invalid deadline makes RED safe: the old implementation
		// fails there before it could fall back to loading the real addon.
		const options = {
			exclusiveFd3Startup: true,
			closeTimeoutMs: 0,
			...(loader === undefined ? {} : { loadNative: loader }),
		};
		expect(() =>
			createWindowsAppChannelForTesting(
				options as unknown as Parameters<typeof createWindowsAppChannelForTesting>[0],
				startupFacts,
			),
		).toThrow("test loader");
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("production entry rejects injected loaders; a successful fake owner remains unbranded", async () => {
		const f = fixture();
		const injected = { exclusiveFd3Startup: true as const, loadNative: f.factory };
		// Injection is refused independently of host platform/IPC. No real loader
		// is invoked and no process facts are altered to simulate native proof.
		expect(() => new WindowsAppChannel(injected)).toThrow("does not accept an injected loader");
		expect(f.factory).not.toHaveBeenCalled();
		const s = f.stream();
		expect(f.factory).toHaveBeenCalledTimes(1);
		expect(isProductionWindowsAppChannel(s)).toBe(false);
		await terminate(f, s);
	});
	it("the real production loading route retains actual Vitest IPC refusal before artifact loading", () => {
		expect(
			Boolean(process.channel) || Boolean(process.connected) || process.env.NODE_CHANNEL_FD !== undefined,
		).toBe(true);
		expect(() => new WindowsAppChannel({ exclusiveFd3Startup: true })).toThrow("IPC");
	});
});
