import { expect, it } from "vitest";
import {
	type AttachmentInfo,
	type HistoryMessage,
	PROTOCOL_VERSION,
	type ServerPayload,
	type UploadedFile,
} from "../src/index.ts";

it("keeps v1 messages and attachments valid without times or upload ids", () => {
	const attachment: AttachmentInfo = { name: "a.txt", size: 1, mime: "application/octet-stream" };
	const message: HistoryMessage = {
		id: "h1",
		role: "user",
		text: "hi",
		activities: [],
		attachments: [attachment],
	};
	const payloads: ServerPayload[] = [
		{ type: "user_message", messageId: "u1", text: "hi" },
		{ type: "message_done", messageId: "m1", text: "hello" },
	];
	expect(PROTOCOL_VERSION).toBe(1);
	expect(message).not.toHaveProperty("at");
	expect(attachment).not.toHaveProperty("uploadId");
	expect(payloads.every((p) => !("at" in p))).toBe(true);
});

it("types message times and attachment upload ids as additive v1 fields (S14.7)", () => {
	const attachment: AttachmentInfo = { name: "a.png", size: 1, mime: "image/png", uploadId: "u_x" };
	const payloads: ServerPayload[] = [
		{ type: "user_message", messageId: "u1", text: "hi", attachments: [attachment], at: 1 },
		{ type: "message_done", messageId: "m1", text: "hello", at: 2 },
		{ type: "history", messages: [{ id: "h1", role: "user", text: "hi", activities: [], at: 3 }] },
	];
	const uploaded: UploadedFile = {
		uploadId: "u_x",
		name: "a.png",
		size: 1,
		mime: "image/png",
		path: "uploads/u_x/a.png",
	};
	expect(payloads.map((p) => p.type)).toEqual(["user_message", "message_done", "history"]);
	expect(uploaded.uploadId).toBe(attachment.uploadId);
});
