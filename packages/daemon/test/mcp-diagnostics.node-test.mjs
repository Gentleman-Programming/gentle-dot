import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { Readable } from "node:stream";
import test from "node:test";

// Only owned modules execute. SDK clients and transports are inert fakes.
const sdk = `
export const JSON_RPC_ERROR_CODES = {parseError:-32700,invalidRequest:-32600,methodNotFound:-32601,invalidParams:-32602,internalError:-32603};
export const LATEST_PROTOCOL_VERSION='test', SUPPORTED_PROTOCOL_VERSIONS=['test'];
export class McpError extends Error { constructor(code,message,data) { super(message); this.code=code; this.data=data; } }
export class McpHttpError extends Error { constructor(status,message,body) { super(message); this.status=status; this.body=body; } }
export class McpAuthRequiredError extends McpHttpError {}
export class McpOAuthAuthorizationRequiredError extends Error {}
export class McpTimeoutError extends Error {}
export class McpAbortError extends Error {}
export class McpConnectionClosedError extends Error {}
export class McpClient {
  connectionState='connected';
  async connect(transport) {
    this.transport=transport;
    try { await transport.connect(); }
    catch(error) {
      if(error instanceof McpConnectionClosedError) await this.close();
      throw error;
    }
  }
  onClose(fn) { this.closed=fn; }
  async close() { this.connectionState='closed'; this.closed?.(); }
  async listTools() { return globalThis.mcpFake.request('tools/list'); }
  async callTool() { return globalThis.mcpFake.request('tools/call'); }
  async listResources() { return globalThis.mcpFake.request('resources/list'); }
  async listResourceTemplates() { return globalThis.mcpFake.request('resources/templates/list'); }
  async request(method) { return globalThis.mcpFake.request(method); }
}
export class StdioTransport { constructor(options) { if(globalThis.mcpFake.stdio) return globalThis.mcpFake.stdio(options); throw Error('Real transport forbidden'); } }
export class StreamableHttpTransport extends StdioTransport {}
`;
const modules = new Map([
	["@earendil-works/pi-mcp", sdk],
	["@earendil-works/pi-mcp/oauth", sdk],
	[
		"./vps.ts",
		'export const stdioCommand=(user,command,args)=>{if(!globalThis.mcpFake.stdio)throw Error("Spawn forbidden");return {command,args};};',
	],
	["./extensions/approval-guard.ts", "export const isReadOnlyTool=()=>true;"],
]);
registerHooks({
	resolve(specifier, context, next) {
		if (modules.has(specifier) && context.parentURL?.includes("/daemon/src/"))
			return {
				url: "data:text/javascript," + encodeURIComponent(modules.get(specifier)),
				shortCircuit: true,
			};
		if (!/^(node:|\.|file:|data:)/.test(specifier)) throw Error("Unapproved runtime import");
		return next(specifier, context);
	},
});
const { McpProxy } = await import("../src/mcp-proxy.ts");
const errors = await import("data:text/javascript," + encodeURIComponent(sdk));
const { SecretsUnavailableError } = await import("../src/secret-source.ts");
const sentinel = "PRIVATE_SENTINEL_DO_NOT_EXPORT";
function deferred() {
	let resolve, reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}
