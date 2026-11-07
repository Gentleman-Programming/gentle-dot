import {
	McpAbortError,
	McpAuthRequiredError,
	McpConnectionClosedError,
	McpError,
	McpHttpError,
	McpTimeoutError,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { SecretsUnavailableError } from "./secret-source.ts";

export type ProxyStage =
	| "credentials"
	| "transport_create"
	| "connect"
	| "upstream_request"
	| "proxy_dispatch";
type Category =
	| "secrets_unavailable"
	| "auth_required"
	| "timeout"
	| "cancelled"
	| "connection_closed"
	| "http_error"
	| "rpc_error"
	| "system_error"
	| "proxy_refusal"
	| "unknown";
type Observation = "not_observed" | "connected_once" | "failed";
type Failure = { category: Category; code?: string | number };
const HINTS = [
	"stdio_incomplete_message",
	"stdio_message_limit",
	"invalid_jsonrpc_message",
	"unknown",
] as const;
type HintKind = (typeof HINTS)[number];
type Hint = { kind: HintKind; indicative: true; scope: "connection" };
type Entry = { server: string; observation: Observation; stage: ProxyStage; hint?: Hint } & Partial<Failure>;

/** Match only reviewed pi-mcp producer templates (unchanged in 1.4.0), transiently; never keep the error. */
function transportHint(error: unknown): HintKind {
	if (!(error instanceof Error)) return "unknown";
	const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
	if (typeof message !== "string") return "unknown";
	if (message === "MCP stdio server closed with an incomplete JSON-RPC message")
		return "stdio_incomplete_message";
	if (/^MCP stdio message exceeds [0-9]+ bytes$/.exec(message)?.[0] === message) return "stdio_message_limit";
	if (
		error instanceof McpError &&
		Object.getOwnPropertyDescriptor(error, "code")?.value === -32600 &&
		message === "Invalid JSON-RPC message"
	)
		return "invalid_jsonrpc_message";
	return "unknown";
}
export interface ProxySnapshot {
	source: "owned_proxy";
	coverage: "proxy_only";
	observation: Observation;
	entries: Entry[];
}
export type ProxyTrace = { generation: number } & (<T>(
	stage: ProxyStage,
	run: () => T | Promise<T>,
) => Promise<T>);

const SYSTEM = ["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"];
const HTTP = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504];
const RPC = [-32700, -32600, -32601, -32602, -32603];

/** Never inspect messages, wrappers, causes or arbitrary error properties. */
export function failure(error: unknown): Failure {
	if (error instanceof SecretsUnavailableError) return { category: "secrets_unavailable" };
	if (error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError)
		return { category: "auth_required" };
	if (error instanceof McpTimeoutError) return { category: "timeout" };
	if (error instanceof McpAbortError) return { category: "cancelled" };
	if (error instanceof McpConnectionClosedError) return { category: "connection_closed" };
	if (error instanceof McpHttpError)
		return { category: "http_error", ...(HTTP.includes(error.status) ? { code: error.status } : {}) };
	if (error instanceof McpError)
		return { category: "rpc_error", ...(RPC.includes(error.code) ? { code: error.code } : {}) };
	// Only a direct, data-valued system code on an Error; never invoke an arbitrary getter.
	const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
	if (typeof code === "string" && SYSTEM.includes(code)) return { category: "system_error", code };
	return { category: "unknown" };
}

