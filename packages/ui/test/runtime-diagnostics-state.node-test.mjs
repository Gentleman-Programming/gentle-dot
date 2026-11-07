import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@gentle-dot/protocol") {
			return next(new URL("../../protocol/src/index.ts", import.meta.url).href, context);
		}
		return next(specifier, context);
	},
});
const { initialState, reduce } = await import("../src/store.ts");

test("connection transitions preserve chat state without allocating report state", () => {
	const before = JSON.stringify(initialState);
	const open = reduce(initialState, { type: "connection", status: "open" });
	const closed = reduce(open, { type: "connection", status: "closed" });
	assert.equal(open.connection, "open");
	assert.equal(closed.connection, "closed");
	assert.equal(Object.hasOwn(open, "diagnostics"), false);
	assert.equal(Object.hasOwn(closed, "diagnostics"), false);
	assert.deepEqual(closed.messages, []);
	assert.equal(closed.voice, initialState.voice);
	assert.equal(closed.asks, initialState.asks);
	assert.equal(JSON.stringify(initialState), before);
});

test("normal refusal and toast stay notices, not report screens or chat messages", () => {
	const before = JSON.stringify(initialState);
	const refusal = reduce(initialState, {
		type: "server",
		message: {
			type: "error",
			code: "unsupported",
			message: "I can't run that command here.",
			seq: 1,
		},
	});
	const notice = reduce(refusal, {
		type: "server",
		message: {
			type: "toast",
			level: "info",
			message: "Ordinary notice",
			seq: 2,
		},
	});
	assert.deepEqual(
		notice.notices.map(({ level, message }) => ({ level, message })),
		[
			{ level: "error", message: "I can't run that command here." },
			{ level: "info", message: "Ordinary notice" },
		],
	);
	assert.equal(Object.hasOwn(notice, "diagnostics"), false);
	assert.equal(notice.messages, initialState.messages);
	assert.equal(notice.asks, initialState.asks);
	assert.equal(JSON.stringify(initialState), before);
});

test("existing account and connector screen navigation remains available", () => {
	const accounts = reduce(initialState, { type: "accounts", open: true });
	const connectors = reduce(accounts, { type: "connectors", open: true });
	assert.equal(accounts.auth.open, true);
	assert.equal(connectors.auth.open, false);
	assert.equal(connectors.connectors.open, true);
	assert.equal(Object.hasOwn(connectors, "diagnostics"), false);
});
