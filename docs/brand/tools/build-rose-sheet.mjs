// Builds docs/brand/rose-design.html from rose-lines.svg (traced by trace_rose.py).
// The traced strokes are inlined into every rose instance so each one can animate on its own.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const svg = readFileSync(here("../rose-lines.svg"), "utf8");
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 1254 1254";
const paths = [...svg.matchAll(/<path data-length="(\d+)" d="([^"]+)"\/>/g)].map((m) => ({
	length: Number(m[1]),
	d: m[2],
}));
const sparkles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>/g)].map((m) => m.slice(1, 4));

// Crop to the rose itself (no empty margin), so the window can hug the flower.
const crop = "200 60 860 1130";

function rose({ size, state, simple = false }) {
	const list = simple ? paths.slice(0, 38) : paths;
	const strokes = list
		.map(({ d, length }, i) => {
			const dur = Math.min(4.2, Math.max(1.1, length / 120)).toFixed(2);
			return `<path d="${d}" pathLength="1" style="--i:${i};--d:${dur}s"/>`;
		})
		.join("");
	const dots = simple
		? ""
		: sparkles.map(([cx, cy, r], i) => `<circle cx="${cx}" cy="${cy}" r="${r}" style="--i:${i}"/>`).join("");
	return `<svg class="rose rose-${state}" viewBox="${simple ? crop : crop}" width="${size}" height="${Math.round((size * 1130) / 860)}" aria-hidden="true">
	<g class="base">${strokes}</g>
	<g class="light">${strokes}</g>
	<g class="sparkles">${dots}</g>
</svg>`;
}

