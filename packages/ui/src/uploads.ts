import type { UploadedFile } from "@gentle-dot/protocol";
import type { ConnectionInfo } from "./client.ts";

/** Uploads one file to the daemon; `uploadId` adds it to the message folder of an earlier file. */
export type Uploader = (
	file: File,
	options: { uploadId?: string; onProgress?: (fraction: number) => void },
) => Promise<UploadedFile>;

/** The daemon's HTTP address, from the WebSocket one: `ws://host:port/ws` → `http://host:port`. */
export function uploadBase(wsUrl: string): string {
	const url = new URL(wsUrl);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	return url.origin;
}

/**
 * `POST /upload` with the raw file (S31.2). XMLHttpRequest, unlike fetch, reports upload
 * progress. The access key goes in the Authorization header, never in the address.
 */
export function createUploader(info: ConnectionInfo, Xhr: typeof XMLHttpRequest = XMLHttpRequest): Uploader {
	const endpoint = `${uploadBase(info.url)}/upload`;
	return (file, options) =>
		new Promise((resolve, reject) => {
			const xhr = new Xhr();
			xhr.open("POST", endpoint);
			xhr.setRequestHeader("Authorization", `Bearer ${info.token}`);
			xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
			if (options.uploadId) xhr.setRequestHeader("X-Upload-Id", options.uploadId);
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
			};
			xhr.onload = () => {
				let body: { message?: unknown } | undefined;
				try {
					body = JSON.parse(xhr.responseText) as { message?: unknown };
				} catch {
					body = undefined;
				}
				if (xhr.status === 200 && body) resolve(body as unknown as UploadedFile);
				else reject(new Error(typeof body?.message === "string" ? body.message : "The upload did not work."));
			};
			xhr.onerror = () => reject(new Error("The upload did not work. Check the connection and try again."));
			xhr.send(file);
		});
}

/** "512 B", "2 KB", "1.5 MB". */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
