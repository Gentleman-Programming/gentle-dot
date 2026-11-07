import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WindowsAppChannel, type WindowsAppChannelCloseResult } from "./windows-app-channel.ts";

interface StopListener {
	capability: Buffer;
	// Closing drops queued authenticated frames; close() is only reached during shutdown already in progress.
	close(): Promise<void>;
}
interface Stoppable {
	close(): Promise<void>;
	closed: Promise<void>;
}
interface RequestHandler {
	onRequest(frame: Buffer): void;
}
interface HandlerReference {
	deref(): RequestHandler | undefined;
}
interface StopOptions {
	platform?: NodeJS.Platform;
	/** Injection seams for deterministic portable tests. */
	loadNative?: () => unknown;
	handlerReference?: (handler: RequestHandler) => HandlerReference;
}

const FRAME_VERSION = Buffer.from("GDS1");
const HANDLER_LIFETIME = Symbol("Windows stop handler lifetime");
// Failed owners are deliberately retained, not forgotten because their Promise settled.
// No retries, record removal, or descendant-completion claims are implied by this set.
const failedWindowsOwners = new Set<object>();

/** A separate lexical scope ensures the native-rooted callback captures ONLY the weak reference. */
// Native delivers via a thread-safe function: an onRequest exception reaches napi_fatal_exception,
// terminating the process by design.
function weakRequestCallback(reference: HandlerReference): (frame: Buffer) => void {
	return (frame) => reference.deref()?.onRequest(frame);
}

async function closeDaemonAndListener(daemon: Stoppable, listener: StopListener): Promise<void> {
	let daemonFailed = false;
	let originalError: unknown;
	try {
		await daemon.close(); // daemon.closed is settlement, NOT successful cleanup.
	} catch (error) {
		daemonFailed = true;
		originalError = error;
	}
	try {
		await listener.close(); // Attempt drain independently, including after daemon failure.
	} catch (error) {
		if (!daemonFailed) throw error;
	}
	if (daemonFailed) throw originalError;
}

interface AppTransport {
	close(mode: "drain" | "abort"): Promise<WindowsAppChannelCloseResult>;
}

/** Supported Windows CLI route: native stop-record validation precedes fd3
 * adoption, and BOTH precede start/privateMemory/descendants. The record only
 * admits the managed launch route; the adopted connection authenticates app IPC.
 * Injection replaces orchestration participants, never production startup facts. */
export async function startWithWindowsAppChannel<
	T extends Stoppable,
	C extends AppTransport = WindowsAppChannel,
>(
	recordPath: string,
	start: (channel: C) => Promise<T>,
	options: StopOptions & { createAppChannel?: () => C } = {},
): Promise<{ daemon: T; close(): Promise<void>; closed: Promise<void> }> {
	const managed = await startWithWindowsStop(
		recordPath,
		async () => {
			const channel = options.createAppChannel
				? options.createAppChannel()
				: (new WindowsAppChannel({ exclusiveFd3Startup: true }) as unknown as C);
			let daemon: T;
			try {
				daemon = await start(channel);
			} catch (error) {
				try {
					await channel.close("abort");
				} catch {
					failedWindowsOwners.add(channel);
				}
				throw error;
			}
			let stopping: Promise<void> | undefined;
			const owner = {
				daemon,
				closed: daemon.closed,
				close(): Promise<void> {
					if (!stopping)
						stopping = Promise.resolve().then(async () => {
							let failed = false;
							let firstError: unknown;
							try {
								await daemon.close();
							} catch (error) {
								failed = true;
								firstError = error;
							}
							// Real daemon.close also drains its AppChannel. Idempotence keeps
							// this independent fallback safe, including partial close failure.
							try {
								const result = await channel.close("drain");
								if (result.mode !== "drain" || result.drained !== true)
									throw new Error("Windows app channel was not drained.");
							} catch (error) {
								if (!failed) {
									failed = true;
									firstError = error;
								}
							}
							if (failed) {
								failedWindowsOwners.add(owner);
								throw firstError;
							}
						});
					return stopping;
				},
			};
			return owner;
		},
		options,
	);
	return { daemon: managed.daemon.daemon, close: managed.close, closed: managed.closed };
}

/** Source lives in src/, while the bundle lives directly in daemon/. */
export function windowsStopArtifact(entry = new URL(import.meta.url)): URL {
	return new URL(
		entry.pathname.endsWith(".ts") ? "../native/windows-stop.node" : "./native/windows-stop.node",
		entry,
	);
}

/** The CLI's Windows exit arbiter observes the combined close/drain result, not daemon.closed. */
export function windowsShutdownExitCode(owner: { closed: Promise<void> }): Promise<0 | 1> {
	return owner.closed.then(
		() => 0,
		() => 1,
	);
}