const states = [
	["idle", "Ready", "the outline breathes a soft glow; sparkles twinkle"],
	["thinking", "Thinking", "one slow light runs along the petals"],
	["working", "Working", "fast lights race through petals, leaves, and stem"],
	["needs", "Needs you", "the whole rose pulses brighter, with a badge, until you answer"],
	["restarting", "Restarting", "dim rose, one faint light keeps tracing"],
	["offline", "Unavailable", "dim and still; click it to see why"],
];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Gentle Dot — the rose</title>
<style>
	:root {
		--neon: #ff2d7a;
		--neon-soft: rgba(255, 45, 122, 0.35);
		--core: #ffd6e8;
		--amber: #f5a524;
		--ink: #ecedef;
		--muted: #8a8f98;
		--bg: #08080b;
		font: 14px/20px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
		color: var(--ink);
		-webkit-font-smoothing: antialiased;
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); }
	.sheet { width: 1200px; margin: 0 auto; padding: 48px 56px 64px; }
	h1 { font-size: 30px; line-height: 36px; margin: 0 0 6px; }
	h2 { font-size: 18px; margin: 52px 0 4px; }
	.lead { color: var(--muted); margin: 0; max-width: 900px; }
	.note { color: var(--muted); font-size: 12px; line-height: 17px; }
	.row { display: flex; gap: 22px; align-items: flex-start; margin-top: 22px; }
	.cell { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 160px; text-align: center; }
	.cell b { font-size: 13px; }
	.cell span { color: var(--muted); font-size: 12px; line-height: 16px; }
	.stage { position: relative; display: grid; place-items: center; width: 140px; height: 150px; }

	/* ---------- The rose ---------- */
	.rose { overflow: visible; display: block; }
	.rose path { fill: none; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
	.rose .base path { stroke: var(--neon); stroke-width: 1.3; opacity: 0.55; }
	.rose .light path { stroke: var(--core); stroke-width: 1.8; stroke-dasharray: 0 1; opacity: 0; }
	.rose .base { filter: drop-shadow(0 0 2px var(--neon)) drop-shadow(0 0 6px var(--neon-soft)); }
	.rose .light { filter: drop-shadow(0 0 2px #fff) drop-shadow(0 0 5px var(--neon)) drop-shadow(0 0 12px var(--neon)); }
	.rose .sparkles circle { fill: var(--core); opacity: 0.8; filter: drop-shadow(0 0 3px var(--neon)); }

	.rose-idle .base { animation: breathe 3.6s ease-in-out infinite; }
	.rose-idle .sparkles circle { animation: twinkle 2.8s ease-in-out infinite; animation-delay: calc(var(--i) * -0.37s); }

	.rose-thinking .base path { opacity: 0.45; }
	.rose-thinking .light path { opacity: 1; stroke-dasharray: 0.16 1.2; animation: run calc(var(--d) * 1.6) linear infinite; animation-delay: calc(var(--i) * -0.53s); }
	.rose-thinking .sparkles circle { opacity: 0.35; }

	.rose-working .base path { opacity: 0.7; }
	.rose-working .light path { opacity: 1; stroke-dasharray: 0.22 0.5; animation: run calc(var(--d) * 0.55) linear infinite; animation-delay: calc(var(--i) * -0.29s); }
	.rose-working .sparkles circle { animation: twinkle 0.9s ease-in-out infinite; animation-delay: calc(var(--i) * -0.13s); }

	.rose-needs .base { animation: call 1.4s ease-in-out infinite; }
	.rose-needs .base path { opacity: 0.9; }
	.rose-needs .sparkles circle { animation: twinkle 1.4s ease-in-out infinite; }

	.rose-restarting { filter: grayscale(1) brightness(0.8); }
	.rose-restarting .base path { opacity: 0.3; }
	.rose-restarting .light path { opacity: 0.8; stroke-dasharray: 0.1 2; animation: run calc(var(--d) * 2.4) linear infinite; animation-delay: calc(var(--i) * -0.71s); }
	.rose-restarting .sparkles { display: none; }

	.rose-offline { filter: grayscale(0.85) brightness(0.6); }
	.rose-offline .base { filter: none; }
	.rose-offline .base path { opacity: 0.45; }
	.rose-offline .sparkles { display: none; }

	@keyframes run { from { stroke-dashoffset: 1.2; } to { stroke-dashoffset: -0.2; } }
	@keyframes breathe {
		0%, 100% { filter: drop-shadow(0 0 1px var(--neon)) drop-shadow(0 0 3px var(--neon-soft)); }
		50% { filter: drop-shadow(0 0 3px var(--neon)) drop-shadow(0 0 12px var(--neon)); }
	}
	@keyframes call {
		0%, 100% { filter: drop-shadow(0 0 2px var(--neon)) drop-shadow(0 0 6px var(--neon-soft)); }
		50% { filter: drop-shadow(0 0 4px #fff) drop-shadow(0 0 16px var(--neon)) drop-shadow(0 0 28px var(--neon)); }
	}
	@keyframes twinkle { 50% { opacity: 0.15; } }
	@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }

	.badge { position: absolute; top: 6px; right: 18px; width: 20px; height: 20px; border-radius: 50%; background: var(--amber);
		color: #241600; font: 800 13px/20px system-ui; text-align: center; box-shadow: 0 0 0 2px var(--bg), 0 0 10px rgba(245,165,36,0.6); }

	/* ---------- Hero ---------- */
	.hero { display: flex; gap: 48px; align-items: center; margin-top: 26px; }
	.hero-art { width: 420px; height: 470px; display: grid; place-items: center; border-radius: 24px;
		background: radial-gradient(300px 300px at 50% 45%, rgba(255,45,122,0.10), transparent 70%), #050507; }
	.hero ul { color: var(--muted); padding-left: 18px; margin: 12px 0 0; }
	.hero li { margin-bottom: 6px; }
	.hero b { color: var(--ink); }

	/* ---------- Desktop ---------- */
	.desk { position: relative; height: 430px; margin-top: 22px; border-radius: 18px; overflow: hidden;
		background: radial-gradient(1000px 520px at 15% 0%, #2b2d6b 0%, transparent 60%),
			radial-gradient(900px 500px at 100% 100%, #10505f 0%, transparent 55%), #14151b; }
	.menubar { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px;
		background: rgba(30,30,36,0.55); font-size: 13px; color: #dcdce0; }
	.menubar .left span { margin-right: 16px; }
	.menubar .right { display: flex; align-items: center; gap: 14px; }
	.mb-active { background: rgba(255,255,255,0.18); border-radius: 5px; padding: 1px 6px; display: flex; color: #fff; }
	.window { position: absolute; left: 70px; top: 70px; width: 640px; height: 300px; border-radius: 12px;
		background: #1e1f26; box-shadow: 0 20px 50px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); }
	.window .bar { height: 30px; display: flex; gap: 7px; align-items: center; padding-left: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); }
	.window .bar i { width: 11px; height: 11px; border-radius: 50%; background: #ff5f57; }
	.window .bar i:nth-child(2) { background: #febc2e; } .window .bar i:nth-child(3) { background: #28c840; }
	.window .lines { padding: 18px 22px; }
	.window .lines div { height: 9px; border-radius: 5px; background: rgba(255,255,255,0.07); margin-bottom: 12px; }
	.float { position: absolute; }
	.ghost { opacity: 0.35; }
	.label { position: absolute; font-size: 12px; color: #cfd0d6; background: rgba(0,0,0,0.4); padding: 4px 8px; border-radius: 6px; }
	.snapguide { position: absolute; right: 10px; top: 40px; bottom: 12px; width: 70px; border-radius: 35px; border: 1px dashed rgba(255,255,255,0.16); }

	/* ---------- Panel ---------- */
	.panel-scene { position: relative; width: 560px; height: 440px; border-radius: 18px; overflow: hidden;
		background: radial-gradient(700px 400px at 0% 0%, #2b2d6b 0%, transparent 60%), #14151b; }
	.panel { position: absolute; right: 96px; top: 24px; width: 320px; height: 390px; border-radius: 20px;
		background: rgba(22,22,28,0.82); border: 1px solid rgba(255,45,122,0.25); box-shadow: 0 24px 60px rgba(0,0,0,0.55), 0 0 30px rgba(255,45,122,0.12); padding: 14px; }
	.panel header { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
	.bubble { margin: 12px 0 0 auto; width: fit-content; max-width: 80%; background: var(--neon); padding: 7px 11px; border-radius: 14px 14px 4px 14px; font-size: 13px; color: #fff; }
	.reply { margin-top: 10px; font-size: 13px; color: #dfe0e4; }
	.chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 11px; color: var(--muted); border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 2px 9px; }
	.composer { position: absolute; left: 14px; right: 14px; bottom: 14px; height: 40px; border-radius: 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); color: var(--muted); font-size: 12px; padding: 11px 12px; }

	/* ---------- Icons ---------- */
	.appicon { width: 180px; height: 180px; border-radius: 40px; position: relative; overflow: hidden; display: grid; place-items: center;
		background: radial-gradient(90% 80% at 50% 40%, #1a0a12 0%, #050506 75%);
		box-shadow: 0 18px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10), inset 0 0 0 1px rgba(255,45,122,0.18); }
	.appicon img { width: 92%; height: 92%; object-fit: contain; }
	.small .appicon { width: 64px; height: 64px; border-radius: 15px; }
	.mbstrip { display: flex; gap: 30px; padding: 14px 22px; border-radius: 12px; background: #e9e9ed; color: #111; width: fit-content; }
	.mbstrip.dark { background: #2a2a30; color: #eee; }
	.mbcell { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 11px; }
	.tmpl path { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; stroke-width: 1.15; }
	.spec { display: grid; grid-template-columns: 200px 1fr; gap: 8px 24px; font-size: 13px; align-content: start; }
	.spec dt { color: var(--muted); }
	.spec dd { margin: 0; }
	.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 6px; }
</style>
</head>
<body>
<div class="sheet">
	<h1>Gentle Dot · the rose</h1>
	<p class="lead">The assistant is our rose. No circle, no container: the flower floats on its own, and its neon outline is how it talks. Light runs along its own strokes — petals, leaves, and stem — whenever it is working.</p>

	<div class="hero">
		<div class="hero-art">${rose({ size: 330, state: "working" })}</div>
		<div>
			<h2 style="margin-top:0">One rose, alive</h2>
			<ul>
				<li><b>The glow belongs to the rose.</b> Every petal, leaf, and stem line is a vector stroke traced from our logo, so the light hugs the drawing instead of a circle around it.</li>
				<li><b>A line of light travels the flower.</b> Bright comets run along each stroke; their speed says how busy the assistant is.</li>
				<li><b>Transparent everywhere.</b> On the desktop you only see the rose, never a box or a disc.</li>
				<li><b>Calm by default.</b> At rest it only breathes. “Reduce motion” freezes everything and keeps the glow.</li>
			</ul>
		</div>
	</div>

	<h2>1 · Floating on the desktop</h2>
	<p class="lead">Always on top, on every desktop, about 64 × 84 pt. Drag the rose anywhere; when you let go it snaps to the nearest edge so it never covers your work. Click it from anywhere to open the panel, or press ⌥ Space.</p>
	<div class="desk">
		<div class="menubar">
			<div class="left"><span>Finder</span><span>File</span><span>Edit</span><span>View</span></div>
			<div class="right">
				<span class="mb-active">__MB_ICON__</span><span>⌥ Space</span><span>Wed 8 Oct 10:42</span>
			</div>
		</div>
		<div class="window"><div class="bar"><i></i><i></i><i></i></div><div class="lines"><div style="width:70%"></div><div style="width:92%"></div><div style="width:54%"></div><div style="width:81%"></div><div style="width:63%"></div><div style="width:88%"></div></div></div>
		<div class="snapguide"></div>
		<div class="float ghost" style="right: 230px; top: 250px">${rose({ size: 64, state: "idle" })}</div>
		<div class="float" style="right: 13px; top: 170px">${rose({ size: 64, state: "thinking" })}</div>
		<div class="label" style="right: 200px; top: 345px">drag anywhere</div>
		<div class="label" style="right: 92px; top: 140px">snaps to the edge · 12 pt margin</div>
		<div class="label" style="left: 86px; top: 392px">Always on top · every Space · no Dock icon · transparent window</div>
	</div>

	<h2>2 · States</h2>
	<p class="lead">Motion and glow, never text. Light speed and brightness tell you what the assistant is doing.</p>
	<div class="row">
		${states
			.map(
				([state, title, text]) => `<div class="cell"><div class="stage">${rose({ size: 104, state })}${state === "needs" ? '<span class="badge">!</span>' : ""}</div><b>${title}</b><span>${text}</span></div>`,
			)
			.join("")}
	</div>

	<h2>3 · Click: the panel opens next to it</h2>
	<p class="lead">The panel opens on the side with more room. The rose keeps glowing beside it, so you always see what it is doing while you chat.</p>
	<div class="row" style="align-items: stretch; gap: 40px">
		<div class="panel-scene">
			<div class="panel">
				<header>Trip to Madrid</header>
				<div class="bubble">Find me flights for Friday</div>
				<span class="chip">● Looking things up online</span>
				<div class="reply">On it. I’ll compare three airlines and show you the best two…</div>
				<div class="composer">Add to what I’m doing…</div>
			</div>
			<div class="float" style="right: 14px; top: 170px">${rose({ size: 64, state: "working" })}</div>
		</div>
		<dl class="spec">
			<dt>Rose window</dt><dd>64 × 84 pt, fully transparent; the glow is drawn by the strokes</dd>
			<dt>Panel</dt><dd>420 × 640 pt, 20 pt radius, macOS vibrancy, a faint neon border</dd>
			<dt>Open / close</dt><dd>click the rose · <b>⌥ Space</b> from any app · menu bar → Open</dd>
			<dt>Move</dt><dd>drag the rose; it snaps to the nearest edge and remembers its place</dd>
			<dt>Colors</dt><dd><span class="swatch" style="background:#ff2d7a"></span>#FF2D7A neon · <span class="swatch" style="background:#ffd6e8"></span>#FFD6E8 light core · <span class="swatch" style="background:#f5a524"></span>#F5A524 needs-you badge</dd>
			<dt>Source</dt><dd>strokes traced from <code>gentle-logo-only.png</code> by <code>docs/brand/tools/trace_rose.py</code></dd>
		</dl>
	</div>

	<h2>4 · Menu bar icon</h2>
	<p class="lead">A monochrome “template” rose drawn for 18 × 18 pt (<code>rose-glyph.svg</code>): sharp outer petals, the cup, the spiral, stem, and leaf. macOS tints it for light and dark menu bars. While working, the tray swaps between two frames (solid and dashed petals).</p>
	<div class="row" style="gap: 18px">
		<div class="mbstrip">__MB_CELLS_LIGHT__</div>
		<div class="mbstrip dark">__MB_CELLS_DARK__</div>
	</div>

	<h2>5 · App icon (Dock, Finder, browser tab)</h2>
	<p class="lead">Our neon rose, as it is, on a black macOS squircle with a faint pink rim.</p>
	<div class="row">
		<div class="cell"><div class="appicon"><img src="rose-source.png" alt="" /></div><b>1024 pt master</b><span>the original logo, no changes</span></div>
		<div class="cell small"><div class="appicon"><img src="rose-source.png" alt="" /></div><b>64 pt</b><span>still clearly the rose</span></div>
		<div class="cell"><div class="stage" style="height:60px">${rose({ size: 32, state: "idle", simple: true })}</div><b>Favicon</b><span>the rose alone, main strokes</span></div>
	</div>
</div>
</body>
</html>
`;

// Menu bar template icon: the hand-drawn 18 × 18 glyph (rose-glyph.svg); traced strokes are illegible at that size.
const glyph = readFileSync(here("../rose-glyph.svg"), "utf8").replace(/^<svg[^>]*>/, "").replace("</svg>", "").trim();
const glyphSvg = (extra = "", attrs = "") =>
	`<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" ${attrs}>${glyph}${extra}</svg>`;
const tmpl = (opacity = 1, badge = "") => glyphSvg(badge, `opacity="${opacity}"`);
const cells = (bg) =>
	[
		["Ready", tmpl()],
		["Working", glyphSvg("", `style="stroke-dasharray: 2.2 1.1"`)],
		["Needs you", tmpl(1, `<circle cx="15.2" cy="3" r="2.6" fill="currentColor" stroke="${bg}" stroke-width="1.2"/>`)],
		["Unavailable", tmpl(0.4)],
	]
		.map(([name, icon]) => `<div class="mbcell">${icon}${name}</div>`)
		.join("");

writeFileSync(
	here("../rose-design.html"),
	html
		.replace("__MB_ICON__", glyphSvg("", 'style="color:#fff" width="16" height="16"'))
		.replace("__MB_CELLS_LIGHT__", cells("#e9e9ed"))
		.replace("__MB_CELLS_DARK__", cells("#2a2a30")),
);
console.log(`paths=${paths.length} sparkles=${sparkles.length}`);
