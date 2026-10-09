import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { UploadedFile } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type DaemonOptions, type DotDaemon, startDaemon } from "../src/daemon.ts";
import { composePrompt, sanitizeName, sniffMime, splitAttachments, UploadStore } from "../src/uploads.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

describe("file names", () => {
	it("keeps only a safe base name", () => {
		expect(sanitizeName("report.pdf")).toBe("report.pdf");
		expect(sanitizeName("../x")).toBe("x");
		expect(sanitizeName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
		expect(sanitizeName(".env")).toBe("env");
		expect(sanitizeName("...hidden")).toBe("hidden");
		expect(sanitizeName("bad\u0000na\nme\u202e.txt")).toBe("badname.txt");
		expect(sanitizeName("..")).toBe("file");
		expect(sanitizeName("")).toBe("file");
		expect(sanitizeName("   ")).toBe("file");
		expect(sanitizeName("CON")).toBe("file");
		expect(sanitizeName("nul.txt")).toBe("file.txt");
		const long = sanitizeName(`${"a".repeat(300)}.png`);
		expect(long.length).toBeLessThanOrEqual(120);
		expect(long.endsWith(".png")).toBe(true);
	});
});

describe("image types", () => {
	it("tells PNG, JPEG, GIF, and WebP by their first bytes, never by the name", () => {
		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(JPEG)).toBe("image/jpeg");
		expect(sniffMime(GIF)).toBe("image/gif");
		expect(sniffMime(WEBP)).toBe("image/webp");
		expect(sniffMime(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
		expect(sniffMime(Buffer.from("plain text"))).toBe("application/octet-stream");
		expect(sniffMime(Buffer.alloc(0))).toBe("application/octet-stream");
	});
});

function store(limits = { fileBytes: 100, messageBytes: 150, files: 3 }) {
	const workspace = tempDir();
	return { workspace, uploads: new UploadStore({ workspace, limits }) };
}

const listUploads = (workspace: string) => {
	const root = join(workspace, "uploads");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true }).map(String).sort();
};

describe("upload store", () => {
	it("stores a file privately under uploads/<id>/<name> and reports its metadata", async () => {
		const { workspace, uploads } = store();
		const outcome = await uploads.receive(Readable.from([PNG]), { name: "../shot.png" });
		if (!outcome.ok) throw new Error(outcome.message);
		const { uploadId, name, size, mime, path } = outcome.file;
		expect({ name, size, mime }).toEqual({ name: "shot.png", size: PNG.length, mime: "image/png" });
		expect(uploadId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
		expect(path).toBe(`uploads/${uploadId}/shot.png`);
		const file = join(workspace, path);
		expect(readFileSync(file)).toEqual(PNG);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(workspace, "uploads", uploadId)).mode & 0o777).toBe(0o700);
		expect(statSync(join(workspace, "uploads")).mode & 0o777).toBe(0o700);
	});

	it("adds files to the same message folder, renaming duplicates", async () => {
		const { uploads } = store();
		const first = await uploads.receive(Readable.from(["a"]), { name: "notes.txt" });
		if (!first.ok) throw new Error(first.message);
		const uploadId = first.file.uploadId;
		const second = await uploads.receive(Readable.from(["b"]), { name: "notes.txt", uploadId });
		const third = await uploads.receive(Readable.from(["c"]), { name: "../notes.txt", uploadId });
		expect(second.ok && second.file.name).toBe("notes (2).txt");
		expect(third.ok && third.file.name).toBe("notes (3).txt");
		expect(second.ok && second.file.uploadId).toBe(uploadId);
	});

	it("refuses a file over the per-file limit while it streams, and leaves nothing behind", async () => {
		const { workspace, uploads } = store();
		const outcome = await uploads.receive(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), {
			name: "big.bin",
		});
		expect(outcome).toMatchObject({ ok: false, status: 413, code: "file_too_large" });
		expect(outcome.ok ? "" : outcome.message).toMatch(/too large/i);
		expect(listUploads(workspace)).toEqual([]);
	});

	it("refuses a declared size over the limit before reading anything", async () => {
		const { workspace, uploads } = store();
		const outcome = await uploads.receive(Readable.from([]), { name: "big.bin", length: 101 });
		expect(outcome).toMatchObject({ ok: false, status: 413, code: "file_too_large" });
		expect(listUploads(workspace)).toEqual([]);
	});

	it("enforces the per-message size and file count, keeping the files already stored", async () => {
		const { workspace, uploads } = store();
		const first = await uploads.receive(Readable.from([Buffer.alloc(100)]), { name: "a.bin" });
		if (!first.ok) throw new Error(first.message);
		const uploadId = first.file.uploadId;
		const over = await uploads.receive(Readable.from([Buffer.alloc(30), Buffer.alloc(30)]), {
			name: "b.bin",
			uploadId,
		});
		expect(over).toMatchObject({ ok: false, status: 413, code: "message_too_large" });
		expect(listUploads(workspace)).toEqual([uploadId, `${uploadId}/a.bin`]);
		await uploads.receive(Readable.from(["x"]), { name: "c.bin", uploadId });
		await uploads.receive(Readable.from(["x"]), { name: "d.bin", uploadId });
		const fourth = await uploads.receive(Readable.from(["x"]), { name: "e.bin", uploadId });
		expect(fourth).toMatchObject({ ok: false, status: 413, code: "too_many_files" });
	});

	it("removes a partial file when the upload breaks off", async () => {
		const { workspace, uploads } = store();
		const body = new Readable({ read() {} });
		const pending = uploads.receive(body, { name: "cut.bin" });
		body.push(Buffer.alloc(10));
		await new Promise((resolve) => setTimeout(resolve, 20));
		body.destroy(new Error("connection reset"));
		expect(await pending).toMatchObject({ ok: false, code: "upload_failed" });
		expect(listUploads(workspace)).toEqual([]);
	});

	it("refuses an unknown message folder", async () => {
		const { uploads } = store();
		const outcome = await uploads.receive(Readable.from(["x"]), {
			name: "a.txt",
			uploadId: "u_00000000000000000000",
		});
		expect(outcome).toMatchObject({ ok: false, status: 404, code: "upload_not_found" });
	});

	it("hands out stored files once: unknown names and used uploads are refused", async () => {
		const { workspace, uploads } = store();
		const sent = await uploads.receive(Readable.from(["hello"]), { name: "a.txt" });
		if (!sent.ok) throw new Error(sent.message);
		const ref = { uploadId: sent.file.uploadId, name: "a.txt" };
		expect(uploads.resolve([{ ...ref, name: "zzz.txt" }])).toMatchObject({ ok: false });
		expect(uploads.resolve([{ uploadId: "u_00000000000000000000", name: "a.txt" }])).toMatchObject({
			ok: false,
		});
		const found = uploads.resolve([ref]);
		expect(found).toMatchObject({
			ok: true,
			files: [
				{
					name: "a.txt",
					size: 5,
					mime: "application/octet-stream",
					path: join(workspace, "uploads", ref.uploadId, "a.txt"),
				},
			],
		});
		uploads.consume([ref]);
		expect(uploads.resolve([ref])).toMatchObject({ ok: false, code: "attachment_not_found" });
		// The file itself stays for the assistant to read.
		expect(existsSync(join(workspace, "uploads", ref.uploadId, "a.txt"))).toBe(true);
	});
});

