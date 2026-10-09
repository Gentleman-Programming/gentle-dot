import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import {
	ATTACHMENT_LIMITS,
	type AttachmentInfo,
	type AttachmentLimits,
	type AttachmentRef,
	type UploadedFile,
} from "@gentle-dot/protocol";
import { ensurePrivateDir } from "./isolation.ts";

/** A stored file, with its absolute path. */
export interface StoredFile extends AttachmentInfo {
	path: string;
}

export interface UploadRefusal {
	ok: false;
	/** The HTTP status for the refusal. */
	status: number;
	code: string;
	/** Plain words for the user. */
	message: string;
}

export type UploadOutcome = { ok: true; file: UploadedFile } | UploadRefusal;

export type ResolveOutcome = { ok: true; files: StoredFile[] } | { ok: false; code: string; message: string };

/** One message's folder: its stored files, and the bytes taken by them and by uploads still running. */
interface Batch {
	dir: string;
	files: Map<string, StoredFile>;
	writing: Set<string>;
	bytes: number;
	createdAt: number;
}

export interface UploadStoreOptions {
	/** The assistant's workspace; files go to `<workspace>/uploads/<uploadId>/<name>`. */
	workspace: string;
	limits?: AttachmentLimits;
	/** How long an upload that was never sent is kept. Default one hour. */
	ttlMs?: number;
	now?: () => number;
}

const UNSENT_TTL_MS = 60 * 60 * 1000;
/** The longest image passed to the model: about 5 MB once base64-encoded, the strictest provider limit. */
export const MAX_IMAGE_BYTES = 3_750_000;
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION = 16;
const SNIFF_BYTES = 16;
/** Control characters, invisible and direction-changing marks. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const tooLarge = (limits: AttachmentLimits): UploadRefusal => ({
	ok: false,
	status: 413,
	code: "file_too_large",
	message: `This file is too large: up to ${megabytes(limits.fileBytes)} per file.`,
});
const messageTooLarge = (limits: AttachmentLimits): UploadRefusal => ({
	ok: false,
	status: 413,
	code: "message_too_large",
	message: `These files are too large together: up to ${megabytes(limits.messageBytes)} per message.`,
});
const NOT_FOUND = {
	code: "attachment_not_found",
	message: "A file you attached is no longer available. Attach it again.",
};

function megabytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`;
}

/**
 * A safe file name: the last path segment only, without control or invisible characters,
 * a leading dot (hidden files), or a reserved name; "file" when nothing is left.
 */