function proxyHarness(options = {}) {
	const connectors = new Map();
	let credentials = 0,
		connects = 0,
		views = 0;
	let credentialError, transportError, connectError, prepare;
	const transports = [],
		logs = [];
	globalThis.mcpFake = { request: async () => [] };
	const proxy = new McpProxy({
		connector: (id) => {
			views++;
			return connectors.get(id);
		},
		approve: async () => false,
		prepare: async () => {
			if (prepare) await prepare();
		},
		credentials: async () => {
			credentials++;
			if (credentialError) throw credentialError;
			return {};
		},
		log: (line) => logs.push(line),
		transport: () => {
			if (transportError) throw transportError;
			const listeners = new Set(),
				retained = [];
			const transport = {
				onError(fn) {
					listeners.add(fn);
					retained.push(fn);
					return () => listeners.delete(fn);
				},
				emit(error, stale = false) {
					for (const fn of stale ? retained : listeners) fn(error);
				},
				listeners: () => listeners.size,
				connect: async () => {
					connects++;
					if (connectError) await connectError(transport);
				},
			};
			transports.push(transport);
			return transport;
		},
		...options,
	});
	let key = proxy.rotateKey();
	function add(id = sentinel, revision = "r1") {
		const connector = {
			id,
			name: "Public",
			revision,
			enabled: true,
			mode: "read_only",
			readOnlyTools: [],
			server: { url: sentinel },
		};
		connectors.set(id, connector);
		return connector;
	}
	async function send(method = "tools/list", id = sentinel, params = {}) {
		const req = Readable.from([Buffer.from(JSON.stringify({ id: 1, method, params }))]);
		Object.assign(req, { method: "POST", url: "/mcp/" + id, headers: { authorization: "Bearer " + key } });
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
				finished.resolve(body ? JSON.parse(body) : undefined);
			},
		});
		proxy.handle(req, res);
		return finished.promise;
	}
	return {
		proxy,
		add,
		send,
		connectors,
		transports,
		logs,
		counts: () => [credentials, connects],
		views: () => views,
		failCredentials: (e) => (credentialError = e),
		failTransport: (e) => (transportError = e),
		failConnect: (fn) => (connectError = fn),
		prepare: (fn) => (prepare = fn),
		rotate: () => (key = proxy.rotateKey()),
	};
}
test("installed pi-mcp 1.5 retains the reviewed finite producer templates without executing transports", () => {
	const root = new URL("../node_modules/@earendil-works/pi-mcp/", import.meta.url);
	const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	assert.equal(metadata.version, "1.5.0");
	const stdio = readFileSync(new URL("dist/transports/stdio.js", root), "utf8");
	assert.ok(stdio.includes('new Error("MCP stdio server closed with an incomplete JSON-RPC message")'));
	assert.ok(stdio.includes("new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`)"));
	const jsonrpc = readFileSync(new URL("dist/protocol/jsonrpc.js", root), "utf8");
	assert.ok(
		jsonrpc.includes('new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message")'),
	);
	const http = readFileSync(new URL("dist/transports/streamable-http.js", root), "utf8");
	assert.ok(http.includes("MCP server requires authentication"));
	assert.ok(http.includes("MCP HTTP request failed with status ${status}"));
});
const incomplete = "MCP stdio server closed with an incomplete JSON-RPC message";
const hint = (kind) => ({ kind, indicative: true, scope: "connection" });
test("original transport signal survives later connect closure as connection-only history", async () => {
	const h = proxyHarness();
	h.add();
	h.failConnect(async (transport) => {
		transport.emit(new Error(incomplete));
		throw new errors.McpConnectionClosedError();
	});
	await h.send();
	const snapshot = h.proxy.diagnostics();
	assert.deepEqual(snapshot.entries[0].hint, hint("stdio_incomplete_message"));
	assert.equal(snapshot.entries[0].stage, "connect");
	assert.equal(snapshot.entries[0].category, "connection_closed");
	assert.equal(h.transports[0].listeners(), 0);
	h.transports[0].emit(new Error(sentinel), true);
	assert.deepEqual(h.proxy.diagnostics(), snapshot);
});
test("generic upstream failure logs never retain the synthetic raw prefix", async () => {
	const h = proxyHarness();
	h.add();
	globalThis.mcpFake.request = async () => {
		throw new Error(sentinel);
	};
	await h.send();
	assert.ok(h.logs.length);
	assert.ok(!JSON.stringify(h.logs).includes(sentinel));
});
test("transport templates match exactly; arbitrary parser/text/typed RPC errors stay unknown", async () => {
	const fixtures = [
		[new Error(incomplete), "stdio_incomplete_message"],
		[new Error("MCP stdio message exceeds 8388608 bytes"), "stdio_message_limit"],
		[new errors.McpError(-32600, "Invalid JSON-RPC message"), "invalid_jsonrpc_message"],
		[new Error("MCP stdio message exceeds 10 bytes\n"), "unknown"],
		[new Error("Invalid JSON-RPC message"), "unknown"],
		[new errors.McpError(-32601, "Invalid JSON-RPC message"), "unknown"],
		[new SyntaxError(sentinel), "unknown"],
		[new Error(incomplete + " " + sentinel), "unknown"],
		[new Error(sentinel + " MCP stdio message exceeds 10 bytes"), "unknown"],
		[new Error("MCP stdio message exceeds 10 bytes\n" + sentinel), "unknown"],
		[
			Object.defineProperty(new Error(), "message", {
				get() {
					throw Error(sentinel);
				},
			}),
			"unknown",
		],
	];
	for (const [error, kind] of fixtures) {
		const h = proxyHarness();
		h.add();
		await h.send();
		h.transports[0].emit(error);
		const snapshot = h.proxy.diagnostics();
		assert.deepEqual(snapshot.entries[0].hint, hint(kind));
		assert.equal(snapshot.entries[0].stage, "connect");
		assert.equal(snapshot.entries[0].observation, "connected_once");
		snapshot.entries[0].hint.kind = sentinel;
		const text = JSON.stringify(h.proxy.diagnostics());
		assert.ok(!text.includes(sentinel));
		assert.ok(!text.includes(incomplete));
		assert.ok(!JSON.stringify(h.logs).includes(sentinel));
		await h.proxy.close();
		assert.equal(h.transports[0].listeners(), 0);
	}
});
test("concurrent waiters and idle signals are connection observations, not request causes", async () => {
	const h = proxyHarness();
	h.add();
	await h.send();
	const wait = deferred(),
		entered = deferred();
	let requests = 0;
	globalThis.mcpFake.request = async () => {
		if (++requests === 2) entered.resolve();
		return wait.promise;
	};
	const first = h.send(),
		second = h.send();
	await entered.promise;
	h.transports[0].emit(new Error(incomplete));
	wait.resolve([]);
	for (const reply of await Promise.all([first, second])) assert.deepEqual(reply.result, { tools: [] });
	const entry = h.proxy.diagnostics().entries[0];
	assert.equal(entry.stage, "connect");
	assert.equal(entry.category, undefined);
	assert.deepEqual(entry.hint, hint("stdio_incomplete_message"));
	globalThis.mcpFake.request = async () => {
		throw new errors.McpError(-32602, incomplete);
	};
	assert.equal((await h.send()).error.message, incomplete); // Deliberate native RPC passthrough.
	assert.equal(h.proxy.diagnostics().entries[0].stage, "upstream_request");
	assert.deepEqual(h.proxy.diagnostics().entries[0].hint, entry.hint);
	await h.proxy.close();
});
for (const transition of ["sync", "revision", "disable", "close", "failure"])
	test(`transport listener lifetime and stale callbacks after ${transition}`, async () => {
		const h = proxyHarness(),
			c = h.add();
		await h.send();
		const old = h.transports[0];
		old.emit(new Error(incomplete));
		if (transition === "failure") {
			globalThis.mcpFake.request = async () => {
				throw new Error(sentinel);
			};
			await h.send();
		} else if (transition === "close") await h.proxy.close();
		else {
			if (transition === "revision") c.revision = "r2";
			if (transition === "disable") c.enabled = false;
			h.proxy.sync();
		}
		assert.equal(old.listeners(), 0);
		const before = h.proxy.diagnostics();
		if (transition === "failure") assert.deepEqual(before.entries[0].hint, hint("stdio_incomplete_message"));
		else assert.deepEqual(before.entries, []);
		old.emit(new Error("MCP stdio message exceeds 1 bytes"), true);
		assert.deepEqual(h.proxy.diagnostics(), before);
		if (transition !== "sync") {
			c.enabled = true;
			globalThis.mcpFake.request = async () => [];
			await h.send();
			assert.equal(h.proxy.diagnostics().entries[0].hint, undefined);
			old.emit(new Error(incomplete), true);
			assert.equal(h.proxy.diagnostics().entries[0].hint, undefined);
		}
		await h.proxy.close();
	});
