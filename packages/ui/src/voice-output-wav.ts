/** Validate before Blob construction: strict byte values, bounded PCM, complete padded RIFF chunks. */
export function validatedWav(input: number[]): Uint8Array {
	const invalid = () => {
		throw new Error("Invalid or oversized PCM WAV audio");
	};
	if (!Array.isArray(input) || input.length < 44) invalid();
	for (const byte of input) {
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) invalid();
	}
	const bytes = Uint8Array.from(input);
	const view = new DataView(bytes.buffer);
	const tag = (at: number, text: string) =>
		[...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
	if (!tag(0, "RIFF") || !tag(8, "WAVE") || view.getUint32(4, true) !== bytes.length - 8) invalid();
	let formatSeen = false;
	let dataSeen = false;
	let alignment = 0;
	let pcmSize = 0;
	let offset = 12;
	while (offset < bytes.length) {
		if (offset + 8 > bytes.length) invalid();
		const size = view.getUint32(offset + 4, true);
		const start = offset + 8;
		const end = start + size;
		const next = end + (size % 2);
		if (next > bytes.length) invalid();
		if (tag(offset, "fmt ")) {
			if (formatSeen || size < 16) invalid();
			formatSeen = true;
			const encoding = view.getUint16(start, true);
			const channels = view.getUint16(start + 2, true);
			const sampleRate = view.getUint32(start + 4, true);
			const byteRate = view.getUint32(start + 8, true);
			alignment = view.getUint16(start + 12, true);
			const bits = view.getUint16(start + 14, true);
			if (
				encoding !== 1 ||
				!channels ||
				!sampleRate ||
				![8, 16, 24, 32].includes(bits) ||
				alignment !== channels * (bits / 8) ||
				byteRate !== sampleRate * alignment
			)
				invalid();
		} else if (tag(offset, "data")) {
			if (dataSeen || !size || size > 16 * 1024 * 1024) invalid();
			dataSeen = true;
			pcmSize = size;
		}
		offset = next;
	}
	if (!formatSeen || !dataSeen || pcmSize % alignment !== 0) invalid();
	return bytes;
}
