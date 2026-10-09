import { describe, expect, it } from "vitest";
import { encodeRecord, JsonlDecoder } from "../src/jsonl.ts";

function decodeAll(chunks: Buffer[]) {
	const records: unknown[] = [];
	const errors: string[] = [];
	const decoder = new JsonlDecoder(
		(record) => records.push(record),
		(line) => errors.push(line),
	);
	for (const chunk of chunks) decoder.push(chunk);
	return { records, errors };
}

describe("JsonlDecoder", () => {
	it("splits records only on LF and keeps U+2028/U+2029 inside strings", () => {
		const text = `${JSON.stringify({ a: "x\u2028y\u2029z" })}\n${JSON.stringify({ b: 1 })}\n`;
		const { records } = decodeAll([Buffer.from(text)]);
		expect(records).toEqual([{ a: "x\u2028y\u2029z" }, { b: 1 }]);
	});

	it("joins records split across chunks, including inside a multi-byte character", () => {
		const bytes = Buffer.from(`${JSON.stringify({ text: "año ✓" })}\n`);
		const { records } = decodeAll([bytes.subarray(0, 12), bytes.subarray(12)]);
		expect(records).toEqual([{ text: "año ✓" }]);
	});

	it("accepts CRLF and ignores blank lines", () => {
		const { records } = decodeAll([Buffer.from('{"a":1}\r\n\n{"b":2}\n')]);
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports malformed lines without stopping", () => {
		const { records, errors } = decodeAll([Buffer.from('not json\n{"ok":true}\n')]);
		expect(errors).toEqual(["not json"]);
		expect(records).toEqual([{ ok: true }]);
	});

	it("encodes one record per line", () => {
		expect(encodeRecord({ type: "get_state" })).toBe('{"type":"get_state"}\n');
	});
});