const STARTUP = [
	"unknown",
	"executable_missing",
	"file_not_found",
	"access_denied",
	"package_unavailable",
	"module_missing",
	"dns_error",
	"connection_refused",
	"timeout",
	"tls_error",
	"auth_required",
	"transport_closed",
	"protocol_error",
	"http_error",
] as const;
type StartupKind = (typeof STARTUP)[number];
/** Inspect one bounded producer line transiently; return no original text. Hints are not proven causes. */
export function startupHint(line: unknown): StartupKind {
	if (typeof line !== "string" || line.length > 4096) return "unknown";
	if (
		/^(?:Error: Cannot find module |Error \[ERR_MODULE_NOT_FOUND\]: Cannot find (?:package|module) )/.test(
			line,
		)
	)
		return "module_missing";
	if (
		line === "MCP server requires authentication" ||
		/^MCP HTTP request failed with status (401|403)(?::|$)/.test(line)
	)
		return "auth_required";
	if (/^MCP HTTP request failed with status [0-9]{3}(?::|$)/.test(line)) return "http_error";
	if (line === "MCP connection closed") return "transport_closed";
	if (
		line === "Invalid JSON-RPC message" ||
		line === "Received invalid JSON-RPC message" ||
		line.startsWith("Unsupported MCP response content type: ")
	)
		return "protocol_error";
	const code =
		/^(?:npm (?:ERR!|error) code |(?:Error: )?(?:spawn(?:Sync)? \S+ |connect |getaddrinfo ))([A-Z][A-Z0-9_]+)(?:\s|$)/.exec(
			line,
		)?.[1];
	if (code === "ENOENT") return /^(?:Error: )?spawn/.test(line) ? "executable_missing" : "file_not_found";
	if (code === "EACCES" || code === "EPERM") return "access_denied";
	if (code === "E404" || code === "ETARGET" || code === "ENOTCACHED") return "package_unavailable";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
	if (code === "ECONNREFUSED") return "connection_refused";
	if (code === "ETIMEDOUT") return "timeout";
	if (
		[
			"CERT_HAS_EXPIRED",
			"SELF_SIGNED_CERT_IN_CHAIN",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		].includes(code ?? "")
	)
		return "tls_error";
	return "unknown";
}

/** Reconstruct only finite fields at the UI boundary; never forward callback extras. */
export function discordFailureFields(input?: unknown) {
	const v = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const stages: unknown[] = [
		"credentials",
		"transport_create",
		"connect",
		"upstream_request",
		"proxy_dispatch",
	];
	const categories: unknown[] = [
		"secrets_unavailable",
		"auth_required",
		"timeout",
		"cancelled",
		"connection_closed",
		"http_error",
		"rpc_error",
		"system_error",
		"proxy_refusal",
		"unknown",
	];
	return {
		failureStage: stages.includes(v.failureStage) ? (v.failureStage as string) : "unknown",
		failureCategory: categories.includes(v.failureCategory) ? (v.failureCategory as string) : "unknown",
		startupHint: (STARTUP as readonly unknown[]).includes(v.startupHint)
			? (v.startupHint as StartupKind)
			: "unknown",
		...((v.failureCategory === "system_error" &&
			typeof v.failureCode === "string" &&
			SYSTEM.includes(v.failureCode)) ||
		(v.failureCategory === "http_error" &&
			typeof v.failureCode === "number" &&
			HTTP.includes(v.failureCode)) ||
		(v.failureCategory === "rpc_error" && typeof v.failureCode === "number" && RPC.includes(v.failureCode))
			? { failureCode: v.failureCode }
			: {}),
	};
}

/** Bounded launch-local history, not connection health. Internal IDs/revisions never leave this store. */
export class ProxyDiagnostics {
	private generation = 0;
	private startupTicket = 0;
	private startup: { generation: number; revision: string; kind: StartupKind } | undefined;
	private readonly hints = new Map<string, { revision: string; hint: Hint }>();
	private readonly entries = new Map<string, { revision: string; entry: Entry }>();
	private readonly current: (id: string) => { revision: string; enabled: boolean } | undefined;
	constructor(current: (id: string) => { revision: string; enabled: boolean } | undefined) {
		this.current = current;
	}

	clear(): void {
		this.generation++;
		this.startup = undefined;
		this.entries.clear();
		this.hints.clear();
	}

	/** Only this callback's bounded partial line remains in process memory; only a finite hint is stored. */
	startupObserver(id: string, revision: string, generation: number): (chunk: string) => void {
		if (id !== "discord" || generation !== this.generation) return () => {};
		const ticket = ++this.startupTicket;
		this.startup = undefined;
		let tail = "";
		return (chunk) => {
			try {
				if (generation !== this.generation || ticket !== this.startupTicket) {
					tail = "";
					return;
				}
				const current = this.current(id);
				if (!current?.enabled || current.revision !== revision || typeof chunk !== "string") {
					tail = "";
					return;
				}
				const lines = (tail + chunk.slice(0, 8192)).split(/\r?\n/),
					last = lines.pop() ?? "";
				tail = chunk.length > 8192 || last.length > 2048 ? "" : last;
				for (const line of lines) {
					const kind = startupHint(line);
					if (kind !== "unknown" && !this.startup) this.startup = { generation, revision, kind };
				}
			} catch {
				tail = "";
			}
		};
	}

