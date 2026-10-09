import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, parseClientMessage } from "../src/index.ts";

const parse = (value: object) => parseClientMessage(JSON.stringify(value));
const UPLOAD = "u_0123456789abcdef";

describe("send with attachments (S31)", () => {
	it("leaves a plain send unchanged", () => {
		expect(parse({ type: "send", text: "hello" })).toEqual({ type: "send", text: "hello" });
		expect(parse({ type: "send", text: "hello", requestId: "r1" })).toEqual({
			type: "send",
			text: "hello",
			requestId: "r1",
		});
		expect(parse({ type: "send", text: "   " })).toBeUndefined();
	});

	it("accepts files uploaded for the message, with or without text", () => {
		const attachments = [
			{ uploadId: UPLOAD, name: "report.pdf" },
			{ uploadId: UPLOAD, name: "photo (2).png", extra: true },
		];
		expect(parse({ type: "send", text: "look", requestId: "r1", attachments })).toEqual({
			type: "send",
			text: "look",
			requestId: "r1",
			attachments: [
				{ uploadId: UPLOAD, name: "report.pdf" },
				{ uploadId: UPLOAD, name: "photo (2).png" },
			],
		});
		expect(parse({ type: "send", text: "", attachments: [{ uploadId: UPLOAD, name: "a.txt" }] })).toEqual({
			type: "send",
			text: "",
			attachments: [{ uploadId: UPLOAD, name: "a.txt" }],
		});
	});

	it("refuses malformed attachments and more files than a message may carry", () => {
		const one = { uploadId: UPLOAD, name: "a.txt" };
		expect(parse({ type: "send", text: "x", attachments: [] })).toBeUndefined();
		expect(parse({ type: "send", text: "", attachments: [] })).toBeUndefined();
		expect(parse({ type: "send", text: "x", attachments: one })).toBeUndefined();
		expect(
			parse({ type: "send", text: "x", attachments: [{ uploadId: "../etc", name: "a" }] }),
		).toBeUndefined();
		expect(parse({ type: "send", text: "x", attachments: [{ uploadId: UPLOAD, name: "" }] })).toBeUndefined();
		expect(
			parse({ type: "send", text: "x", attachments: [{ uploadId: UPLOAD, name: "a/b.txt" }] }),
		).toBeUndefined();
		expect(
			parse({ type: "send", text: "x", attachments: [{ uploadId: UPLOAD, name: "x".repeat(256) }] }),
		).toBeUndefined();
		const many = Array.from({ length: ATTACHMENT_LIMITS.files + 1 }, (_, i) => ({
			uploadId: UPLOAD,
			name: `f${i}.txt`,
		}));
		expect(parse({ type: "send", text: "x", attachments: many })).toBeUndefined();
		expect(parse({ type: "send", text: "x", attachments: many.slice(1) })?.type).toBe("send");
	});

	it("states the limits: 25 MB per file, 10 files and 50 MB per message", () => {
		expect(ATTACHMENT_LIMITS).toEqual({
			fileBytes: 25 * 1024 * 1024,
			messageBytes: 50 * 1024 * 1024,
			files: 10,
		});
	});
});
