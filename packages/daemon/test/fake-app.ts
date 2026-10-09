import { type Duplex, duplexPair } from "node:stream";
import { isAppCommand, parseClientMessage } from "@gentle-dot/protocol";

/** One approval the daemon asked the app for (the native dialog's content). */
export interface AskedApproval {
	connector: string;
	action: string;
	title?: string;
	summary?: string;
	preview: { name: string; value: unknown }[];
}

/** What the fake app answers: allow, decline, never answer, or hold until `release`. */
export type Answer = "allow" | "decline" | "hang" | "hold";

type Frame =
	| { kind: "request"; id: number; method: string; params?: unknown }
	| { kind: "response"; id: number; result?: unknown; error?: string };

/**
 * The desktop app's end of its private channel, for tests: the daemon gets `daemonEnd` (in
 * production the socket on fd 3), and the test drives the app's side with line-delimited JSON.
 */
export function fakeApp(answers: Answer[] = [], otherwise: Answer = "decline") {
	const [daemonEnd, appEnd] = duplexPair();
	const asked: AskedApproval[] = [];
	const queue = [...answers];
	const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	const held: number[] = [];
	let nextId = 0;
	let buffer = "";
	const write = (frame: Frame) => appEnd.write(`${JSON.stringify(frame)}\n`);
	appEnd.setEncoding("utf8");
	appEnd.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, end)) as Frame;
			buffer = buffer.slice(end + 1);
			if (frame.kind === "response") {
				const waiting = pending.get(frame.id);
				pending.delete(frame.id);
				if (frame.error !== undefined) waiting?.reject(new Error(frame.error));
				else waiting?.resolve(frame.result);
				continue;
			}
			if (frame.method !== "approve") {
				write({ kind: "response", id: frame.id, error: `unknown method ${frame.method}` });
				continue;
			}
			asked.push(frame.params as AskedApproval);
			const answer = queue.shift() ?? otherwise;
			if (answer === "hold") held.push(frame.id);
			else if (answer !== "hang")
				write({ kind: "response", id: frame.id, result: { approved: answer === "allow" } });
		}
	});
	const request = (method: string, params: unknown = {}) =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			write({ kind: "request", id, method, params });
		});
	return {
		daemonEnd: daemonEnd as Duplex,
		asked,
		/** Answers the oldest held approval, as a user clicking in the dialog later. */
		release: (approved: boolean) => {
			const id = held.shift();
			if (id !== undefined) write({ kind: "response", id, result: { approved } });
		},
		/** Queues the answers to the next approvals. */
		answer: (...next: Answer[]) => queue.push(...next),
		request,
		/** A privileged command on behalf of the window with `clientId` (its sign-in steps go there). */
		command: (clientId: string, message: object) => request("command", { clientId, message }),
		/** The app quits: its end of the channel closes (the daemon reads end of file). */
		close: () => appEnd.end(),
	};
}

/**
 * A window's `send` as the desktop panel does it: app commands go through the app's channel on
 * behalf of the window (`clientId`), the computer helper is registered by the app itself, and
 * everything else goes over the WebSocket.
 */
export function sendLikeThePanel(
	app: ReturnType<typeof fakeApp>,
	clientId: () => string,
	overWebSocket: (message: object) => void,
): (message: object) => void {
	return (message) => {
		const parsed = parseClientMessage(JSON.stringify(message));
		if (!parsed || !isAppCommand(parsed)) {
			overWebSocket(message);
			return;
		}
		const sent =
			parsed.type === "computer_register"
				? app.request("computer_register", { url: parsed.url, token: parsed.token })
				: parsed.type === "computer_unregister"
					? app.request("computer_unregister")
					: app.command(clientId(), message);
		void sent.catch(() => {});
	};
}
