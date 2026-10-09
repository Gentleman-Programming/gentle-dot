/**
 * Strict JSONL framing for the Pi RPC protocol: records are split on LF bytes
 * only. Node's `readline` is deliberately avoided because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings.
 */
export class JsonlDecoder {
	private pending: Buffer = Buffer.alloc(0);
	private readonly onRecord: (record: unknown) => void;
	private readonly onMalformed: (line: string) => void;

	constructor(onRecord: (record: unknown) => void, onMalformed: (line: string) => void = () => {}) {
		this.onRecord = onRecord;
		this.onMalformed = onMalformed;
	}

	push(chunk: Buffer): void {
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		let newline = this.pending.indexOf(0x0a);
		while (newline >= 0) {
			let end = newline;
			if (end > 0 && this.pending[end - 1] === 0x0d) end -= 1;
			const line = this.pending.subarray(0, end).toString("utf8");
			this.pending = this.pending.subarray(newline + 1);
			if (line.trim() !== "") this.emit(line);
			newline = this.pending.indexOf(0x0a);
		}
	}

	private emit(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.onMalformed(line);
			return;
		}
		this.onRecord(record);
	}
}

export function encodeRecord(record: unknown): string {
	return `${JSON.stringify(record)}\n`;
}
