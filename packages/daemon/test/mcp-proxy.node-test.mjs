import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { Readable } from "node:stream";
import test from "node:test";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

// Keep unrelated collaborators inert; the client and in-memory transport are the installed SDK.
const stubs = new Map([
	["./app-channel.ts", "export const APPROVAL_WAIT_MS=1;"],
	["./vps.ts", 'export const stdioCommand=()=>{throw Error("Spawn forbidden")};'],
	["./extensions/approval-guard.ts", "export const isReadOnlyTool=()=>true;"],
]);
registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL?.includes("/daemon/src/") && stubs.has(specifier))
			return { url: "data:text/javascript," + encodeURIComponent(stubs.get(specifier)), shortCircuit: true };
		return next(specifier, context);
	},
});
const { McpProxy } = await import("../src/mcp-proxy.ts");

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function harness() {
	const pending = [];
	const arrived = deferred();
	const counts = { credentials: 0, connects: 0, closes: 0 };
	let peer;
	const connector = {
		id: "notes",
		name: "Notes",
		enabled: true,
		revision: "r1",
		mode: "read_write",
		readOnlyTools: [],
		server: { url: "https://synthetic.invalid/mcp" },
	};
	const proxy = new McpProxy({
		connector: (id) => (id === connector.id ? connector : undefined),
		credentials: async () => {
			counts.credentials++;
			return {};
		},
		approve: async () => false,
		transport: () => {
			counts.connects++;
			const { client, server } = createInMemoryTransportPair();
			peer = server;
			server.onClose(() => {
				counts.closes++;
			});
			server.onMessage((message) => {
				if (!("method" in message) || !("id" in message)) return;
				if (message.method === "initialize") {
					void server.send({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: message.params.protocolVersion,
							capabilities: { resources: {} },
							serverInfo: { name: "synthetic", version: "1" },
						},
					});
				} else {
					pending.push(message);
					if (pending.length === 2) arrived.resolve();
				}
			});
			void server.start();
			return client;
		},
	});
	const key = proxy.rotateKey();
	async function send(method, id, params = {}) {
		const req = Readable.from([
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, ...(id === undefined ? {} : { id }), params })),
		]);
		Object.assign(req, { method: "POST", url: "/mcp/notes", headers: { authorization: "Bearer " + key } });
		const res = new EventEmitter();
		const finished = deferred();
		Object.assign(res, {
			setHeader() {},
			writeHead(status) {
				this.status = status;
				return this;
			},
			end(body) {
				this.writableFinished = true;
				finished.resolve({ status: this.status, body: body ? JSON.parse(body) : undefined });
			},
		});
		proxy.handle(req, res);
		return finished.promise;
	}
	async function answer(index) {
		await peer.send({ jsonrpc: "2.0", id: pending[index].id, result: { contents: [] } });
	}
	return { proxy, counts, send, answer, arrived, disconnect: () => peer.close() };
}

test("cancelling one read does not close the shared upstream or fail another read", {
	timeout: 2000,
}, async () => {
	const h = harness();
	try {
		const cancelled = h.send("resources/read", 1, { uri: "synthetic:first" });
		const surviving = h.send("resources/read", 2, { uri: "synthetic:second" });
		await h.arrived.promise;
		assert.deepEqual(await h.send("notifications/cancelled", undefined, { requestId: 1 }), {
			status: 202,
			body: undefined,
		});
		assert.deepEqual(await cancelled, {
			status: 200,
			body: {
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32000, message: "Could not reach Notes right now. Try again in a moment." },
			},
		});
		assert.deepEqual(h.counts, { credentials: 1, connects: 1, closes: 0 });
		await h.answer(1);
		assert.deepEqual(await surviving, {
			status: 200,
			body: { jsonrpc: "2.0", id: 2, result: { contents: [] } },
		});
		assert.deepEqual(h.counts, { credentials: 1, connects: 1, closes: 0 });
		const next = h.send("resources/read", 3, { uri: "synthetic:third" });
		// Wait for the public transport to receive the next request, without a timing sleep.
		await new Promise((resolve) => setImmediate(resolve));
		await h.answer(2);
		assert.equal((await next).body.id, 3);
		assert.deepEqual(h.counts, { credentials: 1, connects: 1, closes: 0 });
	} finally {
		await h.proxy.close();
	}
});

test("a real upstream close still fails pending reads and reconnects on the next read", {
	timeout: 2000,
}, async () => {
	const h = harness();
	try {
		const first = h.send("resources/read", 1);
		const second = h.send("resources/read", 2);
		await h.arrived.promise;
		await h.disconnect();
		for (const response of await Promise.all([first, second])) {
			assert.equal(response.status, 200);
			assert.equal(response.body.error.code, -32000);
		}
		const next = h.send("resources/read", 3);
		await new Promise((resolve) => setImmediate(resolve));
		await h.answer(2);
		assert.deepEqual((await next).body.result, { contents: [] });
		assert.deepEqual(h.counts, { credentials: 2, connects: 2, closes: 1 });
	} finally {
		await h.proxy.close();
	}
});