test("unrelated request error text is not a transport observation", async () => {
	const h = proxyHarness();
	h.add();
	globalThis.mcpFake.request = async () => {
		throw new errors.McpError(-32600, "Invalid JSON-RPC message");
	};
	assert.equal((await h.send()).error.message, "Invalid JSON-RPC message");
	assert.equal(h.proxy.diagnostics().entries[0].hint, undefined);
	await h.proxy.close();
});
const cases = [
	["credentials", "secrets_unavailable", () => new SecretsUnavailableError()],
	["transport_create", "system_error", () => Object.assign(new Error(sentinel), { code: "ENOENT" })],
	["connect", "auth_required", () => new errors.McpAuthRequiredError(401, sentinel, sentinel)],
	["connect", "http_error", () => new errors.McpHttpError(503, sentinel, sentinel)],
	["connect", "timeout", () => new errors.McpTimeoutError()],
	["upstream_request", "cancelled", () => new errors.McpAbortError()],
	["upstream_request", "connection_closed", () => new errors.McpConnectionClosedError()],
	["upstream_request", "rpc_error", () => new errors.McpError(-32602, "public rpc")],
	["upstream_request", "unknown", () => ({ message: sentinel, code: sentinel, cause: { code: "ENOENT" } })],
];
for (const [stage, category, make] of cases)
	test(`safe evidence ${stage}/${category}; previous generic RPC preserved`, async () => {
		const h = proxyHarness();
		h.add();
		const error = make();
		if (stage === "credentials") h.failCredentials(error);
		if (stage === "transport_create") h.failTransport(error);
		if (stage === "connect")
			h.failConnect(async () => {
				throw error;
			});
		if (stage === "upstream_request")
			globalThis.mcpFake.request = async () => {
				throw error;
			};
		const reply = await h.send();
		assert.equal(reply.error.code, category === "rpc_error" ? -32602 : -32000);
		if (category === "rpc_error") assert.equal(reply.error.message, "public rpc");
		else if (!["secrets_unavailable", "auth_required"].includes(category))
			assert.equal(reply.error.message, "Could not reach Public right now. Try again in a moment.");
		const snapshot = h.proxy.diagnostics();
		assert.deepEqual(
			[snapshot.source, snapshot.coverage, snapshot.observation],
			["owned_proxy", "proxy_only", "failed"],
		);
		assert.deepEqual([snapshot.entries[0].stage, snapshot.entries[0].category], [stage, category]);
		assert.ok(!JSON.stringify(snapshot).includes(sentinel));
		assert.equal(snapshot.entries[0].server, "server-1");
		const expectedCode =
			category === "system_error"
				? "ENOENT"
				: category === "http_error"
					? 503
					: category === "rpc_error"
						? -32602
						: undefined;
		assert.equal(snapshot.entries[0].code, expectedCode);
	});