export function sanitizeName(raw: string): string {
	let name = (raw.split(/[\\/]/).pop() ?? "").normalize("NFC").replace(HIDDEN_CHARS, "");
	name = name
		.replace(/[<>:"|?*]/g, "_")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	let extension = extname(name);
	if (extension.length > MAX_EXTENSION) extension = "";
	let stem = name.slice(0, name.length - extension.length);
	if (stem === "" || RESERVED.test(stem)) stem = "file";
	return `${stem.slice(0, MAX_NAME_LENGTH - extension.length).trimEnd()}${extension}`;
}

/** The type of an image or PDF from its first bytes; anything else is `application/octet-stream`. */
export function sniffMime(head: Buffer): string {
	const starts = (bytes: number[] | string, at = 0) => {
		const expected = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
		return head.length >= at + expected.length && head.subarray(at, at + expected.length).equals(expected);
	};
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts("GIF87a") || starts("GIF89a")) return "image/gif";
	if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
	if (starts("%PDF-")) return "application/pdf";
	return "application/octet-stream";
}

/**
 * Files the user uploads for a message (S31). Each message gets a private folder under
 * `<workspace>/uploads/`; nothing is opened or run. The limits are checked while the bytes
 * arrive, and a refused or broken upload leaves nothing behind. Uploads wait here until a
 * message sends them, once; one never sent is removed after an hour.
 */
export class UploadStore {
	private readonly root: string;
	private readonly limits: AttachmentLimits;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly batches = new Map<string, Batch>();

	constructor(options: UploadStoreOptions) {
		this.root = join(options.workspace, "uploads");
		this.limits = options.limits ?? ATTACHMENT_LIMITS;
		this.ttlMs = options.ttlMs ?? UNSENT_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Streams one file to disk. Without `uploadId` it starts a new message folder; with it, the
	 * file joins that folder. `length` is the size the client declared, refused early when too large.
	 */
	async receive(
		body: Readable,
		request: { name: string; uploadId?: string; length?: number },
	): Promise<UploadOutcome> {
		this.prune();
		const limits = this.limits;
		if (request.length !== undefined && request.length > limits.fileBytes) return tooLarge(limits);
		const uploadId = request.uploadId ?? `u_${randomBytes(16).toString("base64url")}`;
		const known = this.batches.get(uploadId);
		if (request.uploadId !== undefined && !known) {
			return {
				ok: false,
				status: 404,
				code: "upload_not_found",
				message: "That upload is no longer available. Attach the files again.",
			};
		}
		const batch: Batch = known ?? {
			dir: join(this.root, uploadId),
			files: new Map(),
			writing: new Set(),
			bytes: 0,
			createdAt: this.now(),
		};
		if (batch.files.size + batch.writing.size >= limits.files) {
			return {
				ok: false,
				status: 413,
				code: "too_many_files",
				message: `Too many files: up to ${limits.files} per message.`,
			};
		}
		if (request.length !== undefined && batch.bytes + request.length > limits.messageBytes) {
			return messageTooLarge(limits);
		}
		const name = this.freeName(batch, sanitizeName(request.name));
		batch.writing.add(name);
		this.batches.set(uploadId, batch);
		ensurePrivateDir(this.root);
		ensurePrivateDir(batch.dir);
		const path = join(batch.dir, name);
		const written = await this.write(body, path, batch);
		batch.writing.delete(name);
		if (!written.ok) {
			batch.bytes -= written.size;
			removeQuietly(path);
			this.dropIfEmpty(uploadId, batch);
			return written.refusal;
		}
		const file: StoredFile = { name, size: written.size, mime: sniffMime(written.head), path };
		batch.files.set(name, file);
		return {
			ok: true,
			file: { uploadId, name, size: file.size, mime: file.mime, path: `uploads/${uploadId}/${name}` },
		};
	}

	/** The stored files a message refers to, checked against the per-message limits; nothing is used up. */
	resolve(refs: AttachmentRef[]): ResolveOutcome {
		const files: StoredFile[] = [];
		const seen = new Set<string>();
		for (const { uploadId, name } of refs) {
			const file = this.batches.get(uploadId)?.files.get(name);
			const key = `${uploadId}/${name}`;
			if (!file || seen.has(key)) return { ok: false, ...NOT_FOUND };
			seen.add(key);
			files.push(file);
		}
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		if (files.length > this.limits.files || bytes > this.limits.messageBytes) {
			const { code, message } = messageTooLarge(this.limits);
			return { ok: false, code, message };
		}
		return { ok: true, files };
	}

	/** The files were sent: they stay on disk for the assistant, but no other message can send them. */
	consume(refs: AttachmentRef[]): void {
		for (const { uploadId, name } of refs) {
			const batch = this.batches.get(uploadId);
			if (!batch) continue;
			batch.files.delete(name);
			if (batch.files.size === 0 && batch.writing.size === 0) this.batches.delete(uploadId);
		}
	}

	private write(
		body: Readable,
		path: string,
		batch: Batch,
	): Promise<{ ok: true; size: number; head: Buffer } | { ok: false; size: number; refusal: UploadRefusal }> {
		const limits = this.limits;
		return new Promise((resolve) => {
			const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
			let size = 0;
			let head = Buffer.alloc(0);
			let ended = false;
			let settled = false;
			const detach = () => {
				body.off("data", onData);
				body.off("end", onEnd);
				body.off("error", onBroken);
				body.off("close", onClose);
			};
			const fail = (refusal: UploadRefusal) => {
				if (settled) return;
				settled = true;
				detach();
				body.pause();
				out.once("close", () => resolve({ ok: false, size, refusal }));
				out.destroy();
			};
			const onData = (data: Buffer | string) => {
				const chunk = typeof data === "string" ? Buffer.from(data) : data;
				size += chunk.length;
				batch.bytes += chunk.length;
				if (size > limits.fileBytes) return fail(tooLarge(limits));
				if (batch.bytes > limits.messageBytes) return fail(messageTooLarge(limits));
				if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES)]);
				if (!out.write(chunk)) {
					body.pause();
					out.once("drain", () => body.resume());
				}
			};
			const onEnd = () => {
				ended = true;
				detach();
				out.end();
			};
			const onBroken = () =>
				fail({
					ok: false,
					status: 400,
					code: "upload_failed",
					message: "The upload did not finish. Try again.",
				});
			const onClose = () => {
				if (!ended) onBroken();
			};
			out.on("error", onBroken);
			out.on("close", () => {
				if (settled) return;
				settled = true;
				resolve({ ok: true, size, head: head.subarray(0, SNIFF_BYTES) });
			});
			body.on("data", onData);
			body.on("end", onEnd);
			body.on("error", onBroken);
			body.on("close", onClose);
			body.resume();
		});
	}

	/** The name, or "name (2).ext", "name (3).ext"… when the folder already has it. */
	private freeName(batch: Batch, name: string): string {
		const taken = (candidate: string) =>
			batch.files.has(candidate) || batch.writing.has(candidate) || existsSync(join(batch.dir, candidate));
		if (!taken(name)) return name;
		const extension = extname(name);
		const stem = name.slice(0, name.length - extension.length);
		for (let n = 2; ; n++) {
			const candidate = `${stem} (${n})${extension}`;
			if (!taken(candidate)) return candidate;
		}
	}

	private dropIfEmpty(uploadId: string, batch: Batch): void {
		if (batch.files.size > 0 || batch.writing.size > 0) return;
		this.batches.delete(uploadId);
		try {
			rmdirSync(batch.dir);
		} catch {
			// Not empty or already gone.
		}
	}

	/** Removes message folders that were never sent. */
	private prune(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [uploadId, batch] of this.batches) {
			if (batch.createdAt > cutoff || batch.writing.size > 0) continue;
			this.batches.delete(uploadId);
			rmSync(batch.dir, { recursive: true, force: true });
		}
	}
}

