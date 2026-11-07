import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { guidanceFor } from "./diagnostic-guidance.ts";

export const REVIEW_STATUS_TOOL = "dot_review_status";
type StatusRequest = { cwd: string; operation: "status"; signal?: AbortSignal };
type StatusClient = { reviewMode?: (request: StatusRequest) => Promise<unknown> };
type ClientFactory = () => Promise<StatusClient>;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only callability is promised here; the returned status still requires validation. */
function statusMethod(
	value: unknown,
): value is (this: Record<string, unknown>, request: StatusRequest) => unknown {
	return typeof value === "function";
}

function incompatible(): never {
	throw Object.assign(new Error("Incompatible native status client"), { code: "schema-incompatible" });
}

/** Validate the generated JavaScript boundary; never assert unverified package types. */
export function reviewClientFromModule(namespace: unknown): StatusClient {
	if (
		!record(namespace) ||
		typeof namespace.createNativeReviewCli !== "function" ||
		typeof namespace.createNodeExecFileAdapter !== "function"
	)
		incompatible();
	const createAdapter = namespace.createNodeExecFileAdapter;
	const createClient = namespace.createNativeReviewCli;
	const adapter: unknown = createAdapter();
	if (typeof adapter !== "function") incompatible();
	let hint: IndicativeHint | undefined;
	const observed = async (request: unknown): Promise<unknown> => {
		// Preserve all resolver/process options and both object identities, exactly once.
		const result: unknown = await adapter(request);
		if (record(request) && Array.isArray(request.arguments) && record(result)) {
			const args: unknown[] = request.arguments;
			if (
				args.length === 6 &&
				args[0] === "review" &&
				args[1] === "mode" &&
				args[2] === "status" &&
				args[3] === "--cwd" &&
				args[4] === request.cwd &&
				args[5] === "--json"
			) {
				hint =
					typeof result.exitCode === "number" &&
					result.exitCode !== 0 &&
					!result.timedOut &&
					!result.outputLimitExceeded &&
					!result.signal &&
					typeof result.stderr === "string"
						? indicativeHint(result.stderr)
						: undefined;
			}
		}
		return result;
	};
	const client: unknown = createClient(observed);
	if (!record(client)) incompatible();
	const reviewMode = client.reviewMode;
	if (!statusMethod(reviewMode)) return {};
	return {
		reviewMode: async (request: StatusRequest): Promise<unknown> => {
			if (
				!record(request) ||
				request.operation !== "status" ||
				typeof request.cwd !== "string" ||
				Object.keys(request).some((key) => !["cwd", "operation", "signal"].includes(key))
			)
				incompatible();
			try {
				return await reviewMode.call(client, request);
			} catch (error) {
				const details = safeError(error);
				throw new ObservedFailure({
					...details,
					...(details.category === "non-zero" && hint ? { indicativeHint: hint } : {}),
				});
			}
		},
	};
}

// Only invocation loads generated runtime JS. Validate that boundary as unknown rather than
// asserting package-specific implementation types in the daemon's strict program.
const nativeClient: ClientFactory = async () => {
	const specifier = "gentle-pi/runtime/native-review-cli.mjs";
	const namespace: unknown = await import(specifier);
	return reviewClientFromModule(namespace);
};

const ERROR_CODES = new Set([
	"unavailable",
	"timeout",
	"non-zero",
	"signal",
	"unexpected-stderr",
	"output-limit",
	"empty-output",
	"malformed-json",
	"schema-incompatible",
	"identity-mismatch",
	"version-incompatible",
	"cancelled",
	"package-local-binary-missing",
	"unsupported-transition-operation",
]);

function failure(category: string) {
	return { ok: false as const, readOnly: true as const, category };
}

type IndicativeHint = "unreadable_mode_value" | "unsafe_clone_mode_path" | "git_unavailable";

// Source-template indications only; no native reason codes or repair authority.
function indicativeHint(stderr: string): IndicativeHint | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject every ASCII control character in untrusted native diagnostic text.
	if (stderr.length > 8192 || /[\r\n\x00-\x1f\x7f]/.test(stderr.trimEnd())) return;
	const text = stderr.trim().replace(/^Error: /, "");
	const unreadable =
		"an unreadable switch is not a disabled switch, so receipt-driven development stays managed until the value is overwritten: run ";
	const unsafe = "the clone-local review mode path ";
	// Public Go/native producer templates, not a native reason code or an installation test.
	const repository = "resolve review mode repository identity: ";
	const git = 'exec: "git": executable file not found in %PATH%';
	if (
		text.startsWith(repository) &&
		text.endsWith(git) &&
		text.split(repository).length === 2 &&
		text.split(git).length === 2 &&
		!text.includes(unsafe) &&
		!text.includes(unreadable)
	)
		return "git_unavailable";
	const parts = text.split(unreadable);
	if (
		!text.includes(unsafe) &&
		parts.length === 2 &&
		/^(?:the (?:global|clone-local) value in .+ is not a mode this product can read; |both review mode sources hold a value this product cannot read as a mode: .+; )$/.test(
			parts[0]!,
		)
	) {
		// Match source command structure, never execute or return its dynamic cwd.
		const commands = (verb: string, repo: string) => {
			const global = "`gentle-ai review mode " + verb + " --scope=global`";
			const clone = "`gentle-ai review mode " + verb + " --scope=clone --cwd " + repo + "`";
			return parts[0]!.startsWith("both ")
				? global + " and " + clone
				: parts[0]!.startsWith("the global ")
					? global
					: clone;
		};
		const tail =
			commands("enable", "(?<repo>[^`]+)") +
			" to turn reviews on, or " +
			commands("disable", "\\k<repo>") +
			" to turn them off";
		if (new RegExp("^" + tail + "$").test(parts[1]!)) return "unreadable_mode_value";
	}
	if (
		!text.includes(unreadable) &&
		text.split(unsafe).length === 2 &&
		/^the clone-local review mode path "[^"\r\n]+" is unsafe; run `[^`]+`(?: in a NON-ELEVATED Windows PowerShell 5\.1 shell because an elevated TokenOwner can differ from the current user)?, then rerun the original command$/.test(
			text,
		)
	)
		return "unsafe_clone_mode_path";
}