test("copies, bounded entries, revision invalidation, retrieval without credentials/connect", async () => {
	const h = proxyHarness();
	h.add();
	assert.equal(h.proxy.diagnostics().observation, "not_observed");
	assert.deepEqual(h.counts(), [0, 0]);
	assert.deepEqual((await h.send()).result, { tools: [] });
	const first = h.proxy.diagnostics();
	assert.equal(first.observation, "connected_once");
	first.entries[0].server = sentinel;
	first.entries.push({ server: sentinel });
	assert.ok(!JSON.stringify(h.proxy.diagnostics()).includes(sentinel));
	assert.deepEqual(h.counts(), [1, 1]);
	h.add(sentinel, "r2");
	h.proxy.sync();
	assert.deepEqual(h.proxy.diagnostics().entries, []);
	for (let n = 0; n < 40; n++) {
		h.add("private-" + n);
		await h.send("tools/list", "private-" + n);
	}
	assert.ok(h.proxy.diagnostics().entries.length <= 32);
	assert.ok(h.proxy.diagnostics().entries.every((e) => /^server-([1-9]|[12][0-9]|3[0-2])$/.test(e.server)));
	h.rotate();
	assert.equal(h.proxy.diagnostics().observation, "not_observed");
});
test("stale overlapping connect failures cannot replace a new revision or key generation", async () => {
	for (const rotate of [false, true]) {
		const h = proxyHarness();
		h.add();
		const wait = deferred(),
			entered = deferred();
		h.failConnect(async () => {
			entered.resolve();
			await wait.promise;
			throw Object.assign(new Error(sentinel), { code: "ENOENT" });
		});
		const old = h.send();
		await entered.promise;
		try {
			if (rotate) h.rotate();
			else h.add(sentinel, "r2");
			h.failConnect(undefined);
			h.proxy.sync();
			if (!rotate) assert.deepEqual((await h.send()).result, { tools: [] });
		} finally {
			wait.resolve();
		}
		assert.deepEqual((await old).error, {
			code: -32000,
			message: "Could not reach Public right now. Try again in a moment.",
		});
		assert.deepEqual(h.counts(), rotate ? [1, 1] : [2, 2]);
		assert.equal(h.proxy.diagnostics().observation, rotate ? "not_observed" : "connected_once");
	}
});
test("key rotation during preflight also invalidates the old authorized request", async () => {
	const h = proxyHarness();
	h.add();
	const wait = deferred(),
		entered = deferred();
	h.prepare(async () => {
		entered.resolve();
		await wait.promise;
	});
	const old = h.send();
	try {
		await entered.promise;
		h.rotate();
	} finally {
		wait.resolve();
	}
	assert.deepEqual((await old).result, { tools: [] });
	assert.deepEqual(h.counts(), [1, 1]);
	assert.equal(h.proxy.diagnostics().observation, "not_observed");
	assert.equal(h.transports[0].listeners(), 0);
	h.transports[0].emit(new Error(incomplete), true);
	assert.equal(h.proxy.diagnostics().observation, "not_observed");
});
test("early unavailable and dispatch refusals captured; ping and initialize retain their behavior", async () => {
	const h = proxyHarness();
	const c = h.add();
	c.unavailable = "public unavailable";
	assert.equal((await h.send()).error.message, "public unavailable");
	assert.equal(h.proxy.diagnostics().entries[0].category, "secrets_unavailable");
	delete c.unavailable;
	assert.deepEqual((await h.send("ping")).result, {});
	assert.equal((await h.send("initialize")).result.serverInfo.name, "gentle-dot-" + sentinel);
	assert.deepEqual(h.counts(), [0, 0]);
	assert.equal((await h.send("unknown")).error.code, -32601);
	assert.equal(h.proxy.diagnostics().entries[0].category, "proxy_refusal");
});
test("normal tool/resource/prompt RPC results and unsupported-list fallback stay unchanged", async () => {
	const h = proxyHarness();
	h.add().readOnlyTools = ["read"];
	const results = {
		"tools/list": [{ name: "read" }],
		"tools/call": { content: [] },
		"resources/list": [],
		"resources/templates/list": [],
		"resources/read": { contents: [] },
		"prompts/list": { prompts: [] },
		"prompts/get": { messages: [] },
	};
	globalThis.mcpFake.request = async (method) => results[method];
	for (const [method, expected] of Object.entries({
		"tools/list": { tools: [{ name: "read" }] },
		"tools/call": { content: [] },
		"resources/list": { resources: [] },
		"resources/templates/list": { resourceTemplates: [] },
		"resources/read": { contents: [] },
		"prompts/list": { prompts: [] },
		"prompts/get": { messages: [] },
	}))
		assert.deepEqual((await h.send(method, sentinel, { name: "read" })).result, expected);
	globalThis.mcpFake.request = async () => {
		throw new errors.McpError(-32601, "public unsupported");
	};
	assert.deepEqual((await h.send("resources/list")).result, { resources: [] });
	assert.deepEqual(h.counts(), [1, 1]);
});
test("only finite recognized codes exported; no message or nested-cause inference", async () => {
	for (const error of [
		new errors.McpHttpError(418, sentinel, sentinel),
		new errors.McpError(-32042, "public rpc"),
		Object.assign(new Error("timeout ENOENT"), { code: sentinel, cause: { code: "ETIMEDOUT" } }),
	]) {
		const h = proxyHarness();
		h.add();
		globalThis.mcpFake.request = async () => {
			throw error;
		};
		await h.send();
		const e = h.proxy.diagnostics().entries[0];
		assert.equal(e.code, undefined);
		assert.equal(
			e.category,
			error instanceof errors.McpHttpError
				? "http_error"
				: error instanceof errors.McpError
					? "rpc_error"
					: "unknown",
		);
		assert.ok(!JSON.stringify(e).includes(sentinel));
	}
});
test("S40 originating stdio hint and typed failure survive close, stay finite and invalidate", async (context) => {
	if (typeof McpProxy.prototype.discordFailure !== "function") {
		context.skip("Origin-hint API is preexisting uncommitted operational work, absent in HEAD projection.");
		return;
	}
	const h = proxyHarness({ transport: undefined });
	h.add("discord").server = { command: "npx", args: ["public-package"] };
	globalThis.mcpFake.stdio = (options) => ({
		onError: () => () => {},
		connect: async () => {
			options.onStderr("npm error code ENOT");
			options.onStderr(`CACHED\n${sentinel}\n`);
			throw new errors.McpConnectionClosedError();
		},
	});
	await h.send("tools/list", "discord");
	const before = [h.counts(), h.views()];
	assert.deepEqual(h.proxy.discordFailure(), {
		failureStage: "connect",
		failureCategory: "connection_closed",
		startupHint: "package_unavailable",
	});
	assert.deepEqual([h.counts(), h.views()], before);
	assert.ok(!JSON.stringify([h.proxy.discordFailure(), h.proxy.diagnostics(), h.logs]).includes(sentinel));
	h.proxy.sync();
	assert.equal(h.proxy.discordFailure().startupHint, "unknown");
	const { ProxyDiagnostics, startupHint, discordFailureFields } = await import("../src/mcp-diagnostics.ts");
	for (const [line, kind] of [
		["spawn npx ENOENT", "executable_missing"],
		["npm error code ENOENT", "file_not_found"],
		["npm ERR! code E404", "package_unavailable"],
		["npm error code ETARGET", "package_unavailable"],
		["Error: Cannot find module private", "module_missing"],
		["npm error code ENOTFOUND", "dns_error"],
		["connect ECONNREFUSED private", "connection_refused"],
		["npm error code EACCES", "access_denied"],
		["npm error code ETIMEDOUT", "timeout"],
		["npm error code CERT_HAS_EXPIRED", "tls_error"],
		["MCP HTTP request failed with status 401: private", "auth_required"],
		[sentinel, "unknown"],
	])
		assert.equal(startupHint(line), kind);
	let enabled = true;
	const d = new ProxyDiagnostics(() => ({ revision: "r", enabled }));
	const observe = d.startupObserver("discord", "r", d.ticket());
	observe("npm error code E404\n");
	d.clear();
	observe("npm error code E404\n");
	assert.equal(d.discordFailure().startupHint, "unknown");
	const disabled = d.startupObserver("discord", "r", d.ticket());
	enabled = false;
	disabled("npm error code E404\n");
	assert.equal(d.discordFailure().startupHint, "unknown");
	assert.deepEqual(
		discordFailureFields({
			failureStage: sentinel,
			failureCategory: sentinel,
			startupHint: sentinel,
			failureCode: sentinel,
		}),
		{ failureStage: "unknown", failureCategory: "unknown", startupHint: "unknown" },
	);
});
for (const field of ["enabled", "revision"])
	test(`MCP-B1 retained history cannot revive after reversible ${field}`, async () => {
		const h = proxyHarness();
		const c = h.add();
		assert.deepEqual((await h.send()).result, { tools: [] });
		c[field] = field === "enabled" ? false : "r2";
		h.proxy.sync();
		assert.equal(h.proxy.diagnostics().observation, "not_observed");
		c[field] = field === "enabled" ? true : "r1";
		h.proxy.sync();
		assert.equal(h.proxy.diagnostics().observation, "not_observed");
		assert.deepEqual(h.counts(), [1, 1]);
	});
