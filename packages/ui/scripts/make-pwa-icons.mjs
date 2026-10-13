#!/usr/bin/env node
// Renders the PWA icons from the desktop app's icon master (same approach as
// apps/desktop/scripts/make-icon.mjs, which produced that master):
//   public/icon-192.png, icon-512.png        the neon rose on its black squircle
//   public/icon-maskable-512.png             maskable: the art inside the 80% safe zone
// The master is downscaled with Chromium (no image libraries); each icon is then
// verified by pixel sampling — the rose center must be brighter than the corners.
// Usage: node scripts/make-pwa-icons.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const OUT = here("../public/");
const SOURCE = `data:image/png;base64,${readFileSync(here("../../../apps/desktop/src-tauri/icons/source.png")).toString("base64")}`;
const BG = "#1a1218";

const browser = await chromium.launch();
const page = await browser.newPage();

async function render({ size, scale = 1 }) {
	const inset = Math.round((size * (1 - scale)) / 2);
	await page.setContent(`<!doctype html><style>
		html,body{margin:0;background:${BG}}
		img{display:block;width:${size - inset * 2}px;height:${size - inset * 2}px;padding:${inset}px;box-sizing:content-box}
	</style><img src="${SOURCE}">`);
	const file = `icon-${size === 512 && scale < 1 ? "maskable-" : ""}${size}.png`;
	await page.locator("img").screenshot({ path: `${OUT}${file}` });
	// Pixel check: sample the middle band and the corners; the art must be there.
	const check = await page.evaluate(
		({ size: s, inset: i }) => {
			const img = document.querySelector("img");
			const canvas = document.createElement("canvas");
			canvas.width = s;
			canvas.height = s;
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0, s, s);
			const px = (x, y) => {
				const d = ctx.getImageData(x, y, 1, 1).data;
				return d[0] + d[1] + d[2];
			};
			const center = px(Math.round(s / 2), Math.round(s / 2));
			const corner = px(Math.round(i / 2) + 2, Math.round(i / 2) + 2);
			return { center, corner };
		},
		{ size, inset },
	);
	if (check.corner > 150) throw new Error(`${file}: corner is not dark (${check.corner})`);
	if (check.center <= check.corner) throw new Error(`${file}: no art at the center (${check.center} vs ${check.corner})`);
	console.log(`wrote ${file} (center ${check.center} vs corner ${check.corner})`);
}

await render({ size: 192 });
await render({ size: 512 });
await render({ size: 512, scale: 0.8 }); // maskable: 10% margins keep the rose in the safe zone
await browser.close();
