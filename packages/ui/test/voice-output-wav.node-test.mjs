import assert from "node:assert/strict";
import { test } from "node:test";
import { validatedWav } from "../src/voice-output-wav.ts";

// Memory-only PCM16 mono WAV, optionally with an odd-sized ancillary chunk and padding.
function wave(pcmSize = 4, junkSize = 0) {
	const extra = junkSize ? 8 + junkSize + (junkSize % 2) : 0;
	const bytes = new Uint8Array(44 + extra + pcmSize);
	const view = new DataView(bytes.buffer);
	const tag = (at, text) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	if (junkSize) {
		tag(36, "JUNK");
		view.setUint32(40, junkSize, true);
	}
	tag(36 + extra, "data");
	view.setUint32(40 + extra, pcmSize, true);
	return Array.from(bytes);
}
function changedWave(offset, value, width = 1) {
	const bytes = Uint8Array.from(wave());
	const view = new DataView(bytes.buffer);
	if (width === 4) view.setUint32(offset, value, true);
	else if (width === 2) view.setUint16(offset, value, true);
	else bytes[offset] = value;
	return Array.from(bytes);
}

const invalidWaves = [
	["truncated header", () => wave().slice(0, 20)],
	["wrong RIFF signature", () => changedWave(0, 0)],
	["wrong WAVE signature", () => changedWave(8, 0)],
	["inconsistent RIFF length", () => changedWave(4, 0xffffffff, 4)],
	["overflowing chunk length", () => changedWave(40, 0xffffffff, 4)],
	["missing fmt chunk", () => changedWave(12, 0)],
	["missing data chunk", () => changedWave(36, 0)],
	["non-PCM format", () => changedWave(20, 3, 2)],
	["invalid block alignment", () => changedWave(32, 3, 2)],
	["invalid byte rate", () => changedWave(28, 1, 4)],
	["empty PCM", () => wave(0)],
	["partial PCM frame", () => wave(3)],
	[
		"out-of-range byte",
		() => {
			const bytes = wave();
			bytes[44] = 256;
			return bytes;
		},
	],
	[
		"negative byte",
		() => {
			const bytes = wave();
			bytes[44] = -1;
			return bytes;
		},
	],
	[
		"fractional byte",
		() => {
			const bytes = wave();
			bytes[44] = 0.5;
			return bytes;
		},
	],
	[
		"nonfinite byte",
		() => {
			const bytes = wave();
			bytes[44] = NaN;
			return bytes;
		},
	],
];
for (const [name, bytes] of invalidWaves) {
	test(`WAV validation rejects ${name}`, () => {
		assert.throws(() => validatedWav(bytes()), /invalid|oversized.*wav/i);
	});
}

for (const [name, size, accepted] of [
	["16MiB PCM plus header and odd chunk padding", 16 * 1024 * 1024, true],
	["PCM over 16MiB", 16 * 1024 * 1024 + 2, false],
]) {
	test(`WAV bound distinguishes ${name}`, () => {
		const input = wave(size, 3);
		if (accepted) {
			const bytes = validatedWav(input);
			assert.ok(bytes instanceof Uint8Array);
			assert.equal(bytes.length, size + 56);
			assert.deepEqual(bytes, Uint8Array.from(input));
		} else {
			assert.throws(() => validatedWav(input), /invalid|oversized.*wav/i);
		}
	});
}