for (const transition of ["disable", "reenable", "revision"])
	test(`MCP-B1 late failure after ${transition} cannot revive`, async () => {
		const h = proxyHarness();
		const c = h.add();
		const wait = deferred(),
			entered = deferred();
		h.failConnect(async () => {
			entered.resolve();
			await wait.promise;
			throw Object.assign(new Error(sentinel), { code: "ENOENT" });
		});
		const old = h.send();
		try {
			await entered.promise;
			if (transition === "revision") c.revision = "r2";
			else c.enabled = false;
			h.proxy.sync();
			if (transition !== "disable") {
				c.enabled = true;
				c.revision = "r1";
				h.proxy.sync();
			}
		} finally {
			wait.resolve();
		}
		assert.deepEqual((await old).error, {
			code: -32000,
			message: "Could not reach Public right now. Try again in a moment.",
		});
		assert.equal(h.proxy.diagnostics().observation, "not_observed");
		c.enabled = true;
		h.proxy.sync();
		assert.equal(h.proxy.diagnostics().observation, "not_observed");
		assert.deepEqual(h.counts(), [1, 1]);
	});
test("MCP-B1 off/on during preflight invalidates tickets without an upstream", async () => {
	const h = proxyHarness();
	const c = h.add();
	const wait = deferred(),
		entered = deferred();
	h.prepare(async () => {
		entered.resolve();
		await wait.promise;
	});
	const old = h.send();
	try {
		await entered.promise;
		c.enabled = false;
		h.proxy.sync();
		c.enabled = true;
		h.proxy.sync();
	} finally {
		wait.resolve();
	}
	assert.deepEqual((await old).result, { tools: [] });
	assert.deepEqual(h.counts(), [1, 1]);
	assert.equal(h.proxy.diagnostics().observation, "not_observed");
});
test("MCP-B1 snapshot never calls credential-resolving connector view", async () => {
	const h = proxyHarness();
	h.add();
	await h.send();
	const before = h.views();
	assert.equal(h.proxy.diagnostics().observation, "connected_once");
	assert.equal(h.proxy.diagnostics().observation, "connected_once");
	assert.equal(h.views(), before);
	assert.deepEqual(h.counts(), [1, 1]);
});
test("retired capture collaborators cannot observe an ordinary transport or retain private startup text", async () => {
	let captured = 0;
	const h = proxyHarness({
		transport: undefined,
		localDiscordDiagnostics: true,
		trace: {
			record: () => {
				captured++;
			},
			transport: () => {
				captured++;
				throw Error("Retired decorator");
			},
		},
	});
	h.add("discord").server = { command: "node", args: [] };
	globalThis.mcpFake.stdio = (options) => ({
		onError: () => () => {},
		connect: async () => {
			if (options.onStderr) options.onStderr(`npm error code E404\n${sentinel}\n`);
			throw new errors.McpConnectionClosedError();
		},
	});
	await h.send("tools/list", "discord");
	assert.equal(captured, 0);
	assert.equal(h.proxy.takeLocalDiscordStartup, undefined);
	assert.equal(h.proxy.setDebug, undefined);
	assert.equal(h.proxy.inventory, undefined);
	assert.equal(h.proxy.diagnostics().entries[0].category, "connection_closed");
	if (typeof h.proxy.discordFailure === "function") {
		assert.equal(h.proxy.discordFailure().startupHint, "package_unavailable");
		assert.ok(!JSON.stringify(h.proxy.discordFailure()).includes(sentinel));
	}
	assert.ok(!JSON.stringify([h.proxy.diagnostics(), h.logs]).includes(sentinel));
	await h.proxy.close();
});