	/** Cached exact-Discord history, independent of a live connection; no credential-resolving read. */
	discordFailure() {
		const value = this.entries.get("discord"),
			entry = value?.entry,
			hint = this.startup;
		return discordFailureFields({
			failureStage: entry?.stage,
			failureCategory: entry?.category,
			failureCode: entry?.code,
			startupHint:
				hint?.generation === this.generation && (!value || hint.revision === value.revision)
					? hint.kind
					: "unknown",
		});
	}

	/** One connection observation, not a cause assigned to any concurrent request. */
	connection(id: string, revision: string, generation: number): (error: unknown) => void {
		if (generation === this.generation) this.hints.delete(id);
		return (error) => {
			try {
				if (generation !== this.generation) return;
				const current = this.current(id);
				if (!current?.enabled || current.revision !== revision) return;
				if (!this.hints.has(id) && this.hints.size === 32) this.hints.delete(this.hints.keys().next().value!);
				this.hints.set(id, {
					revision,
					hint: { kind: transportHint(error), indicative: true, scope: "connection" },
				});
			} catch {
				// Hostile error access must not affect the transport or retain the error.
			}
		};
	}

	/** Capture before request parsing/preflight can yield; this ticket never affects authorization. */
	ticket(): number {
		return this.generation;
	}

	attempt(
		id: string,
		revision: string,
		generation: number,
	): { trace: ProxyTrace; refusal: (unavailable: boolean) => void } {
		const record = (stage: ProxyStage, detail?: Failure) => {
			if (generation !== this.generation) return;
			const current = this.current(id);
			if (!current?.enabled || current.revision !== revision) return;
			let previous = this.entries.get(id);
			if (!previous) {
				if (this.entries.size === 32) this.entries.delete(this.entries.keys().next().value!);
				const used = new Set([...this.entries.values()].map(({ entry }) => entry.server));
				let alias = 1;
				while (used.has(`server-${alias}`)) alias++;
				previous = { revision, entry: { server: `server-${alias}`, observation: "not_observed", stage } };
			}
			this.entries.set(id, {
				revision,
				entry: {
					server: previous.entry.server,
					observation: detail ? "failed" : "connected_once",
					stage,
					...detail,
				},
			});
		};
		return {
			trace: Object.assign(
				async <T>(stage: ProxyStage, run: () => T | Promise<T>): Promise<T> => {
					try {
						const result = await run();
						if (stage === "connect") {
							try {
								record(stage);
							} catch {
								// Optional evidence must never change a successful proxy response.
							}
						}
						return result;
					} catch (error) {
						try {
							record(stage, failure(error));
						} catch {
							// Preserve the original error even for hostile error objects; never log them here.
						}
						throw error;
					}
				},
				{ generation },
			),
			refusal: (unavailable) => {
				try {
					const stage = unavailable ? "credentials" : "proxy_dispatch",
						detail: Failure = { category: unavailable ? "secrets_unavailable" : "proxy_refusal" };
					record(stage, detail);
				} catch {
					// Diagnostic collection cannot change existing refusal handling.
				}
			},
		};
	}

	/** Pure copies of history invalidated by the proxy's configuration sync; never resolve connector values. */
	snapshot(): ProxySnapshot {
		const entries = [...this.entries].map(([id, value]) => {
			const evidence = this.hints.get(id);
			return {
				...value.entry,
				...(evidence?.revision === value.revision ? { hint: { ...evidence.hint } } : {}),
			};
		});
		return {
			source: "owned_proxy",
			coverage: "proxy_only",
			observation: entries.some((e) => e.observation === "failed")
				? "failed"
				: entries.length
					? "connected_once"
					: "not_observed",
			entries,
		};
	}
}
