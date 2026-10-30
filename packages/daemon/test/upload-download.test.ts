import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { ServerMessage, UploadedFile } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DaemonOptions, type DotDaemon, startDaemon } from "../src/daemon.ts";
import { composePrompt, splitAttachments, UploadStore } from "../src/uploads.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const SECRET = "outside-the-store-secret";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function daemon(extra: Partial<DaemonOptions> & { dataDir?: string } = {}) {
	const dataDir = extra.dataDir ?? tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir, { recursive: true });
	writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Gentle Dot</title>");
	const workspace = join(dataDir, "workspace");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace,
		uiDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		backoffMs: [50],
		...extra,
	});
	daemons.push(d);
	return { d, dataDir, workspace };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

function call(
	d: DotDaemon,
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: d.port,
				path,
				method: options.method ?? "GET",
				headers: options.headers ?? {},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
				);
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

const bearer = (d: DotDaemon, extra: Record<string, string> = {}) => ({
	Authorization: `Bearer ${d.token}`,
	...extra,
});

async function upload(d: DotDaemon, name: string, body: Buffer | string, uploadId?: string) {
	const reply = await call(d, "/upload", {
		method: "POST",
		headers: bearer(d, {
			"X-File-Name": encodeURIComponent(name),
			...(uploadId ? { "X-Upload-Id": uploadId } : {}),
		}),
		body,
	});
	expect(reply.status).toBe(200);
	return JSON.parse(String(reply.body)) as UploadedFile;
}

const fileUrl = (file: { uploadId: string; name: string }) =>
	`/upload/${file.uploadId}/${encodeURIComponent(file.name)}`;

