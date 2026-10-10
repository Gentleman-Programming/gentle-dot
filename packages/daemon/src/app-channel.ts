/**
 * The desktop app's private channel (S25.1–S25.3, docs/design.md "Security"). The app that launches
 * the daemon creates a connected pair of Unix sockets and hands one end to the daemon as fd 3. That
 * connection is the authentication: nothing is written to a file or an environment variable, and
 * there is no listening socket another process could reach. A daemon the app only attached to, one
 * started from a terminal, and the web have no channel, so privileged actions fail closed there.
 *
 * Frames are line-delimited JSON, in both directions:
 *   {"kind":"request","id":1,"method":"command","params":{...}}
 *   {"kind":"response","id":1,"result":{...}}  or  {"kind":"response","id":1,"error":"..."}
 * Each side numbers its own requests. The app sends `command` (a privileged message on behalf of a
 * window), `computer_register`, and `computer_unregister`; the daemon sends `approve` (a native
 * dialog, answered `{approved}`).
 */
import { type StdioOptions, spawnSync } from "node:child_process";
import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Where the app puts its end of the channel. */
export const APP_FD = 3;
/** Longer than the app's own 120 s dialog timeout, which answers "declined" first. */
export const APPROVAL_WAIT_MS = 130_000;
/**
 * A frame longer than this closes the channel; nothing legitimate comes close. The app has the same
 * rule, and a closed channel stops the daemon (S35.2), so neither side ever sends a longer one: an
 * oversized request fails (an approval is refused) and an oversized answer becomes an error.
 */
const MAX_FRAME = 1024 * 1024;

/** One argument of the action, in the order shown. */
export interface PreviewField {
	name: string;
	value: unknown;
}

/** What the app shows in its native dialog (apps/desktop approvals::ApprovalRequest). */
export interface AppApproval {
	/** The connector's name, as the user knows it. */
	connector: string;
	/** What it will do ("create pages"). */
	action: string;
	preview: PreviewField[];
	/** Replaces "Allow <connector> to <action>?" for a change the user started (S25.3). */
	title?: string;
	/** Replaces "The assistant wants to <action> in <connector>.". */
	summary?: string;
}

/** The app as the bridge sees it: whether it is there, and its native approvals. */
export interface AppLink {
	readonly connected: boolean;
	/** True only when the user allowed it; declined, unanswered, or the app gone resolve false. */
	approve(request: AppApproval, signal?: AbortSignal): Promise<boolean>;
}

type Frame =
	| { kind: "request"; id: number; method: string; params?: unknown }
	| { kind: "response"; id: number; result?: unknown; error?: string };

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

export interface AppChannelOptions {
	log?: (line: string) => void;
	/** How long an approval waits for the app's answer. Default {@link APPROVAL_WAIT_MS}. */
	approvalWaitMs?: number;
}

export class AppChannel implements AppLink {
	/** Answers the app's requests; a thrown error goes back as the response's `error`. */
	handler: (method: string, params: unknown) => unknown = () => {
		throw new Error("The assistant is not ready yet.");
	};
	private readonly stream: Duplex;
	private readonly options: AppChannelOptions;
	private readonly pending = new Map<number, Pending>();
	private readonly closeListeners = new Set<() => void>();
	private buffer = "";
	private nextId = 0;
	private open = true;

