#!/usr/bin/env node
// Renders the README banner and the small rose divider from the Dot's own neon rose: the traced
// strokes and sparkles in packages/ui/src/rose/strokes.ts, with the glow of packages/ui/src/styles.css.
// Usage: node docs/brand/tools/build-banner.mjs   (needs Playwright's Chromium: pnpm exec playwright install chromium)
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = readFileSync(join(root, "packages/ui/src/rose/strokes.ts"), "utf8");
const viewBox = source.match(/ROSE_VIEWBOX = "([^"]+)"/)?.[1];
const strokes = [...source.matchAll(/d: "([^"]+)"/g)].map((m) => m[1]);
const sparkles = [...source.matchAll(/\[(\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\]/g)].map((m) => m.slice(1, 4));
if (!viewBox || strokes.length === 0) throw new Error("could not read the rose from strokes.ts");

const out = join(root, "docs/assets/brand");
mkdirSync(out, { recursive: true });

/** The rose as the Dot draws it: a glowing outline under a light core, and sparkles. */
function rose(width) {
	const paths = strokes.map((d) => `<path d="${d}"/>`).join("");
	const dots = sparkles.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join("");
	return `<div class="rose" style="width:${width}px">
		<svg class="base" viewBox="${viewBox}">${paths}</svg>
		<svg class="core" viewBox="${viewBox}">${paths}</svg>
		<svg class="sparkles" viewBox="${viewBox}">${dots}</svg>
	</div>`;
}

const css = `
	:root { --neon: #ff2d7a; --neon-soft: rgba(255, 45, 122, 0.45); --core: #ffd6e8; --accent: #f095c8; }
	* { margin: 0; box-sizing: border-box; }
	.rose { position: relative; aspect-ratio: 860 / 1130; }
	.rose svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
	.rose path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
	.base { filter: drop-shadow(0 0 3px var(--neon)) drop-shadow(0 0 18px var(--neon-soft)) drop-shadow(0 0 42px var(--neon-soft)); }
	.base path { stroke: var(--neon); stroke-width: 9; }
	.core { filter: drop-shadow(0 0 2px #fff); }
	.core path { stroke: var(--core); stroke-width: 3.2; opacity: 0.9; }
	.sparkles { filter: drop-shadow(0 0 6px var(--neon)); }
	.sparkles circle { fill: var(--core); }
`;

const banner = `<!doctype html><html><head><style>${css}
	body { width: 1672px; height: 941px; overflow: hidden; background:
		radial-gradient(circle at 30% 50%, rgba(255, 45, 122, 0.16), transparent 42%),
		radial-gradient(circle at 75% 40%, rgba(240, 149, 200, 0.07), transparent 50%), #1a1218;
		display: flex; align-items: center; gap: 72px; padding: 0 140px;
		font-family: "IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, monospace; color: #f6e9f0; }
	.disc { flex: none; width: 600px; height: 600px; border-radius: 50%; display: grid; place-items: center;
		background: radial-gradient(circle at 50% 40%, #2a0f1d, #050506 72%);
		box-shadow: inset 0 0 0 3px rgba(255, 45, 122, 0.35), 0 0 80px rgba(255, 45, 122, 0.25), 0 30px 80px rgba(0, 0, 0, 0.6); }
	h1 { font-size: 132px; line-height: 1; font-weight: 800; letter-spacing: -2px;
		color: #ffe3ef; text-shadow: 0 0 6px var(--neon), 0 0 28px var(--neon-soft); }
	h1 span { color: var(--accent); }
	p { margin-top: 34px; font-size: 36px; line-height: 1.4; color: #e9c6d7; }
	.keys { margin-top: 40px; display: inline-flex; gap: 14px; font-size: 26px; color: var(--accent); }
	.keys b { border: 2px solid rgba(240, 149, 200, 0.55); border-radius: 12px; padding: 6px 16px;
		box-shadow: 0 0 18px rgba(240, 149, 200, 0.25); }
</style></head><body>
	<div class="disc">${rose(400)}</div>
	<div>
		<h1>Gentle <span>Dot</span></h1>
		<p>Your assistant, always one key away.<br/>Memory, voice, files, and your Mac.</p>
		<div class="keys"><b>⌥ Space</b></div>
	</div>
</body></html>`;

const divider = `<!doctype html><html><head><style>${css}
	html, body { background: transparent; }
	body { width: 200px; height: 261px; display: grid; place-items: center; }
</style></head><body>${rose(150)}</body></html>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	await page.setViewportSize({ width: 1672, height: 941 });
	await page.setContent(banner, { waitUntil: "load" });
	await page.screenshot({ path: join(out, "gentle-dot-banner.png") });
	await page.setViewportSize({ width: 200, height: 261 });
	await page.setContent(divider, { waitUntil: "load" });
	await page.screenshot({ path: join(out, "rose.png"), omitBackground: true });
} finally {
	await browser.close();
}
console.log(`wrote ${join(out, "gentle-dot-banner.png")} and rose.png (${strokes.length} strokes, ${sparkles.length} sparkles)`);
