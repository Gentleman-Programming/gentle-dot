#!/usr/bin/env node
// Renders the PWA icons with Playwright's Chromium (same approach as
// apps/desktop/scripts/make-icon.mjs). Neon rose on the dark squircle:
//   public/icon-192.png, icon-512.png        any-purpose icons
//   public/icon-maskable-512.png             maskable: rose inside the 80% safe zone
// Usage: node scripts/make-pwa-icons.mjs
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const OUT = here("../public/");

// The rose glyph from the brand sheet, stroked in the pink accent on the dark background.
const glyph = fileURLToPath(new URL("../../../docs/brand/rose-glyph.svg", import.meta.url));
const strokes = (await import("node:fs")).readFileSync(glyph, "utf8").matchAll(/<path d="([^"]+)"/g);
const paths = [...strokes].map((m) => m[1]).join("");

function iconSvg({ size, inset }) {
	// The glyph's viewBox is 24x24 (rose-glyph.svg); inset scales the rose for the safe zone.
	const scale = (size - inset) / 24;
	return `<!doctype html><style>html,body{margin:0;background:#1a1218}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g fill="none" stroke="#f095c8" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"
     transform="translate(${inset / 2} ${inset / 2}) scale(${scale})">${paths}</g>
</svg>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await mkdir(OUT, { recursive: true });
for (const [name, size, inset] of [
	["icon-192.png", 192, 24],
	["icon-512.png", 512, 64],
	["icon-maskable-512.png", 512, 154], // 30% margin: the rose stays inside the maskable safe zone
]) {
	await page.setContent(iconSvg({ size, inset }));
	await page.locator("svg").screenshot({ path: `${OUT}${name}` });
	console.log(`wrote ${name}`);
}
await browser.close();