describe("GET /upload/<uploadId>/<name> (S14.7)", () => {
	it("serves an uploaded image with its stored type, inline, never cached or sniffed", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const reply = await call(d, fileUrl(shot), { headers: bearer(d) });
		expect(reply.status).toBe(200);
		expect(reply.body.equals(PNG)).toBe(true);
		expect(reply.headers["content-type"]).toBe("image/png");
		expect(reply.headers["content-length"]).toBe(String(PNG.length));
		expect(reply.headers["content-disposition"]).toBe(
			`inline; filename="shot.png"; filename*=UTF-8''shot.png`,
		);
		expect(reply.headers["x-content-type-options"]).toBe("nosniff");
		expect(reply.headers["cache-control"]).toBe("private, no-store");
		expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("serves any other file as an octet-stream download, with an encoded name", async () => {
		const { d } = await daemon();
		const doc = await upload(d, "notas ñ (1).txt", "plain text, never sniffed as html <script>");
		const reply = await call(d, fileUrl(doc), { headers: bearer(d) });
		expect(reply.status).toBe(200);
		expect(String(reply.body)).toBe("plain text, never sniffed as html <script>");
		expect(reply.headers["content-type"]).toBe("application/octet-stream");
		expect(reply.headers["content-disposition"]).toBe(
			`attachment; filename="notas _ _1_.txt"; filename*=UTF-8''notas%20%C3%B1%20%281%29.txt`,
		);
	});

	it("streams a file larger than one read, byte for byte", async () => {
		const { d } = await daemon();
		const big = Buffer.from(Array.from({ length: 1024 * 1024 + 7 }, (_, i) => (i * 31) % 251));
		const file = await upload(d, "big.bin", big);
		const reply = await call(d, fileUrl(file), { headers: bearer(d) });
		expect(reply.status).toBe(200);
		expect(reply.headers["content-length"]).toBe(String(big.length));
		expect(reply.body.equals(big)).toBe(true);
	});

	it("keeps serving a file after it was sent and after the daemon restarted", async () => {
		const first = await daemon();
		const shot = await upload(first.d, "shot.png", PNG);
		await first.d.close();
		const { d } = await daemon({ dataDir: first.dataDir });
		const reply = await call(d, fileUrl(shot), { headers: bearer(d) });
		expect(reply.status).toBe(200);
		expect(reply.body.equals(PNG)).toBe(true);
		expect(reply.headers["content-type"]).toBe("image/png");
	});

	it("requires the access key in the Authorization header, before saying anything about the file", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const refused: Record<string, string>[] = [
			{},
			{ Authorization: "Bearer wrong" },
			{ Authorization: `Basic ${d.token}` },
		];
		for (const headers of refused) {
			const reply = await call(d, fileUrl(shot), { headers });
			expect(reply.status).toBe(401);
			expect(reply.body.includes(PNG)).toBe(false);
		}
		expect((await call(d, `${fileUrl(shot)}?token=${d.token}`)).status).toBe(401);
		expect((await call(d, "/upload/u_0000000000000000000000/none.txt")).status).toBe(401);
		expect((await call(d, "/upload/../../token")).status).toBe(401);
	});

	it("answers 404 for an unknown upload or name", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		expect((await call(d, `/upload/u_0000000000000000000000/shot.png`, { headers: bearer(d) })).status).toBe(
			404,
		);
		expect((await call(d, `/upload/${shot.uploadId}/other.png`, { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, `/upload/${shot.uploadId}/`, { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, `/upload/${shot.uploadId}`, { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, "/upload/", { headers: bearer(d) })).status).toBe(404);
	});

	it("refuses every way out of the store", async () => {
		const { d, dataDir, workspace } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const id = shot.uploadId;
		writeFileSync(join(workspace, "secret.txt"), SECRET);
		writeFileSync(join(workspace, "uploads", "secret.txt"), SECRET);
		const attempts = [
			`/upload/${id}/..%2F..%2Fsecret.txt`,
			`/upload/${id}/..%2Fsecret.txt`,
			`/upload/${id}/%2e%2e`,
			`/upload/${id}/..`,
			`/upload/${id}/.`,
			`/upload/${id}/../secret.txt`,
			`/upload/${id}/../../secret.txt`,
			`/upload/${id}/..%5C..%5Csecret.txt`,
			`/upload/${id}/..\\..\\secret.txt`,
			`/upload/${id}/sub%2Fshot.png`,
			`/upload/${id}%2Fshot.png`,
			`/upload/${id}/shot.png%00`,
			`/upload/${id}/shot.png%00.txt`,
			`/upload/${id}/%00`,
			`/upload/${id}/%2Fetc%2Fpasswd`,
			`/upload/${id}/${encodeURIComponent(join(workspace, "secret.txt"))}`,
			`/upload/%2Fetc/passwd`,
			`/upload/..%2F${id}/shot.png`,
			`/upload/../token`,
			`/upload/../../token`,
			`/upload/${id}/shot.png/extra`,
			`/upload/${id}/./shot.png`,
			`/upload/./${id}/shot.png`,
			`/upload//${id}/shot.png`,
			`/upload/${id}//shot.png`,
			`/upload/${id}/%E0%A4%A`,
			`/upload/${id}/.shot.png`,
			`/upload/${id.toUpperCase()}/shot.png`,
			`/upload/u_short/shot.png`,
		];
		for (const path of attempts) {
			const reply = await call(d, path, { headers: bearer(d) });
			expect({ path, status: reply.status }).toEqual({ path, status: 404 });
			expect(String(reply.body)).not.toContain(SECRET);
			expect(String(reply.body)).not.toContain(d.token);
			expect(reply.body.includes(PNG)).toBe(false);
		}
		// The data folder's token, through a dot segment the router would otherwise normalize.
		const token = await call(d, `/upload/${id}/../../../token`, { headers: bearer(d) });
		expect(token.status).toBe(404);
		expect(String(token.body)).not.toContain(d.token);
		expect(dataDir).toBeTruthy();
	});

	it("refuses links: a symlinked file, a symlinked upload folder, and a hard link", async () => {
		const { d, workspace } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const outside = join(tempDir(), "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), SECRET, { mode: 0o600 });
		writeFileSync(join(outside, "shot.png"), SECRET, { mode: 0o600 });
		const folder = join(workspace, "uploads", shot.uploadId);
		symlinkSync(join(outside, "secret.txt"), join(folder, "link.txt"));
		linkSync(join(outside, "secret.txt"), join(folder, "hard.txt"));
		const linkedId = "u_LinkedFolder0000000000";
		symlinkSync(outside, join(workspace, "uploads", linkedId));
		for (const path of [
			`/upload/${shot.uploadId}/link.txt`,
			`/upload/${shot.uploadId}/hard.txt`,
			`/upload/${linkedId}/secret.txt`,
			`/upload/${linkedId}/shot.png`,
		]) {
			const reply = await call(d, path, { headers: bearer(d) });
			expect({ path, status: reply.status }).toEqual({ path, status: 404 });
			expect(String(reply.body)).not.toContain(SECRET);
		}
	});

	it("refuses a store whose uploads folder is itself a link", async () => {
		const outside = join(tempDir(), "outside");
		const id = "u_PlantedFolder000000000";
		mkdirSync(join(outside, id), { recursive: true, mode: 0o700 });
		writeFileSync(join(outside, id, "secret.txt"), SECRET, { mode: 0o600 });
		const dataDir = tempDir();
		mkdirSync(join(dataDir, "workspace"), { recursive: true });
		symlinkSync(outside, join(dataDir, "workspace", "uploads"));
		const { d } = await daemon({ dataDir });
		const reply = await call(d, `/upload/${id}/secret.txt`, { headers: bearer(d) });
		expect(reply.status).toBe(404);
		expect(String(reply.body)).not.toContain(SECRET);
	});

	it("refuses files the store did not write: readable by others, or over the size limit", async () => {
		const { d, workspace } = await daemon({ uploadLimits: { fileBytes: 100, messageBytes: 200, files: 10 } });
		const doc = await upload(d, "a.txt", "small");
		const planted = await upload(d, "b.txt", "small");
		const folder = join(workspace, "uploads", doc.uploadId);
		writeFileSync(join(folder, "planted.txt"), SECRET, { mode: 0o644 });
		appendFileSync(join(workspace, "uploads", planted.uploadId, "b.txt"), Buffer.alloc(200));
		expect((await call(d, `/upload/${doc.uploadId}/planted.txt`, { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, fileUrl(planted), { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, fileUrl(doc), { headers: bearer(d) })).status).toBe(200);
	});

	it("allows only GET, and answers the desktop app's preflight", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
			// Node frames a body only for these methods; an unframed one would corrupt the next request.
			const body = ["POST", "PUT", "PATCH"].includes(method) ? "x" : undefined;
			const reply = await call(d, fileUrl(shot), { method, headers: bearer(d), ...(body ? { body } : {}) });
			expect({ method, status: reply.status }).toEqual({ method, status: 405 });
			expect(reply.headers.allow).toBe("GET");
		}
		const preflight = await call(d, fileUrl(shot), {
			method: "OPTIONS",
			headers: {
				Origin: "tauri://localhost",
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "authorization",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe("tauri://localhost");
		expect(preflight.headers["access-control-allow-methods"]).toBe("GET");
		expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toBe("authorization");
	});

	it("checks Origin like POST /upload: a foreign page is refused, the desktop app gets CORS", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const foreign = await call(d, fileUrl(shot), { headers: bearer(d, { Origin: "https://evil.example" }) });
		expect(foreign.status).toBe(403);
		expect(foreign.body.includes(PNG)).toBe(false);
		const foreignPreflight = await call(d, fileUrl(shot), {
			method: "OPTIONS",
			headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
		});
		expect(foreignPreflight.status).toBe(403);
		const app = await call(d, fileUrl(shot), { headers: bearer(d, { Origin: "tauri://localhost" }) });
		expect(app.status).toBe(200);
		expect(app.body.equals(PNG)).toBe(true);
		expect(app.headers["access-control-allow-origin"]).toBe("tauri://localhost");
		expect(app.headers.vary).toBe("Origin");
		const own = await call(d, fileUrl(shot), {
			headers: bearer(d, { Origin: `http://127.0.0.1:${d.port}` }),
		});
		expect(own.status).toBe(200);
		const noKey = await call(d, fileUrl(shot), { headers: { Origin: "tauri://localhost" } });
		expect(noKey.status).toBe(401);
	});

	it("leaves POST /upload and the interface unchanged (regression)", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		expect(shot.path).toBe(`uploads/${shot.uploadId}/shot.png`);
		expect((await call(d, "/upload", { headers: bearer(d) })).status).toBe(405);
		expect((await call(d, "/")).status).toBe(200);
		expect((await call(d, "/other", { method: "POST", body: "x" })).status).toBe(405);
	});

	it("refuses more encodings of a way out (verifier)", async () => {
		const { d, workspace } = await daemon();
		const { uploadId: id } = await upload(d, "shot.png", PNG);
		writeFileSync(join(workspace, "secret.txt"), SECRET);
		for (const path of [
			`/upload/${id}/%C0%AE%C0%AE%C0%AFsecret.txt`,
			`/upload/${id}/%252e%252e%252fsecret.txt`,
			`/upload/${id}/shot.png.`,
			`/upload/${id}/shot.png%20`,
			`/upload/${id}/shot%EF%BC%8Epng`,
			`/upload/${id}/%E2%80%AEgnp.txt`,
			`/upload/${id}/shot.png;x`,
			`/x/../upload/${id}/shot.png`,
			"/upload/%2e%2e/secret.txt",
			`http://127.0.0.1:${d.port}/upload/${id}/shot.png`,
		]) {
			const reply = await call(d, path, { headers: bearer(d) });
			expect({ path, status: reply.status }).toEqual({ path, status: 404 });
			expect(String(reply.body)).not.toContain(SECRET);
		}
	});

	it("answers a missing key the same for a stored and an unknown file, and refuses Origin null (verifier)", async () => {
		const { d } = await daemon();
		const shot = await upload(d, "shot.png", PNG);
		const a = await call(d, fileUrl(shot));
		const b = await call(d, "/upload/u_AAAAAAAAAAAAAAAAAAAAAA/nothere.png");
		expect([a.status, String(a.body)]).toEqual([b.status, String(b.body)]);
		expect((await call(d, fileUrl(shot), { headers: bearer(d, { Origin: "null" }) })).status).toBe(403);
	});

	it("never serves SVG or HTML inline, and 404s a FIFO or a folder without hanging (verifier)", async () => {
		const { d, workspace } = await daemon();
		for (const [name, body] of [
			["x.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"],
			["x.html", "<script>1</script>"],
		] as const) {
			const f = await upload(d, name, body);
			const reply = await call(d, fileUrl(f), { headers: bearer(d) });
			expect(reply.headers["content-type"]).toBe("application/octet-stream");
			expect(String(reply.headers["content-disposition"])).toMatch(/^attachment;/);
		}
		const id = `u_${"F".repeat(22)}`;
		const dir = join(workspace, "uploads", id);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		execFileSync("mkfifo", ["-m", "600", join(dir, "p")]);
		mkdirSync(join(dir, "sub"), { mode: 0o700 });
		expect((await call(d, `/upload/${id}/p`, { headers: bearer(d) })).status).toBe(404);
		expect((await call(d, `/upload/${id}/sub`, { headers: bearer(d) })).status).toBe(404);
	});
});

describe("opening a stored file (S14.7)", () => {
	it("does not open a file that is still being written", async () => {
		const uploads = new UploadStore({ workspace: tempDir() });
		const first = await uploads.receive(Readable.from([Buffer.from("a")]), { name: "a.txt" });
		if (!first.ok) throw new Error(first.message);
		const body = new PassThrough();
		const writing = uploads.receive(body, { name: "b.txt", uploadId: first.file.uploadId });
		body.write("partial");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(uploads.open(first.file.uploadId, "b.txt")).toBeUndefined();
		body.end(" and done");
		const second = await writing;
		expect(second.ok).toBe(true);
		const opened = uploads.open(first.file.uploadId, "b.txt");
		expect(opened).toMatchObject({ name: "b.txt", size: 16, mime: "application/octet-stream" });
		if (opened) closeSync(opened.fd);
	});
});

describe("upload ids on attachments (S14.7)", () => {
	it("reads the upload id back from a stored path, and only from one", () => {
		const id = "u_0123456789abcdefghijkl";
		const file = { name: "shot.png", size: 3, mime: "image/png", path: `/w/uploads/${id}/shot.png` };
		const { message } = composePrompt("look", [file], { images: false });
		expect(splitAttachments(message).attachments).toEqual([
			{ name: "shot.png", size: 3, mime: "image/png", uploadId: id },
		]);
		for (const path of [
			"/w/uploads/u1/shot.png",
			`/w/uploads/${id}/other.png`,
			`/w/elsewhere/${id}/shot.png`,
			`/w/uploads/${id}/../shot.png`,
			"shot.png",
		]) {
			const block = composePrompt("look", [{ ...file, path }], { images: false }).message;
			expect(splitAttachments(block).attachments).toEqual([{ name: "shot.png", size: 3, mime: "image/png" }]);
		}
	});

	it("puts the upload id on live and history attachments, and the URL built from it serves the file", async () => {
		const { d } = await daemon();
		const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
		const messages: ServerMessage[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		await new Promise((resolve) => ws.on("open", resolve));
		ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
		await waitFor(() => messages.some((m) => m.type === "ready"));
		const shot = await upload(d, "shot.png", PNG);
		const doc = await upload(d, "report.txt", "numbers", shot.uploadId);
		ws.send(
			JSON.stringify({
				type: "send",
				text: "look",
				requestId: "r1",
				attachments: [
					{ uploadId: shot.uploadId, name: shot.name },
					{ uploadId: doc.uploadId, name: doc.name },
				],
			}),
		);
		const expected = [
			{ name: "shot.png", size: PNG.length, mime: "image/png", uploadId: shot.uploadId },
			{ name: "report.txt", size: 7, mime: "application/octet-stream", uploadId: shot.uploadId },
		];
		const live = await waitFor(() => messages.find((m) => m.type === "user_message"));
		expect(live.type === "user_message" && live.attachments).toEqual(expected);
		await waitFor(() => messages.find((m) => m.type === "message_done"));
		ws.send(JSON.stringify({ type: "get_history" }));
		const history = await waitFor(() =>
			messages.find((m) => m.type === "history" && m.messages.some((h) => h.role === "user")),
		);
		const user = history.type === "history" ? history.messages.find((m) => m.role === "user") : undefined;
		expect(user?.attachments).toEqual(expected);
		const [first] = user?.attachments ?? [];
		const reply = await call(d, fileUrl({ uploadId: first?.uploadId ?? "", name: first?.name ?? "" }), {
			headers: bearer(d),
		});
		expect(reply.status).toBe(200);
		expect(reply.body.equals(PNG)).toBe(true);
		ws.close();
	});
});
