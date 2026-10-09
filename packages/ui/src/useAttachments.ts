import { ATTACHMENT_LIMITS, type AttachmentRef, type UploadedFile } from "@gentle-dot/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { formatSize, type Uploader } from "./uploads.ts";

/** A file the user attached to the message they are writing. */
export interface PendingFile {
	id: string;
	file: File;
	/** Uploading: 0 to 1. */
	progress?: number;
	uploaded?: UploadedFile;
	/** It cannot be sent (over a limit); the user removes it. */
	refused?: string;
	/** The last upload failed; sending again retries it. */
	error?: string;
}

export interface AttachmentControls {
	files: PendingFile[];
	uploading: boolean;
	add(files: File[]): void;
	remove(id: string): void;
	/** Uploads what is not uploaded yet, one message folder for all; undefined when one failed. */
	upload(): Promise<AttachmentRef[] | undefined>;
	clear(): void;
}

let nextId = 0;

/** The files of the message being written (S31.1); undefined without an uploader. */
export function useAttachments(uploader?: Uploader): AttachmentControls | undefined {
	const [files, setFiles] = useState<PendingFile[]>([]);
	const [uploading, setUploading] = useState(false);
	const current = useRef(files);
	current.current = files;

	const update = useCallback((id: string, change: (file: PendingFile) => PendingFile) => {
		setFiles((list) => {
			const next = list.map((f) => (f.id === id ? change(f) : f));
			current.current = next;
			return next;
		});
	}, []);

	const add = useCallback((added: File[]) => {
		setFiles((list) => {
			const next = [...list];
			for (const file of added) {
				const kept = next.filter((f) => !f.refused);
				const bytes = kept.reduce((sum, f) => sum + f.file.size, 0);
				const item: PendingFile = { id: `a${++nextId}`, file };
				if (kept.length >= ATTACHMENT_LIMITS.files) {
					item.refused = `Too many files: up to ${ATTACHMENT_LIMITS.files} files per message.`;
				} else if (file.size > ATTACHMENT_LIMITS.fileBytes) {
					item.refused = `Too large: up to ${formatSize(ATTACHMENT_LIMITS.fileBytes)} per file.`;
				} else if (bytes + file.size > ATTACHMENT_LIMITS.messageBytes) {
					item.refused = `Too large together: up to ${formatSize(ATTACHMENT_LIMITS.messageBytes)} per message.`;
				}
				next.push(item);
			}
			current.current = next;
			return next;
		});
	}, []);

	const remove = useCallback((id: string) => {
		setFiles((list) => {
			const next = list.filter((f) => f.id !== id);
			current.current = next;
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		current.current = [];
		setFiles([]);
	}, []);

	const upload = useCallback(async (): Promise<AttachmentRef[] | undefined> => {
		if (!uploader) return undefined;
		const list = current.current;
		if (list.some((f) => f.refused)) return undefined;
		setUploading(true);
		let uploadId = list.find((f) => f.uploaded)?.uploaded?.uploadId;
		const refs: AttachmentRef[] = [];
		let failed = false;
		try {
			for (const item of list) {
				let done = item.uploaded;
				if (!done) {
					update(item.id, ({ error: _error, ...f }) => ({ ...f, progress: 0 }));
					try {
						done = await uploader(item.file, {
							...(uploadId ? { uploadId } : {}),
							onProgress: (progress) => update(item.id, (f) => ({ ...f, progress })),
						});
						const uploaded = done;
						update(item.id, ({ progress: _progress, ...f }) => ({ ...f, uploaded }));
					} catch (error) {
						failed = true;
						const message = (error as Error).message || "The upload did not work.";
						update(item.id, ({ progress: _progress, ...f }) => ({ ...f, error: message }));
						continue;
					}
				}
				uploadId ??= done.uploadId;
				refs.push({ uploadId: done.uploadId, name: done.name });
			}
		} finally {
			setUploading(false);
		}
		return failed ? undefined : refs;
	}, [uploader, update]);

	return useMemo(
		() => (uploader ? { files, uploading, add, remove, upload, clear } : undefined),
		[uploader, files, uploading, add, remove, upload, clear],
	);
}
