/**
 * Uploads a file to the daemon via `POST /upload`.
 */
import { UploadRefused } from "./uploads.js";

export interface Upload {
	name: string;
	data: Buffer;
	uploadId?: string;
}

export interface UploadedFile {
	uploadId: string;
	name: string;
	size: number;
	mime: string;
	path: string;
}

/** A file on its way to the daemon. */
export interface IncomingFile {
	fileId: string;
	name: string;
	size?: number;
}

/** The daemon refused the upload and sent a plain-language reason. */
export class UploadRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UploadRefused";
	}
}

/** The daemon's `POST /upload` response body. */
interface DaemonUploadResponse {
	uploadId: string;
	name: string;
}

/**
 * Downloads a file from the Telegram Bot API file endpoint.
 * Gives up after `timeoutMs` (default 30 s).
 */
export async function uploadToDaemon(
	file: { name: string; data: Buffer },
	options: { upload: (file: { name: string; data: string }) => Promise<UploadedFile> },
): Promise<UploadedFile> {
	const base64 = file.data.toString("base64");
	const stored = await options.upload({ name: file.name, data: base64 });
	return stored;
}

/** Maximum base64 size the daemon accepts in `POST /upload`. */
export const UPLOAD_MAX_BASE64 = 1024 * 1024 * 50; // 50 MB base64