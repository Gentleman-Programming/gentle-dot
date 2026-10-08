#!/usr/bin/env node
// Writes a filled, anti-aliased circle on a transparent background as an RGBA PNG.
// Usage: node scripts/make-icon.mjs <out.png> [size=1024] [hex=#7C5CFF]
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const [out, sizeArg = "1024", hex = "#7C5CFF"] = process.argv.slice(2);
if (!out) {
	console.error("usage: make-icon.mjs <out.png> [size] [hex]");
	process.exit(1);
}
const size = Number(sizeArg);
const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

// Each scanline starts with filter byte 0 (None), followed by RGBA pixels.
const raw = Buffer.alloc(size * (size * 4 + 1));
const center = size / 2;
const radius = size / 2 - Math.max(1, size / 64);
const samples = 4;
for (let y = 0; y < size; y++) {
	const row = y * (size * 4 + 1);
	for (let x = 0; x < size; x++) {
		// Supersample each pixel so the edge is smooth at small sizes.
		let covered = 0;
		for (let sy = 0; sy < samples; sy++) {
			for (let sx = 0; sx < samples; sx++) {
				const dx = x + (sx + 0.5) / samples - center;
				const dy = y + (sy + 0.5) / samples - center;
				if (dx * dx + dy * dy <= radius * radius) covered++;
			}
		}
		const offset = row + 1 + x * 4;
		raw[offset] = r;
		raw[offset + 1] = g;
		raw[offset + 2] = b;
		raw[offset + 3] = Math.round((covered / (samples * samples)) * 255);
	}
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; // bit depth
header[9] = 6; // color type: RGBA
writeFileSync(
	out,
	Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]),
);
console.log(`wrote ${out} (${size}x${size}, ${hex})`);
