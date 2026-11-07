import assert from "node:assert/strict";
import test from "node:test";
import { guidanceFor } from "../src/extensions/diagnostic-guidance.ts";

const components = [
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
];
const states = [
	"running",
	"file_present",
	"file_absent",
	"metadata_present",
	"unknown",
	"not_checked",
	"not_applicable",
];
const errors = [
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
	"invalid-arguments",
	"unsupported",
	"unreadable_mode_value",
	"unsafe_clone_mode_path",
];
const mcp = [
	"secrets_unavailable",
	"auth_required",
	"connection_closed",
	"http_error",
	"rpc_error",
	"system_error",
	"proxy_refusal",
	"stdio_incomplete_message",
	"stdio_message_limit",
	"invalid_jsonrpc_message",
	"executable_missing",
	"file_not_found",
	"access_denied",
	"package_unavailable",
	"module_missing",
	"dns_error",
	"connection_refused",
	"tls_error",
	"transport_closed",
	"protocol_error",
	"not_observed",
	"connected_once",
	"failed",
];
function shape(guide) {
	assert.deepEqual(Object.keys(guide), ["code", "summary", "steps"]);
	assert.match(guide.code, /^[a-z_]+$/);
	assert.equal(typeof guide.summary, "string");
	assert.ok(guide.summary.length > 15);
	assert.ok(Array.isArray(guide.steps) && guide.steps.length > 0);
	for (const step of guide.steps) assert.ok(typeof step === "string" && step.length > 15);
	assert.ok(Object.isFrozen(guide));
	assert.ok(Object.isFrozen(guide.steps));
}
test("finite catalog covers metadata, RDD and cached MCP conditions without claiming health", () => {
	const generic = guidanceFor(undefined, undefined);
	shape(generic);
	for (const component of components)
		for (const state of states) {
			const guide = guidanceFor(component, state);
			shape(guide);
			if (state !== "unknown") assert.notDeepEqual(guide, generic);
			assert.deepEqual(guide, guidanceFor(component, state));
		}
	for (const condition of errors) {
		shape(guidanceFor("rdd", condition));
		assert.notDeepEqual(guidanceFor("rdd", condition), generic);
	}
	for (const condition of mcp) {
		shape(guidanceFor("mcp", condition));
		assert.notDeepEqual(guidanceFor("mcp", condition), generic);
	}
	assert.match(guidanceFor("git", "file_absent").summary, /bounded/i);
	assert.match(guidanceFor("sdk", "metadata_present").summary, /not.*health/i);
	assert.match(guidanceFor("rdd", "unreadable_mode_value").summary, /not.*disabled/i);
});
test("unknown inputs never coerce, echo, or mutate the shared finite catalog", () => {
	const generic = guidanceFor(undefined, undefined);
	const hostile = {
		toString() {
			assert.fail("no coercion");
		},
		get code() {
			return assert.fail("no property read");
		},
	};
	for (const value of [
		hostile,
		Symbol("PRIVATE_CANARY"),
		null,
		42,
		"PRIVATE_CANARY",
		"__proto__",
		"constructor",
	]) {
		assert.deepEqual(guidanceFor(value, "running"), generic);
		assert.deepEqual(guidanceFor("rdd", value), generic);
	}
	const guide = guidanceFor("rdd", "timeout");
	assert.throws(() => guide.steps.push("PRIVATE_CANARY"), TypeError);
	assert.ok(!JSON.stringify(guidanceFor("rdd", "timeout")).includes("PRIVATE_CANARY"));
});
