import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

/** Source lives in src/, while the bundle lives directly in daemon/. */
export function windowsStopArtifact(entry = new URL(import.meta.url)): URL {
	return new URL(
		entry.pathname.endsWith(".ts") ? "../native/windows-stop.node" : "./native/windows-stop.node",
		entry,
	);
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
			stopping = startup.then((daemon) => closeDaemonAndListener(daemon, listener as StopListener));
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