/** Failure sets status and retains ownership; it must not force process termination. */
export async function finishWindowsShutdown(
	owner: { closed: Promise<void> },
	processLike: { exit(code: number): void; exitCode: NodeJS.Process["exitCode"] } = process,
	log: (line: string) => void = () => {},
): Promise<void> {
	if ((await windowsShutdownExitCode(owner)) === 0) {
		processLike.exit(0);
	} else {
		failedWindowsOwners.add(owner);
		processLike.exitCode = 1;
		log("the assistant did not stop cleanly; retaining failed owner");
	}
}

/**
 * Install the authenticated listener before start() can create descendants. Windows startup
 * always requires the private, exact-current-process record validated by the native module.
 * Neither its capability nor native exception details are sent to argv, env, or logs.
 */
export async function startWithWindowsStop<T extends Stoppable>(
	recordPath: string,
	start: () => Promise<T>,
	options: StopOptions = {},
): Promise<{ daemon: T; close(): Promise<void>; closed: Promise<void> }> {
	if ((options.platform ?? process.platform) !== "win32") {
		const daemon = await start();
		return { daemon, close: () => daemon.close(), closed: daemon.closed };
	}

	let ready!: (daemon: T) => void;
	let startupFailed!: (error: unknown) => void;
	const startup = new Promise<T>((resolve, reject) => {
		ready = resolve;
		startupFailed = reject;
	});
	let capability: Buffer | undefined;
	let listener: StopListener | undefined;
	let stopping: Promise<void> | undefined;
	let stopped!: () => void;
	let failed!: (error: unknown) => void;
	const closed = new Promise<void>((resolve, reject) => {
		stopped = resolve;
		failed = reject;
	});
	// Consumers attach after asynchronous startup; retain rejection without an unhandled window.
	void closed.catch(() => {});
	void startup.catch(() => {});
	const close = (): Promise<void> => {
		if (!stopping) {
			stopping = startup.then((daemon) => {
				// startup resolves only after the listener is assigned, so this guard never fires.
				const activeListener = listener;
				if (!activeListener) throw new Error("Windows stop listener missing after startup");
				return closeDaemonAndListener(daemon, activeListener);
			});
			void stopping.then(stopped, (error) => {
				failedWindowsOwners.add(lifetimeOwner);
				failed(error);
			});
		}
		return stopping;
	};

	// Native TSFN delivery is asynchronous. The injected synchronous factory seam may
	// deliver before it returns the capability: retain at most four correctly shaped
	// frames (144 bytes), then fail initialization rather than silently drop a stop.
	const preinitFrames: Buffer[] = [];
	let preinitOverflow = false;
	// Buffer.isBuffer, length/tag checks and timingSafeEqual on equal 32-byte lengths cannot throw
	// for any input; void close() only schedules asynchronous shutdown.
	const handler: RequestHandler = {
		onRequest(frame) {
			if (!Buffer.isBuffer(frame) || frame.length !== 36 || !frame.subarray(0, 4).equals(FRAME_VERSION))
				return;
			if (!capability) {
				if (preinitFrames.length < 4) preinitFrames.push(Buffer.from(frame));
				else preinitOverflow = true;
				return;
			}
			if (timingSafeEqual(frame.subarray(4), capability)) void close();
		},
	};
	// Explicit returned ownership keeps the handler alive; native owns only a weak association.
	const lifetimeOwner = { close, closed, [HANDLER_LIFETIME]: handler };
	const reference = options.handlerReference?.(handler) ?? new WeakRef(handler);
	const callback = weakRequestCallback(reference);
	try {
		const native = (
			options.loadNative ?? (() => createRequire(import.meta.url)(fileURLToPath(windowsStopArtifact())))
		)() as { createStopListener?: (path: string, callback: (frame: Buffer) => void) => StopListener };
		if (typeof native?.createStopListener !== "function") throw new Error("invalid addon");
		listener = native.createStopListener(recordPath, callback);
		if (
			!listener ||
			typeof listener.close !== "function" ||
			!Buffer.isBuffer(listener.capability) ||
			listener.capability.length !== 32 ||
			preinitOverflow
		) {
			throw new Error("invalid listener");
		}
		capability = Buffer.from(listener.capability);
	} catch {
		if (typeof listener?.close === "function") {
			try {
				await listener.close();
			} catch {
				failedWindowsOwners.add(lifetimeOwner);
			}
		}
		throw new Error("Windows stop listener initialization failed");
	}
	for (const frame of preinitFrames) handler.onRequest(frame);
	preinitFrames.length = 0;

	let daemon: T;
	try {
		daemon = await start();
	} catch (error) {
		startupFailed(error);
		// A partially started daemon is uncertain. Retain the owner and attempt drain.
		failedWindowsOwners.add(lifetimeOwner);
		try {
			await listener.close();
		} catch {
			/* Retained owner above; cleanup must not replace the startup failure. */
		}
		throw error;
	}
	ready(daemon);
	void daemon.closed.then(
		() => {
			void close();
		},
		() => {
			void close();
		},
	);
	return { daemon, ...lifetimeOwner };
}
