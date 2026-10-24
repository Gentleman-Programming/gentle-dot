// The channel proxy is the daemon's thin client for an external bridge's admin API (S9): the
// bridge is never spawned here; when it does not answer, the channel simply shows as "off".
// The frozen endpoint contract lives in dot-whatsapp's odd/tasks/dot-whatsapp.md (S6).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChannelProxy } from "../src/channel-proxy.ts";
import { tempDir } from "./helpers.ts";

const TOKEN = "test-admin-token-0123456789abcdef";
const OWNER = "5491112345678";

let server: Server | undefined;
let port = 0;
let tokenFile = "";
let routes: Record<
	string,
	(req: { authorization?: string }, body: unknown) => { status: number; body: unknown }
> = {};

const cleanups: (() => void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
	server = undefined;
});

/** A fake bridge admin API with the S6 shape on an ephemeral port. */
async function startFakeBridge(
	responses?: Record<
		string,
		(req: { authorization?: string }, body: unknown) => { status: number; body: unknown }
	>,
): Promise<number> {
	routes = responses ?? {};
	const dir = tempDir();
	tokenFile = join(dir, "admin-token");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
	chmodSync(tokenFile, 0o600);
	const http = createServer((req, res) => {
		const route = routes[`${req.method} ${req.url?.split("?")[0]}`];
		if (!route) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		let raw = "";
		req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
		req.on("end", () => {
			let body: unknown;
			try {
				body = raw === "" ? undefined : JSON.parse(raw);
			} catch {
				body = undefined;
			}
			const outcome = route({ authorization: req.headers.authorization }, body);
			res.writeHead(outcome.status, { "content-type": "application/json" });
			res.end(JSON.stringify(outcome.body));
		});
	});
	server = http;
	await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
	port = (http.address() as { port: number }).port;
	return port;
}

function proxy() {
	return createChannelProxy({ port, tokenFile });
}

describe("channel proxy (bridge admin client)", () => {
	it("maps GET /status to ChannelInfo with the masked number", async () => {
		await startFakeBridge({
			"GET /status": () => ({
				status: 200,
				body: {
					state: "connected",
					provider: "baileys",
					maskedNumber: "…5678",
					lastActivityAt: "2026-10-23T20:00:00.000Z",
				},
			}),
		});
		const info = await proxy().info();
		expect(info).toEqual({
			id: "whatsapp",
			name: "WhatsApp",
			provider: "baileys",
			status: "connected",
			maskedNumber: "…5678",
			lastActivityAt: "2026-10-23T20:00:00.000Z",
			reachable: true,
		});
	});

	it("reports the channel as off and unreachable when the bridge is not running", async () => {
		await startFakeBridge();
		port = 1; // nothing listens there
		const info = await proxy().info();
		expect(info.status).toBe("off");
		expect(info.reachable).toBe(false);
	});

	it("forwards the allowlist and its changes, and re-reads the token on every request", async () => {
		let current = TOKEN;
		await startFakeBridge({
			"GET /allowlist": (req) =>
				req.authorization === `Bearer ${current}`
					? { status: 200, body: { numbers: ["…5678"] } }
					: { status: 401, body: { error: "unauthorized" } },
			"POST /allowlist": (req, body) => {
				const change = body as { action: string; number: string };
				return req.authorization === `Bearer ${current}`
					? { status: 200, body: { numbers: change.action === "add" ? ["…5678", "…4321"] : [] } }
					: { status: 401, body: { error: "unauthorized" } };
			},
		});
		const p = proxy();
		expect(await p.allowlist()).toEqual(["…5678"]);

		// Rotation: the new token is on disk; the proxy must pick it up without a restart.
		current = "rotated-token-9876543210abcdef";
		writeFileSync(tokenFile, `${current}\n`, { mode: 0o600 });
		expect(await p.allowlist()).toEqual(["…5678"]);

		expect(await p.allowlistChange("add", "5499998765432")).toEqual(["…5678", "…4321"]);
	});

	it("maps /pair/status qr:null to no pairing step and forwards the live QR otherwise", async () => {
		await startFakeBridge({
			"GET /pair/status": () => ({ status: 200, body: { qr: null, expiresInSec: 0, attempts: 0 } }),
		});
		expect(await proxy().pairStatus()).toBeNull();

		await startFakeBridge({
			"GET /pair/status": () => ({ status: 200, body: { qr: "2@payload", expiresInSec: 17, attempts: 2 } }),
		});
		expect(await proxy().pairStatus()).toEqual({ qr: "2@payload", expiresInSec: 17, attempts: 2 });
	});

	it("sends pairing actions and refuses when the bridge answers 409", async () => {
		const state: Record<string, { status: number; body: unknown }> = {};
		await startFakeBridge({
			"POST /pair/start": () => state.start ?? { status: 200, body: { ok: true } },
			"POST /pair/regenerate": () => ({ status: 200, body: { ok: true } }),
			"POST /pair/cancel": () => ({ status: 200, body: { ok: true } }),
		});
		const p = proxy();
		await p.pairStart();
		await p.pairRegenerate();
		await p.pairCancel();

		state.start = { status: 409, body: { error: "cannot start pairing from state connected" } };
		await expect(p.pairStart()).rejects.toThrow();
	});

	it("forwards verify results and unpair", async () => {
		await startFakeBridge({
			"POST /verify": () => ({ status: 200, body: { results: [{ masked: "…5678", ok: true }] } }),
			"POST /unpair": () => ({ status: 200, body: { ok: true } }),
		});
		const p = proxy();
		expect(await p.verify()).toEqual([{ masked: "…5678", ok: true }]);
		await expect(p.unpair()).resolves.toBeUndefined();
	});

	it("rejects a wrong or absent token like any other 401", async () => {
		await startFakeBridge({
			"GET /status": (req) =>
				req.authorization === `Bearer ${TOKEN}`
					? {
							status: 200,
							body: { state: "off", provider: "baileys", maskedNumber: null, lastActivityAt: null },
						}
					: { status: 401, body: {} },
		});
		// Point the proxy at a token file with different content: every call must fail closed.
		const dir = tempDir();
		const wrong = join(dir, "wrong-token");
		writeFileSync(wrong, "other-token\n", { mode: 0o600 });
		const p = createChannelProxy({ port, tokenFile: wrong });
		const info = await p.info();
		expect(info.reachable).toBe(false);
		await expect(p.verify()).rejects.toThrow();
	});
});
