/**
 * The daemon's thin client for an external channel bridge's local admin API (Channels, phase 1,
 * S9 of odd/tasks/channels-ux.md). The bridge (dot-whatsapp) is a separate opt-in process that
 * serves JSON on 127.0.0.1 with a bearer token in a 0600 file which IT re-reads per request;
 * this proxy mirrors that discipline: the token is read from disk on EVERY call, never cached.
 * The bridge is never spawned here (S9): when it does not answer, the channel shows as "off".
 *
 * The frozen endpoint contract lives in dot-whatsapp's odd/tasks/dot-whatsapp.md (S6).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelInfo, ChannelPairStatus } from "@gentle-dot/protocol";

/** The bridge admin API's status shape (S6); only the fields the UI needs cross here. */
interface BridgeStatus {
	state: "off" | "pairing" | "connected" | "error";
	provider: string;
	maskedNumber: string | null;
	lastActivityAt: string | null;
}

/** Raised when the bridge cannot be reached or refuses the call; `info()` never raises. */
export class ChannelBridgeUnavailable extends Error {}

export interface ChannelProxyOptions {
	port?: number;
	tokenFile?: string;
	timeoutMs?: number;
	log?(message: string): void;
}

export interface ChannelProxy {
	/** The channel's live state; an unreachable bridge is "off" with `reachable: false`. */
	info(): Promise<ChannelInfo>;
	allowlist(): Promise<string[]>;
	allowlistChange(action: "add" | "remove", number: string): Promise<string[]>;
	pairStart(): Promise<void>;
	/** `null` when the bridge is not pairing. */
	pairStatus(): Promise<ChannelPairStatus | null>;
	pairRegenerate(): Promise<void>;
	pairCancel(): Promise<void>;
	verify(): Promise<{ masked: string; ok: boolean }[]>;
	unpair(): Promise<void>;
}

export function createChannelProxy(options: ChannelProxyOptions = {}): ChannelProxy {
	const port = options.port ?? 4407;
	const tokenFile = options.tokenFile ?? join(homedir(), ".dot-whatsapp", "admin-token");
	const timeoutMs = options.timeoutMs ?? 1_500;
	const log = options.log ?? (() => {});
	const base = `http://127.0.0.1:${port}`;

	const token = (): string => readFileSync(tokenFile, "utf8").trim();

	/** One admin call; raises ChannelBridgeUnavailable on any failure. */
	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		let expected: string;
		try {
			expected = token();
		} catch {
			throw new ChannelBridgeUnavailable("the bridge admin token is not readable (is the bridge set up?)");
		}
		let response: Response;
		try {
			response = await fetch(`${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${expected}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new ChannelBridgeUnavailable(`the bridge did not answer: ${(error as Error).message}`);
		}
		if (!response.ok) {
			const detail = await response.json().catch(() => undefined);
			const message = (detail as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
			throw new ChannelBridgeUnavailable(`the bridge refused ${method} ${path}: ${message}`);
		}
		return (await response.json()) as T;
	};

	const act = async (method: string, path: string, body?: unknown): Promise<void> => {
		await call(method, path, body);
	};

	const toInfo = (status: BridgeStatus): ChannelInfo => ({
		id: "whatsapp",
		name: "WhatsApp",
		provider: status.provider === "meta-cloud" ? "meta-cloud" : "baileys",
		status: status.state,
		...(status.maskedNumber ? { maskedNumber: status.maskedNumber } : {}),
		...(status.lastActivityAt ? { lastActivityAt: status.lastActivityAt } : {}),
		...(status.state === "error"
			? { errorReason: "The bridge reported an error; unpair and pair again." }
			: {}),
		reachable: true,
	});

	const off = (): ChannelInfo => ({
		id: "whatsapp",
		name: "WhatsApp",
		provider: "baileys",
		status: "off",
		reachable: false,
	});

	return {
		async info() {
			try {
				return toInfo(await call<BridgeStatus>("GET", "/status"));
			} catch (error) {
				log(`channel probe failed: ${(error as Error).message}`);
				return off();
			}
		},
		async allowlist() {
			return (await call<{ numbers: string[] }>("GET", "/allowlist")).numbers;
		},
		async allowlistChange(action, number) {
			return (await call<{ numbers: string[] }>("POST", "/allowlist", { action, number })).numbers;
		},
		async pairStart() {
			await act("POST", "/pair/start");
		},
		async pairStatus() {
			const status = await call<{ qr: string | null; expiresInSec: number; attempts: number }>(
				"GET",
				"/pair/status",
			);
			return status.qr
				? { qr: status.qr, expiresInSec: status.expiresInSec, attempts: status.attempts }
				: null;
		},
		async pairRegenerate() {
			await act("POST", "/pair/regenerate");
		},
		async pairCancel() {
			await act("POST", "/pair/cancel");
		},
		async verify() {
			return (await call<{ results: { masked: string; ok: boolean }[] }>("POST", "/verify")).results;
		},
		async unpair() {
			await act("POST", "/unpair");
		},
	};
}
