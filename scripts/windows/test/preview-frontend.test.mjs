import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const manifest = readFileSync(new URL("apps/desktop/src-tauri/Cargo.toml", root), "utf8");
const features = manifest.match(/\[features\]([\s\S]*?)(?=\n\[)/)?.[1] ?? "";

test("standalone preview can explicitly select the embedded Tauri frontend", () => {
	assert.match(features, /^custom-protocol\s*=\s*\["tauri\/custom-protocol"\]\s*$/m);
});

test("production frontend remains opt-in and preview keeps its non-installer identity", () => {
	assert.match(features, /^default\s*=\s*\[\]\s*$/m);
	assert.match(features, /^local-preview\s*=\s*\[\]\s*$/m);
	const config = JSON.parse(
		readFileSync(new URL("apps/desktop/src-tauri/tauri.preview.conf.json", root), "utf8"),
	);
	assert.equal(config.identifier, "dev.gentleman.gentle-dot.preview");
	assert.equal(config.productName, "Gentle Dot Preview");
	assert.equal(config.bundle.active, false);
	assert.deepEqual(config.app.windows, []);
});
