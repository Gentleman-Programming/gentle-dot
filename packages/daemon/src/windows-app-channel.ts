import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { windowsStopArtifact } from "./windows-stop.ts";

export interface NativeAppChannelSnapshot {
	phase: "open" | "stopping" | "closed" | "retained_failure";
	error: number;
	eof: boolean;
	pendingIo: boolean;
	readableBytes: number;
	queuedBytes: number;
	queuedItems: number;
	acceptedWrite: bigint;
	completedWrite: bigint;
}
export interface NativeAppChannelOwner {
	poll(): NativeAppChannelSnapshot;
	status(): NativeAppChannelSnapshot;
	read(maxBytes: number): Buffer;
	write(bytes: Buffer): {
		admission: "accepted" | "backpressure" | "stopped" | "invalid" | "allocation_failed";
		ticket: bigint;
	};
	stop(mode: "drain" | "abort"): NativeAppChannelSnapshot;
	/** Returns PRE-disposal status. No method is legal after successful release. */
	release(): NativeAppChannelSnapshot;
}
export interface NativeAppChannelAPI {
	adoptAppChannelFd3(exclusiveStartupReservation: true): NativeAppChannelOwner;
}
export interface WindowsAppChannelOptions {
	/** Caller MUST reserve fd3 exclusively, on the main startup loop, before ANY spawn.
	 * This assertion and absence of visible IPC do not prove absence of aliases. */
	exclusiveFd3Startup: true;
	closeTimeoutMs?: number;
}
export interface WindowsAppChannelCloseResult {
	mode: "drain" | "abort";
	/** Delivery means ordered native completion, NOT a peer protocol acknowledgement. */
	drained: boolean;
}
// If release throws before disposal (e.g. snapshot OOM), retain the exact owner.
// Successful emergency release delegates uncertain I/O lifetime to native quarantine.
const retainedOwners = new Set<NativeAppChannelOwner>();
type WriteCallback = (error?: Error | null) => void;
const productionChannels = new WeakSet<object>();

/** Only production construction with actual startup facts and successful native
 * ownership transfer admits Windows descendants. Not a child-inspection proof. */
export function isProductionWindowsAppChannel(stream: object): stream is WindowsAppChannel {
	return (
		productionChannels.has(stream) &&
		stream instanceof WindowsAppChannel &&
		!stream.destroyed &&
		!stream.writableEnded
	);
}

/** Includes the portable adapter test seam; used only to await transport cleanup. */
export function isWindowsAppChannel(stream: object): stream is WindowsAppChannel {
	return stream instanceof WindowsAppChannelDuplex;
}

/** Explicit Windows-only Duplex. Importing this module neither loads nor adopts fd3.
 * All native methods run synchronously on this JS loop with their original receiver.
 * close(drain) ends/flushed Node's writable queue before requesting native drain;
 * close(abort) may discard undelivered writes and NEVER certifies drain.
 * First close wins. Deadline/error rejects, disposes into native quarantine, and
 * never forces process exit. Native env cleanup handles environment destruction. */
interface StartupFacts {
	mainThread: boolean;
	ipcChannel: boolean;
	ipcConnected: boolean;
	channelFdPresent: boolean;
	platform: NodeJS.Platform;
}

/** Orchestration-only seam: always requires an injected fake addon and startup
 * facts. Production construction above never accepts injected startup facts. */
export function createWindowsAppChannelForTesting(
	options: WindowsAppChannelOptions & { loadNative: () => NativeAppChannelAPI },
	facts: StartupFacts,
): WindowsAppChannel {
	if (typeof options?.loadNative !== "function")
		throw new TypeError("App channel test loader must be a function");
	return new WindowsAppChannelDuplex(options, facts, options.loadNative);
}

class WindowsAppChannelDuplex extends Duplex {
	#owner: NativeAppChannelOwner;
	#snapshot: NativeAppChannelSnapshot;
	#timeoutMs: number;
	#pollTimer?: NodeJS.Timeout;
	#deadline?: NodeJS.Timeout;
	#reading = false;
	#driving = false;
	#disposed = false;
	#stopping = false;
	#failure?: Error;
	#abortError?: Error;
	#write?: { bytes: Buffer; callback: WriteCallback; ticket?: bigint; capacity?: [number, number] };
	#final?: WriteCallback;
	#close?: Promise<WindowsAppChannelCloseResult>;
	#resolve?: (result: WindowsAppChannelCloseResult) => void;
	#reject?: (error: Error) => void;
	#mode: "drain" | "abort" = "abort";

