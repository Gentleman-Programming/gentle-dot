#!/usr/bin/env node
// Renders the rose icons with Playwright's Chromium (design sheet: docs/brand/rose-design.html):
//   src-tauri/icons/tray/<glyph>.png, <glyph>@2x.png  menu bar template images, 18 and 36 px
//   src-tauri/icons/tray/linux/<glyph>.png             Linux tray glyphs, 32 px, for light and dark panels
//   src-tauri/icons/source.png                         1024 px app icon master (neon rose, black squircle)
//   packages/ui/public/favicon.svg, favicon.png        the menu bar glyph in neon pink (the traced
//                                                       strokes are illegible at tab size), and a 64 px PNG
// Usage: node scripts/make-icon.mjs, then regenerate the bundle icons from source.png (see README).
//        node scripts/make-icon.mjs --linux-tray renders only the Linux tray glyphs.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const brand = (file) => path(`../../../docs/brand/${file}`);

// ---------- Menu bar ----------
// Template images: macOS reads only the alpha channel and tints them for the menu bar.
const glyphPaths = [...readFileSync(brand("rose-glyph.svg"), "utf8").matchAll(/<path d="([^"]+)"\/>/g)].map(
	(m) => m[1],
);
const OUTER_PETALS = 2; // the first two paths of rose-glyph.svg
const BADGE = { cx: 15.2, cy: 3, r: 2.6, gap: 1.3 };

function glyph({ dashed = false, badge = false, opacity = 1 }) {
	const strokes = glyphPaths
		.map((d, i) => `<path d="${d}"${dashed && i < OUTER_PETALS ? ' stroke-dasharray="1.3 1.4"' : ""}/>`)
		.join("");
	const knockout = badge
		? `<mask id="m"><rect width="18" height="18" fill="#fff"/><circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r + BADGE.gap}"/></mask>`
		: "";
	const dot = badge
		? `<circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r}" fill="#000" stroke="none"/>`
		: "";
	return `${knockout}<g opacity="${opacity}" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"${badge ? ' mask="url(#m)"' : ""}>${strokes}</g>${dot}`;
}

const glyphs = {
	ready: glyph({}),
	working: glyph({ dashed: true }),
	"needs-you": glyph({ badge: true }),
	unavailable: glyph({ opacity: 0.4 }),
};

// Linux panels are light or dark and do not tint icons: a light gray glyph over a dark
// outline reads on both. The badge keeps the Dot's amber.
function linuxGlyph(options) {
	const outline = glyph(options)
		.replace('stroke-width="1.25"', 'stroke-width="2.9"')
		.replaceAll("#000", "#161015")
		.replace('fill="#161015" stroke="none"', 'fill="#161015" stroke="#161015" stroke-width="1.6"');
	const face = glyph(options)
		.replaceAll('id="m"', 'id="m2"')
		.replace("url(#m)", "url(#m2)")
		.replace('stroke="#000"', 'stroke="#ececec"')
		.replace('fill="#000"', 'fill="#f5a524"');
	return `<g opacity="0.85">${outline}</g>${face}`;
}

const linuxGlyphs = {
	ready: linuxGlyph({}),
	working: linuxGlyph({ dashed: true }),
	"needs-you": linuxGlyph({ badge: true }),
	unavailable: linuxGlyph({ opacity: 0.45 }),
};

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><title>Gentle Dot</title>${glyph({}).replaceAll("#000", "#ff2d7a")}</svg>\n`;

// ---------- App icon ----------
// macOS icon grid: an 824 px squircle centered in 1024, leaving room for its shadow.
function squircle(center, radius, exponent = 5, steps = 240) {
	const points = [];
	for (let i = 0; i < steps; i++) {
		const t = (i / steps) * 2 * Math.PI;
		const [c, s] = [Math.cos(t), Math.sin(t)];
		const x = center + radius * Math.sign(c) * Math.abs(c) ** (2 / exponent);
		const y = center + radius * Math.sign(s) * Math.abs(s) ** (2 / exponent);
		points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
	}
	return `M${points.join("L")}Z`;
}

const rose = readFileSync(brand("rose-source.png")).toString("base64");
const shape = squircle(512, 412);
const art = 758; // the rose fills 92% of the squircle, as on the sheet
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
	<radialGradient id="bg" cx="50%" cy="40%" r="62%"><stop offset="0" stop-color="#1a0a12"/><stop offset="0.75" stop-color="#050506"/></radialGradient>
	<clipPath id="clip"><path d="${shape}"/></clipPath>
	<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.5"/></filter>
</defs>
<path d="${shape}" fill="url(#bg)" filter="url(#shadow)"/>
<g clip-path="url(#clip)">
	<image href="data:image/png;base64,${rose}" x="${512 - art / 2}" y="${512 - art / 2}" width="${art}" height="${art}" style="mix-blend-mode: screen"/>
	<path d="${shape}" transform="translate(0 4)" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="4"/>
	<path d="${shape}" fill="none" stroke="rgba(255,45,122,0.22)" stroke-width="8"/>
</g>
</svg>`;

// ---------- Render ----------
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size, out) {
	await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
	await page.locator("svg").evaluate((el, s) => {
		el.setAttribute("width", s);
		el.setAttribute("height", s);
	}, size);
	await page.locator("svg").screenshot({ path: out, omitBackground: true });
	console.log(`wrote ${out} (${size}px)`);
}

await mkdir(path("../src-tauri/icons/tray/linux"), { recursive: true });
for (const [name, body] of Object.entries(linuxGlyphs)) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">${body}</svg>`;
	await render(svg, 32, path(`../src-tauri/icons/tray/linux/${name}.png`));
}
if (process.argv.includes("--linux-tray")) {
	await browser.close();
	process.exit(0);
}
for (const [name, body] of Object.entries(glyphs)) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">${body}</svg>`;
	await render(svg, 18, path(`../src-tauri/icons/tray/${name}.png`));
	await render(svg, 36, path(`../src-tauri/icons/tray/${name}@2x.png`));
}
await render(appIcon, 1024, path("../src-tauri/icons/source.png"));
writeFileSync(path("../../../packages/ui/public/favicon.svg"), favicon);
await render(favicon, 64, path("../../../packages/ui/public/favicon.png"));
await browser.close();
