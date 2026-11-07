type Guidance = { code: string; summary: string; steps: readonly string[] };
const guide = (code: string, summary: string, ...steps: string[]): Guidance =>
	Object.freeze({ code, summary, steps: Object.freeze(steps) });
const generic = guide(
	"unknown",
	"The available observation does not establish a cause or current health.",
	"Review the finite diagnostic category before choosing any manual action.",
	"Do not infer that RDD is disabled or authorize repairs from this observation.",
);
const components = new Set([
	"node",
	"sdk",
	"codemode",
	"review_cli",
	"git",
	"powershell",
	"engram",
	"mcp",
	"webview2",
	"rdd",
]);
const metadata = new Map<string, Guidance>([
	[
		"running",
		guide(
			"running",
			"The daemon observes its running Node runtime, not dependency health.",
			"Compare the reported numeric release with the supported runtime requirements.",
		),
	],
	[
		"file_present",
		guide(
			"file_present",
			"An expected file was observed; execution and health are not established.",
			"Review the component requirements manually before considering a separate execution check.",
		),
	],
	[
		"file_absent",
		guide(
			"file_absent",
			"An expected file was absent in the bounded lookup, not necessarily elsewhere.",
			"Compare the selected runtime contents with the documented component requirements.",
			"Do not infer machine-wide Git absence from a bounded lookup.",
		),
	],
	[
		"metadata_present",
		guide(
			"metadata_present",
			"Public package metadata was observed, not executable health or compatibility.",
			"Compare the reported release with the bundled SDK and codemode requirements.",
		),
	],
	[
		"not_checked",
		guide(
			"not_checked",
			"This component was not checked; availability and health remain unknown.",
			"For MCP, review existing cached observations only as history.",
			"For WebView2, consult the desktop requirements; daemon metadata cannot prove its operation.",
		),
	],
	[
		"not_applicable",
		guide(
			"not_applicable",
			"This check does not apply to the selected platform.",
			"Consult the documented requirements for the selected platform.",
		),
	],
]);
const categories = new Map<string, Guidance>();
function assign(keys: readonly string[], value: Guidance): void {
	for (const key of keys) categories.set(key, value);
}
assign(
	[
		"unavailable",
		"package-local-binary-missing",
		"executable_missing",
		"file_not_found",
		"package_unavailable",
		"module_missing",
	],
	guide(
		"component_unavailable",
		"The requested component could not be used; the cause is not established.",
		"Compare the selected runtime contents with its documented bundled component requirements.",
		"Review existing finite availability observations before requesting any separate maintenance action.",
	),
);
assign(
	["timeout", "signal", "cancelled"],
	guide(
		"interrupted",
		"The operation did not complete normally; this is not a health or mode result.",
		"Review whether the request was cancelled or exceeded its existing execution budget.",
		"Leave runtime and review mode settings unchanged based on this observation alone.",
	),
);
assign(
	["non-zero", "unexpected-stderr", "system_error", "failed"],
	guide(
		"operation_failed",
		"The operation reported failure without establishing a specific cause.",
		"Review any finite indicative hint alongside the failure category.",
		"Do not treat a failed RDD status query as proof that reviews are disabled.",
	),
);
assign(
	[
		"output-limit",
		"empty-output",
		"malformed-json",
		"schema-incompatible",
		"identity-mismatch",
		"version-incompatible",
		"rpc_error",
		"stdio_incomplete_message",
		"stdio_message_limit",
		"invalid_jsonrpc_message",
		"protocol_error",
	],
	guide(
		"response_unusable",
		"The response could not be accepted as the expected public protocol result.",
		"Compare documented bundled client and native component compatibility requirements.",
		"Use only finite diagnostic fields when reporting the mismatch; omit original output.",
	),
);
assign(
	["unsupported", "unsupported-transition-operation", "invalid-arguments", "proxy_refusal"],
	guide(
		"request_unsupported",
		"The requested operation or arguments were not accepted.",
		"Consult the documented read-only operation and its permitted arguments.",
		"Do not substitute a mutating operation for an unsupported status query.",
	),
);
assign(
	["git_unavailable"],
	guide(
		"git_unavailable",
		"A source-template indication suggests the review process could not locate Git.",
		"If Git is not installed, install it manually; bounded file absence alone does not prove this.",
		"If Git is already installed, make the existing installation available when launching the application.",
		"A failed query does not establish that RDD is disabled; leave mode settings unchanged.",
	),
);
assign(
	["unreadable_mode_value"],
	guide(
		"unreadable_mode_value",
		"A source-template indication suggests an unreadable mode value, not disabled RDD.",
		"Consult the documented review mode configuration rules before choosing a manual action.",
		"Do not overwrite mode values based only on an indicative text match.",
	),
);
assign(
	["unsafe_clone_mode_path"],
	guide(
		"unsafe_clone_mode_path",
		"A source-template indication suggests a clone-mode path safety refusal.",
		"Consult the documented clone-local path and ownership requirements.",
		"Do not change permissions or review mode based only on an indicative text match.",
	),
);
assign(
	["auth_required", "secrets_unavailable"],
	guide(
		"authentication_unconfirmed",
		"Required authentication or credential access was not established.",
		"Review the documented account and credential requirements locally.",
		"Never include credentials or configuration contents in a diagnostic report.",
	),
);
assign(
	["connection_closed", "transport_closed", "dns_error", "connection_refused", "tls_error", "http_error"],
	guide(
		"connection_failed",
		"A connection observation reported failure; current connection health is unknown.",
		"Review the documented transport and endpoint requirements manually.",
		"Treat cached MCP observations as history, not a new connection test.",
	),
);
assign(
	["access_denied"],
	guide(
		"access_denied",
		"An access refusal was indicated; its cause is not established.",
		"Review the documented component access requirements without changing permissions automatically.",
	),
);
assign(
	["not_observed", "connected_once"],
	guide(
		"connection_history",
		"Cached connection history does not establish current health.",
		"Review the finite cached observations without starting or reconnecting an MCP server.",
	),
);

/** Pure finite guidance: unknown inputs are never coerced, inspected or echoed. */
export function guidanceFor(
	component: unknown,
	condition: unknown,
): { code: string; summary: string; steps: readonly string[] } {
	if (typeof component !== "string" || !components.has(component) || typeof condition !== "string")
		return generic;
	return metadata.get(condition) ?? categories.get(condition) ?? generic;
}
