import { readFileSync } from "node:fs";
import type { UploadedFile } from "./protocol.ts";

/** The daemon read the upload and refused it; the message explains why and is safe to show. */
export class UploadRefused extends Error {}

/** The daemon's `POST /upload` address, next to its WebSocket address. */
export function uploadUrl(daemonUrl: string): string {
	const url = new URL(daemonUrl);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	url.pathname = url.pathname.replace(/\/ws\/?$/, "") + "/upload";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export interface DaemonUploaderOptions {
	/** The daemon's WebSocket address. */
	daemonUrl: string;
	/** File holding the access key; read again for every upload. */
	tokenFile: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

/**
 * Uploads one file to the daemon (`POST /upload`, gentle-dot S31.2): the raw bytes as the body, the
 * name URI-encoded in `X-File-Name`, the access key only in `Authorization`. Errors never carry the key.
 */
export function daemonUploader(
	options: DaemonUploaderOptions,
): (file: { name: string; data: Buffer; uploadId?: string }) => Promise<UploadedFile> {
	const endpoint = uploadUrl(options.daemonUrl);
	const post = options.fetch ?? fetch;
	return async (file) => {
		let token: string;
		try {
			token = readFileSync(options.tokenFile, "utf8").trim();
		} catch {
			throw new Error("cannot read the access key");
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/octet-stream",
			"X-File-Name": encodeURIComponent(file.name),
		};
		if (file.uploadId) headers["X-Upload-Id"] = file.uploadId;
		const signal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
		let response: Response;
		let body: { message?: unknown } | undefined;
		try {
			response = await post(endpoint, { method: "POST", headers, body: new Uint8Array(file.data), signal });
			body = (await response.json()) as { message?: unknown };
		} catch {
			throw new Error(signal.aborted ? "timed out" : "network error");
		}
		if (response.ok) return body as unknown as UploadedFile;
		if (typeof body?.message === "string") throw new UploadRefused(body.message);
		throw new Error(`HTTP ${response.status}`);
	};
}