describe("the prompt for a message with files", () => {
	const doc = { name: "report.pdf", size: 1234, mime: "application/pdf", path: "/w/uploads/u1/report.pdf" };
	const image = { name: "shot.png", size: PNG.length, mime: "image/png", path: "/w/uploads/u1/shot.png" };
	const read = () => PNG;

	it("appends a block with each file's name and absolute path", () => {
		const { message, images } = composePrompt("summarize this", [doc], { images: true, read });
		expect(message.startsWith("summarize this\n\n<attachments>\n")).toBe(true);
		expect(message).toContain('"path":"/w/uploads/u1/report.pdf"');
		expect(message).toContain('"name":"report.pdf"');
		expect(images).toBeUndefined();
	});

	it("passes images to a model that accepts them, and notes it when the model does not", () => {
		const seeing = composePrompt("", [image], { images: true, read });
		expect(seeing.images).toEqual([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
		expect(seeing.message.startsWith("<attachments>\n")).toBe(true);
		const blind = composePrompt("what is it", [image], { images: false, read });
		expect(blind.images).toBeUndefined();
		expect(blind.message).toMatch(/cannot see images/);
		const unknown = composePrompt("what is it", [image], { images: undefined, read });
		expect(unknown.images).toBeUndefined();
	});

	it("does not pass an image that is too large to show", () => {
		const huge = { ...image, size: 20 * 1024 * 1024 };
		const { images, message } = composePrompt("x", [huge], { images: true, read });
		expect(images).toBeUndefined();
		expect(message).toMatch(/too large/);
	});

	it("reads back the user's own text and the attachment chips", () => {
		const { message } = composePrompt("summarize this", [doc, image], { images: true, read });
		expect(splitAttachments(message)).toEqual({
			text: "summarize this",
			attachments: [
				{ name: "report.pdf", size: 1234, mime: "application/pdf" },
				{ name: "shot.png", size: PNG.length, mime: "image/png" },
			],
		});
		expect(splitAttachments(composePrompt("", [doc], { images: true, read }).message).text).toBe("");
		expect(splitAttachments("no files here")).toEqual({ text: "no files here", attachments: [] });
		const typed = "look: <attachments>\nnot a block\n</attachments>";
		expect(splitAttachments(typed)).toEqual({ text: typed, attachments: [] });
	});
});

// ---------------------------------------------------------------- over HTTP

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function daemon(extra: Partial<DaemonOptions> = {}) {
	const dataDir = tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir);
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
	return { d, workspace };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function post(
	d: DotDaemon,
	options: { path?: string; method?: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: d.port,
				path: options.path ?? "/upload",
				method: options.method ?? "POST",
				headers: options.headers ?? {},
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

const auth = (d: DotDaemon, name = "notes.txt", extra: Record<string, string> = {}) => ({
	Authorization: `Bearer ${d.token}`,
	"X-File-Name": encodeURIComponent(name),
	"Content-Type": "application/octet-stream",
	...extra,
});

describe("POST /upload", () => {
	it("requires the access key in the Authorization header, never in the address", async () => {
		const { d, workspace } = await daemon();
		const missing = await post(d, { headers: { "X-File-Name": "a.txt" }, body: "x" });
		expect(missing.status).toBe(401);
		const wrong = await post(d, { headers: { ...auth(d), Authorization: "Bearer wrong" }, body: "x" });
		expect(wrong.status).toBe(401);
		const query = await post(d, {
			path: `/upload?token=${d.token}`,
			headers: { "X-File-Name": "a.txt" },
			body: "x",
		});
		expect(query.status).toBe(401);
		expect(listUploads(workspace)).toEqual([]);
	});

	it("rejects a foreign Origin, like the WebSocket", async () => {
		const { d, workspace } = await daemon();
		const reply = await post(d, { headers: { ...auth(d), Origin: "https://evil.example" }, body: "x" });
		expect(reply.status).toBe(403);
		const preflight = await post(d, {
			method: "OPTIONS",
			headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
		});
		expect(preflight.status).toBe(403);
		expect(listUploads(workspace)).toEqual([]);
	});

	it("answers the desktop app's preflight and stores its file", async () => {
		const { d, workspace } = await daemon();
		const preflight = await post(d, {
			method: "OPTIONS",
			headers: {
				Origin: "tauri://localhost",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization,x-file-name,x-upload-id,content-type",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe("tauri://localhost");
		expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-upload-id");
		const reply = await post(d, {
			headers: auth(d, "../../shot.png", { Origin: "tauri://localhost" }),
			body: PNG,
		});
		expect(reply.status).toBe(200);
		expect(reply.headers["access-control-allow-origin"]).toBe("tauri://localhost");
		const file = JSON.parse(reply.body) as UploadedFile;
		expect(file).toMatchObject({ name: "shot.png", size: PNG.length, mime: "image/png" });
		expect(file.path).toBe(`uploads/${file.uploadId}/shot.png`);
		expect(statSync(join(workspace, file.path)).mode & 0o777).toBe(0o600);
		expect(statSync(join(workspace, "uploads", file.uploadId)).mode & 0o777).toBe(0o700);
	});

	it("enforces the size limits on the server and cleans up", async () => {
		const { d, workspace } = await daemon({
			uploadLimits: { fileBytes: 1000, messageBytes: 1500, files: 10 },
		});
		const declared = await post(d, {
			headers: auth(d, "big.bin", { "Content-Length": "5000" }),
			body: Buffer.alloc(5000),
		});
		expect(declared.status).toBe(413);
		expect(JSON.parse(declared.body)).toMatchObject({ code: "file_too_large" });
		const streamed = await post(d, {
			headers: { ...auth(d, "big.bin"), "Transfer-Encoding": "chunked" },
			body: Buffer.alloc(5000),
		});
		expect(streamed.status).toBe(413);
		await waitFor(() => listUploads(workspace).length === 0);
	});

	it("refuses an unknown upload id and a request without a file name", async () => {
		const { d } = await daemon();
		const unknown = await post(d, {
			headers: auth(d, "a.txt", { "X-Upload-Id": "u_00000000000000000000" }),
			body: "x",
		});
		expect(unknown.status).toBe(404);
		const nameless = await post(d, { headers: { Authorization: `Bearer ${d.token}` }, body: "x" });
		expect(nameless.status).toBe(400);
	});

	it("removes the partial file when the client hangs up mid-upload", async () => {
		const { d, workspace } = await daemon();
		await new Promise<void>((resolve) => {
			const req = request({
				host: "127.0.0.1",
				port: d.port,
				path: "/upload",
				method: "POST",
				headers: { ...auth(d, "cut.bin"), "Content-Length": "100000" },
			});
			req.on("error", () => resolve());
			req.write(Buffer.alloc(1000));
			setTimeout(() => {
				req.destroy();
				resolve();
			}, 100);
		});
		await waitFor(() => listUploads(workspace).length === 0 || undefined);
		expect(listUploads(workspace)).toEqual([]);
	});

	it("still serves the interface and refuses other methods elsewhere", async () => {
		const { d } = await daemon();
		expect((await post(d, { path: "/", method: "GET" })).status).toBe(200);
		expect((await post(d, { path: "/other", method: "POST", body: "x" })).status).toBe(405);
	});
});
