/**
 * Strict JSONL framing for the Pi RPC protocol: records are split on LF bytes
 * only. Node's `readline` is deliberately avoided because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings.
 */
export declare class JsonlDecoder {
	private pending;
	private readonly onRecord;
	private readonly onMalformed;
	constructor(onRecord: (record: unknown) => void, onMalformed?: (line: string) => void);
	push(chunk: Buffer): void;
	private emit;
}
export declare function encodeRecord(record: unknown): string;
