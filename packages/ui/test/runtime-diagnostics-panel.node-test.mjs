import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

// Structural guard only: this does not render a UI or establish Windows acceptance.
test("chat and settings no longer wire the report screen or hide the composer for it", () => {
	const chat = source("components/ChatSurface.tsx");
	const settings = source("components/SettingsPanel.tsx");
	assert.doesNotMatch(
		chat,
		/RuntimeDiagnosticsPanel|requestRuntimeDiagnostics|diagnosticsShown|diagnostics_failed|focusDiagnostics|data-runtime-diagnostics/,
	);
	assert.doesNotMatch(settings, /openDiagnostics|diagnosticsMessages|focusDiagnostics|diagnosticsLocale/);
	assert.doesNotMatch(source("styles.css"), /data-runtime-diagnostics/);
	assert.doesNotMatch(
		source("store.ts"),
		/DiagnosticsState|parseRuntimeReport|diagnostics_start|runtime_diagnostics/,
	);
	assert.match(chat, /<SettingsPanel close=/);
	assert.match(chat, /hidden=\{covered \|\| settingsShown\}/);
	assert.match(settings, /<VoiceDevicesSettings \/>/);
	// Optional settings can be absent in a source slice; when present, retain their controls.
	if (settings.includes("settings-debug")) assert.match(settings, /aria-label="debug"/);
	if (settings.includes("useLocale")) assert.match(settings, /setLocale\(event\.target\.value as UiLocale\)/);
});
