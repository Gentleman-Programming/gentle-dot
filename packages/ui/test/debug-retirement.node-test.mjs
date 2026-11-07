import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("STRUCTURAL: Settings neither loads nor exposes the retired preference; other settings stay", () => {
	const source = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(source, /loadDebug|saveDebug|setDebug|settings-debug/);
	for (const retained of ["loadMemory", "saveMemory", "loadShortcut", "saveShortcut", "VoiceDevicesSettings"])
		assert.ok(source.includes(retained), retained);
	// Retain optional pre-existing locale wiring without introducing it in other source variants.
	if (source.includes("useLocale")) assert.ok(source.includes("setVoiceLanguage"));
});