class ObservedFailure {
	readonly details: ReturnType<typeof failure> & { indicativeHint?: IndicativeHint };
	constructor(details: ReturnType<typeof failure> & { indicativeHint?: IndicativeHint }) {
		this.details = details;
	}
}

function safeError(error: unknown) {
	if (error instanceof ObservedFailure) return error.details;
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return failure(typeof code === "string" && ERROR_CODES.has(code) ? code : "unknown");
}

function safeStatus(result: unknown) {
	if (!record(result) || !record(result.status)) return failure("schema-incompatible");
	const status = result.status;
	if (
		result.operation !== "status" ||
		typeof result.scope !== "string" ||
		!["global", "clone", "both"].includes(result.scope) ||
		typeof status.global !== "string" ||
		!["", "on", "off"].includes(status.global) ||
		typeof status.cloneLocal !== "string" ||
		!["", "on", "off"].includes(status.cloneLocal) ||
		typeof status.effective !== "string" ||
		!["on", "off"].includes(status.effective) ||
		typeof status.source !== "string" ||
		!["default", "global", "clone_local"].includes(status.source) ||
		(status.reach !== undefined &&
			(typeof status.reach !== "string" || !["machine", "this_build"].includes(status.reach)))
	) {
		return failure("schema-incompatible");
	}
	// Revision is an unconstrained native string: omit it, paths and every unknown field.
	return {
		ok: true as const,
		readOnly: true as const,
		status: {
			global: status.global,
			cloneLocal: status.cloneLocal,
			effective: status.effective,
			source: status.source,
			...(status.reach === undefined ? {} : { reach: status.reach }),
		},
	};
}

/** Register inactive; only an ordinary unrestricted primary loadout opts in at startup. */
export function registerReviewStatus(
	pi: ExtensionAPI,
	options: { subagent?: boolean } = {},
	createClient?: ClientFactory,
): void {
	if (options.subagent) return;
	pi.registerTool({
		name: REVIEW_STATUS_TOOL,
		label: "Read review mode status",
		description:
			"Only when the user requests it, read native RDD mode status in this managed engine. Status is NOT review approval or delivery authority; this cannot enable, disable, start, assess or recover a review.",
		exposure: "direct",
		defaultActive: false,
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const deliver = (details: ReturnType<typeof failure> | ReturnType<typeof safeStatus>) => ({
				content: [
					{ type: "text" as const, text: JSON.stringify(details) },
					...(!details.ok
						? [
								{
									type: "text" as const,
									text: JSON.stringify(
										guidanceFor(
											"rdd",
											"indicativeHint" in details ? details.indicativeHint : details.category,
										),
									),
								},
							]
						: []),
				],
				details,
			});
			if (signal?.aborted) return deliver(failure("cancelled"));
			if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length)
				return deliver(failure("invalid-arguments"));
			try {
				const client = await (createClient ? createClient() : nativeClient());
				if (signal?.aborted) return deliver(failure("cancelled"));
				if (typeof client.reviewMode !== "function") return deliver(failure("unsupported"));
				const result = await client.reviewMode({ cwd: ctx.cwd, operation: "status", signal });
				return deliver(safeStatus(result));
			} catch (error) {
				return deliver(safeError(error));
			}
		},
	});
	pi.on("session_start", () => {
		try {
			const previous = pi.getActiveTools();
			if (pi.getSettings().defaultTools !== undefined || previous.includes(REVIEW_STATUS_TOOL)) return;
			// Read-only/reviewer-style and unknown loadouts are not ordinary primary sessions.
			if (
				!["read", "edit", "write"].every((name) => previous.includes(name)) ||
				!previous.some((name) => name === "bash" || name === "powershell")
			)
				return;
			if (!pi.getAllTools().some((tool) => tool.name === REVIEW_STATUS_TOOL && tool.exposure === "direct"))
				return;
			pi.setActiveTools([...previous, REVIEW_STATUS_TOOL]);
		} catch {
			// Missing APIs or rejected activation must not break startup or trigger a fallback.
		}
	});
}