	constructor(stream: Duplex, options: AppChannelOptions = {}) {
		this.stream = stream;
		this.options = options;
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => this.receive(chunk));
		stream.on("end", () => this.close());
		stream.on("close", () => this.close());
		stream.on("error", (error: Error) => {
			this.log(`the app's channel failed: ${error.message}`);
			this.close();
		});
	}

	get connected(): boolean {
		return this.open;
	}

	/** Calls `listener` once when the channel closes (the app quit, or it was closed here). */
	onClose(listener: () => void): () => void {
		if (!this.open) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (!this.open) return Promise.reject(new Error("The Gentle Dot app is not connected."));
		const id = ++this.nextId;
		const line = frameLine({ kind: "request", id, method, params });
		if (!line) return Promise.reject(new Error(`The request ${method} is too large for the Gentle Dot app.`));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The Gentle Dot app did not answer ${method} in time.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			if (this.open) this.stream.write(line);
		});
	}

	/** Rejects when there is no app to ask; every other failure is a refusal (fail closed). */
	approve(request: AppApproval, signal?: AbortSignal): Promise<boolean> {
		if (!this.open) return Promise.reject(new Error("The Gentle Dot app is not connected."));
		if (signal?.aborted) return Promise.resolve(false);
		const answer = this.request("approve", request, this.options.approvalWaitMs ?? APPROVAL_WAIT_MS).then(
			(result) => (result as { approved?: unknown } | undefined)?.approved === true,
			() => false,
		);
		if (!signal) return answer;
		const aborted = new Promise<boolean>((resolve) =>
			signal.addEventListener("abort", () => resolve(false), { once: true }),
		);
		return Promise.race([answer, aborted]);
	}

	close(): void {
		if (!this.open) return;
		this.open = false;
		this.stream.destroy();
		for (const [id, waiting] of this.pending) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error("The Gentle Dot app closed its channel."));
			this.pending.delete(id);
		}
		for (const listener of [...this.closeListeners]) listener();
		this.closeListeners.clear();
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (line.trim() !== "") this.onFrame(line);
			if (!this.open) return;
		}
		if (this.buffer.length > MAX_FRAME) {
			this.log("the app's channel sent a frame that is too long; closing it");
			this.close();
		}
	}

	private onFrame(line: string): void {
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch {
			this.log("the app's channel sent a frame that is not JSON; ignored");
			return;
		}
		if (typeof frame !== "object" || frame === null || typeof frame.id !== "number") return;
		if (frame.kind === "response") {
			const waiting = this.pending.get(frame.id);
			if (!waiting) return;
			this.pending.delete(frame.id);
			clearTimeout(waiting.timer);
			if (typeof frame.error === "string") waiting.reject(new Error(frame.error));
			else waiting.resolve(frame.result);
			return;
		}
		if (frame.kind !== "request" || typeof frame.method !== "string") return;
		const { id, method } = frame;
		Promise.resolve()
			.then(() => this.handler(method, frame.params))
			.then(
				(result) => this.write({ kind: "response", id, result: result ?? {} }),
				(error: Error) => this.write({ kind: "response", id, error: error.message }),
			);
	}

	private write(frame: Frame): void {
		const line =
			frameLine(frame) ??
			frameLine({ kind: "response", id: frame.id, error: "The answer is too large to send." });
		if (this.open && line) this.stream.write(line);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

/** The frame as one line, or undefined when it is longer than {@link MAX_FRAME}. */
function frameLine(frame: Frame): string | undefined {
	const json = JSON.stringify(frame);
	return Buffer.byteLength(json) > MAX_FRAME ? undefined : `${json}\n`;
}

/**
 * True when a child spawned the way the daemon spawns its children would hold the socket `identity`
 * (`dev:ino`) on `fd`. Node offers no way to mark an inherited descriptor close-on-exec; on macOS
 * libuv spawns with `POSIX_SPAWN_CLOEXEC_DEFAULT`, so children get only their stdio. This checks
 * that instead of assuming it.
 */
export function childInherits(
	fd: number,
	identity: string,
	stdio: StdioOptions = ["ignore", "pipe", "ignore"],
) {
	const script = `try{const s=require("fs").fstatSync(${fd},{bigint:true});process.stdout.write(s.dev+":"+s.ino)}catch{}`;
	const probe = spawnSync(process.execPath, ["-e", script], { stdio, encoding: "utf8", timeout: 10_000 });
	// A probe that could not run proves nothing: treat it as a leak.
	if (probe.error || probe.status !== 0) return true;
	return probe.stdout === identity;
}

export interface InheritedChannelOptions extends AppChannelOptions {
	fd?: number;
	/** Tests replace the inheritance check. */
	probe?: (fd: number, identity: string) => boolean;
}

/**
 * The socket the app handed over on fd 3, or undefined when there is none (it is not a socket, or it
 * is Node's own IPC channel). When a child would inherit it, it is closed and refused: an agent
 * holding it could act as the app.
 */
export function inheritedAppSocket(options: InheritedChannelOptions = {}): Socket | undefined {
	const fd = options.fd ?? APP_FD;
	if (process.env.NODE_CHANNEL_FD === String(fd)) return undefined;
	let identity: string;
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isSocket()) return undefined;
		identity = `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
	const inherits = options.probe ?? childInherits;
	if (inherits(fd, identity)) {
		options.log?.("the app's channel was refused: children would inherit it; connectors cannot be changed");
		closeSync(fd);
		return undefined;
	}
	return new Socket({ fd, readable: true, writable: true });
}

/** {@link inheritedAppSocket} as a channel. */
export function openInheritedChannel(options: InheritedChannelOptions = {}): AppChannel | undefined {
	const socket = inheritedAppSocket(options);
	return socket ? new AppChannel(socket, options) : undefined;
}