function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Never created, or already removed.
	}
}

const INTRO =
	"The user attached these files, saved in your workspace. Read them with your tools when needed.";
const BLOCK_START = "<attachments>";
const BLOCK_END = "</attachments>";

/**
 * The prompt for a message with files: the user's text, then a block with each file's name, size,
 * type, and absolute path. Images go to the model as images only when it accepts them.
 */
export function composePrompt(
	text: string,
	files: StoredFile[],
	options: { images: boolean | undefined; read?: (path: string) => Buffer },
): { message: string; images?: { type: "image"; mimeType: string; data: string }[] } {
	const read = options.read ?? ((path: string) => readFileSync(path));
	const images: { type: "image"; mimeType: string; data: string }[] = [];
	const lines = files.map((file) => {
		const entry: Record<string, unknown> = {
			name: file.name,
			size: file.size,
			type: file.mime,
			path: file.path,
		};
		if (IMAGE_TYPES.has(file.mime)) {
			if (file.size > MAX_IMAGE_BYTES) entry.image = "too large to show you; read it from the path if needed";
			else if (options.images === true) {
				images.push({ type: "image", mimeType: file.mime, data: read(file.path).toString("base64") });
				entry.image = "attached to this message";
			} else entry.image = "saved, but the current model cannot see images";
		}
		return JSON.stringify(entry);
	});
	const block = [BLOCK_START, INTRO, ...lines, BLOCK_END].join("\n");
	const message = text === "" ? block : `${text}\n\n${block}`;
	return images.length > 0 ? { message, images } : { message };
}

/** Splits a user message into the text the user typed and the chips of the files the daemon appended. */
export function splitAttachments(message: string): { text: string; attachments: AttachmentInfo[] } {
	const none = { text: message, attachments: [] };
	if (!message.endsWith(`\n${BLOCK_END}`)) return none;
	const start = message.lastIndexOf(`${BLOCK_START}\n${INTRO}\n`);
	if (start < 0 || (start > 0 && message.slice(start - 2, start) !== "\n\n")) return none;
	const lines = message
		.slice(start, -BLOCK_END.length - 1)
		.split("\n")
		.slice(2);
	const attachments: AttachmentInfo[] = [];
	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return none;
		}
		const { name, size, type } = entry;
		if (typeof name !== "string" || typeof size !== "number" || typeof type !== "string") return none;
		attachments.push({ name, size, mime: type });
	}
	if (attachments.length === 0) return none;
	return { text: message.slice(0, Math.max(0, start - 2)), attachments };
}
