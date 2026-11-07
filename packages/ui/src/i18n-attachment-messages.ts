// Attachment-owned display messages; upload transport/error strings retain their provenance.
export const attachmentEn = {
	"attachment.fileCount": "Too many files: up to {limit} files per message.",
	"attachment.fileSize": "Too large: up to {limit} per file.",
	"attachment.totalSize": "Too large together: up to {limit} per message.",
	"attachment.uploadFailed": "The upload did not work.",
	"attachment.uploadNetwork": "The upload did not work. Check the connection and try again.",
} as const;
export const attachmentEs: Record<keyof typeof attachmentEn, string> = {
	"attachment.fileCount": "Demasiados archivos: hasta {limit} archivos por mensaje.",
	"attachment.fileSize": "Demasiado grande: hasta {limit} por archivo.",
	"attachment.totalSize": "Demasiado grandes en conjunto: hasta {limit} por mensaje.",
	"attachment.uploadFailed": "La subida no ha funcionado.",
	"attachment.uploadNetwork": "La subida no ha funcionado. Comprueba la conexión y vuelve a intentarlo.",
};

/** Renderer-only provenance, supplied at an authored origin, never inferred from text. */
export type AttachmentDisplay =
	| { key: "attachment.fileCount" | "attachment.fileSize" | "attachment.totalSize"; limit: string | number }
	| { key: "attachment.uploadFailed" | "attachment.uploadNetwork" };