	constructor(options: WindowsAppChannelOptions, facts: StartupFacts, loadNative: () => NativeAppChannelAPI) {
		super({
			readableHighWaterMark: 65536,
			writableHighWaterMark: 65536,
			autoDestroy: true,
			// _write relies on Buffer chunks: byte length matches the native 2 MiB limit.
			decodeStrings: true,
		});
		if (options.exclusiveFd3Startup !== true || !facts.mainThread)
			throw new Error("Exclusive main-thread fd3 startup required");
		if (facts.ipcChannel || facts.ipcConnected || facts.channelFdPresent)
			throw new Error("App channel startup IPC collision");
		if (facts.platform !== "win32") throw new Error("Windows app channel requires Windows");
		this.#timeoutMs = options.closeTimeoutMs ?? 5000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
			throw new Error("Invalid app channel close deadline");
		const native = loadNative();
		if (typeof native?.adoptAppChannelFd3 !== "function")
			throw new Error("Windows app channel addon unavailable");
		this.#owner = native.adoptAppChannelFd3(true);
		try {
			this.#snapshot = this.#owner.status();
			if (this.#snapshot.phase !== "open" || this.#snapshot.error || this.#snapshot.eof)
				throw new Error("Windows app channel ownership initialization failed");
		} catch (error) {
			try {
				this.#owner.stop("abort");
			} catch {
				/* release retains uncertain native ownership */
			}
			this.dispose();
			throw error;
		}
		this.schedule();
	}

	close(mode: "drain" | "abort" = "drain"): Promise<WindowsAppChannelCloseResult> {
		if (this.#close) return this.#close;
		this.#mode = mode;
		this.#close = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		void this.#close.catch(() => {}); // observed even when destroy initiated close
		if (this.#disposed) {
			this.#reject?.(this.#failure ?? new Error("App channel already disposed"));
			return this.#close;
		}
		this.#deadline = setTimeout(() => {
			this.#failure ??= new Error("App channel close deadline exceeded");
			this.finish(false);
		}, this.#timeoutMs);
		if (mode === "drain" && !this.#failure) this.end();
		else {
			this.#abortError ??= new Error("App channel aborted");
			this.rejectWrite(this.#failure ?? this.#abortError);
			this.stop("abort");
		}
		this.drive();
		return this.#close;
	}

	override _read(): void {
		this.#reading = true;
		this.drive();
	}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
		if (this.#disposed || this.#stopping || this.#failure) {
			callback(this.#failure ?? new Error("App channel stopped"));
			return;
		}
		if (!chunk.length) {
			callback();
			return;
		}
		if (chunk.length > 2 * 1024 * 1024) {
			callback(new Error("App channel write exceeds 2 MiB"));
			return;
		}
		this.#write = { bytes: chunk, callback };
		this.drive();
	}
	override _final(callback: WriteCallback): void {
		this.#final = callback;
		if (!this.#close) void this.close("drain");
		this.stop("drain");
		this.drive();
	}
	override _destroy(error: Error | null, callback: WriteCallback): void {
		if (error !== this.#abortError) this.#failure ??= error ?? undefined;
		if (!this.#disposed) {
			// Aborting an existing drain can discard Node-buffered writes whose
			// bytes have no native ticket. Ticket equality cannot certify that drain.
			if (this.#close && this.#mode === "drain")
				this.#failure ??= new Error("App channel drain interrupted by destruction");
			if (!this.#close) void this.close("abort");
			else {
				this.rejectWrite(this.#failure ?? new Error("App channel aborted"));
				this.stop("abort");
				this.schedule();
			}
		}
		callback(this.#failure ?? error);
	}

	private observe(status: NativeAppChannelSnapshot): void {
		this.#snapshot = status;
		if (status.error) this.#failure ??= new Error(`Windows app channel native error ${status.error}`);
		else if (status.eof) this.#failure ??= new Error("App channel EOF");
		else if (status.phase === "retained_failure")
			this.#failure ??= new Error("App channel native ownership retained");
	}
	private stop(mode: "drain" | "abort"): void {
		if (this.#disposed || (this.#stopping && mode === "drain")) return;
		this.#stopping = true;
		try {
			this.observe(this.#owner.stop(mode));
		} catch {
			this.#failure ??= new Error("App channel stop failed");
		}
	}
	private drive(): void {
		if (this.#disposed || this.#driving) return;
		this.#driving = true;
		try {
			this.observe(this.#owner.poll());
			if (this.#failure) {
				// observe() has already bound the first failure, so callback reentry
				// cannot admit new writes. Completion still certifies an earlier ticket.
				const delivered = this.#write;
				if (delivered?.ticket !== undefined && delivered.ticket <= this.#snapshot.completedWrite) {
					this.#write = undefined;
					delivered.callback();
				}
				this.rejectWrite(this.#failure);
				if (!this.#close) void this.close("abort");
				this.stop("abort");
				this.destroy(this.#failure);
			}
			const pending = this.#write;
			if (pending && !this.#failure && !this.#stopping) {
				if (
					pending.ticket === undefined &&
					(!pending.capacity ||
						this.#snapshot.queuedBytes < pending.capacity[0] ||
						this.#snapshot.queuedItems < pending.capacity[1])
				) {
					const admission = this.#owner.write(pending.bytes);
					if (admission.admission === "accepted") pending.ticket = admission.ticket;
					else if (admission.admission === "backpressure")
						pending.capacity = [this.#snapshot.queuedBytes, this.#snapshot.queuedItems];
					else throw new Error("App channel write admission failed");
				}
				if (pending.ticket !== undefined && pending.ticket <= this.#snapshot.completedWrite) {
					this.#write = undefined;
					pending.callback();
				}
			}
			if (this.#reading && !this.#stopping && !this.#failure && this.#snapshot.readableBytes) {
				const bytes = this.#owner.read(65536);
				if (bytes.length) this.#reading = this.push(bytes);
			}
			if (this.#snapshot.phase === "closed" || this.#snapshot.phase === "retained_failure") {
				if (!this.#close) {
					this.#failure ??= new Error("App channel closed unexpectedly");
					void this.close("abort");
				}
				const drained =
					this.#mode === "drain" &&
					!this.#failure &&
					this.#snapshot.phase === "closed" &&
					this.#snapshot.acceptedWrite === this.#snapshot.completedWrite;
				if (this.#mode === "drain" && !drained)
					this.#failure ??= new Error("App channel writes were not drained");
				this.finish(drained);
			}
		} catch {
			// write() may have accepted before an envelope/BigInt allocation throws.
			// Inspect for the first native error, but NEVER retry the uncertain bytes.
			try {
				this.observe(this.#owner.status());
			} catch {
				/* retain prior evidence */
			}
			this.#failure ??= new Error("App channel native operation failed");
			this.rejectWrite(this.#failure);
			if (!this.#close) void this.close("abort");
			this.stop("abort");
			this.destroy(this.#failure);
		} finally {
			this.#driving = false;
			this.schedule();
		}
	}
	private schedule(): void {
		if (this.#disposed || this.#pollTimer) return;
		// A pending read is active I/O, not idle spinning. When the native read
		// buffer is full and JS is paused, leave it bounded until _read resumes.
		if (!this.#stopping && !this.#write && !this.#snapshot.pendingIo && !this.#reading) return;
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = undefined;
			this.drive();
		}, 10);
	}
	private rejectWrite(error: Error): void {
		const pending = this.#write;
		this.#write = undefined;
		pending?.callback(error);
	}
	private dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#pollTimer);
		clearTimeout(this.#deadline);
		this.#pollTimer = this.#deadline = undefined;
		try {
			this.#owner.release();
		} catch {
			retainedOwners.add(this.#owner);
			this.#failure ??= new Error("App channel disposal failed");
		}
	}
	private finish(drained: boolean): void {
		if (this.#disposed) return;
		this.dispose(); // release is NEVER the evidence for drain
		this.rejectWrite(this.#failure ?? new Error("App channel closed"));
		const final = this.#final;
		this.#final = undefined;
		final?.(this.#failure);
		if (this.#failure) this.#reject?.(this.#failure);
		else this.#resolve?.({ mode: this.#mode, drained });
		this.destroy(this.#failure);
	}
}

/** Production entry: actual process facts and the default artifact loader are
 * mandatory. Injected participants belong only to the unbranded test factory. */
export class WindowsAppChannel extends WindowsAppChannelDuplex {
	constructor(options: WindowsAppChannelOptions) {
		// Refuse injection even from untyped JS or a structurally compatible object.
		// No caller-provided loader/boolean can mint production ownership admission.
		if ("loadNative" in options) throw new Error("Production app channel does not accept an injected loader");
		super(
			options,
			{
				mainThread: isMainThread,
				ipcChannel: Boolean(process.channel),
				ipcConnected: Boolean(process.connected),
				channelFdPresent: process.env.NODE_CHANNEL_FD !== undefined,
				platform: process.platform,
			},
			() => createRequire(import.meta.url)(fileURLToPath(windowsStopArtifact())) as NativeAppChannelAPI,
		);
		productionChannels.add(this);
	}
}
