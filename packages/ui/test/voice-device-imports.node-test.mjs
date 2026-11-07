import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source-graph regression only: production bundler/build proof is separate.
// The adapter tests below mock module dependencies, never Tauri/IPC or hardware.
test("dynamic voice loads do not target modules already eagerly imported by the UI", () => {
	const runtime = readFileSync(new URL("../src/voice-device-runtime.ts", import.meta.url), "utf8");
	const eager = new Set();
	for (const path of ["App.tsx", "useVoice.ts", "components/ChatSurface.tsx", "components/VoiceModel.tsx"]) {
		const url = new URL("../src/" + path, import.meta.url);
		const source = readFileSync(url, "utf8");
		for (const match of source.matchAll(/\bimport\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/g))
			if (match[1].startsWith(".")) eager.add(new URL(match[1], url).href);
	}
	const dynamic = [...runtime.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
		(m) => new URL(m[1], new URL("../src/voice-device-runtime.ts", import.meta.url)).href,
	);
	assert.ok(dynamic.length > 0, "preserve a deferred native bridge for the pure runtime");
	assert.deepEqual(
		dynamic.filter((target) => eager.has(target)),
		[],
		"desktop/native modules are already static dependencies of App/useVoice/VoiceModel",
	);
});

const dataUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
for (const quote of ["'", '"']) {
	test(`deferred native bridge stays inert and preserves catalog and request arguments (${quote})`, async () => {
		const key = Symbol.for("gentle-dot.test.voice-device-native");
		assert.equal(globalThis[key], undefined);
		const state = {
			desktop: false,
			calls: [],
			catalog: { supported: true, devices: [{ id: "mic", label: "Mic", isDefault: true }] },
		};
		globalThis[key] = state;
		try {
			const desktop = dataUrl(
				'export const inDesktop=()=>globalThis[Symbol.for("gentle-dot.test.voice-device-native")].desktop;',
			);
			const native = dataUrl(`const state=()=>globalThis[Symbol.for('gentle-dot.test.voice-device-native')];
export async function nativeInputDevices(){state().calls.push(['catalog']);return state().catalog;}
export async function startNativeVoice(...args){state().calls.push(['start',...args]);}
export async function synthesizeNativeVoice(...args){state().calls.push(['synthesize',...args]);return [1,2];}
export async function cancelNativeSynthesis(...args){state().calls.push(['cancel',...args]);}`);
			const original = readFileSync(
				new URL("../src/voice-device-native.ts", import.meta.url),
				"utf8",
			).replace(
				/\bfrom\s*(["'])(\.\/(?:desktop|voice-native)\.ts)\1/g,
				(_match, _delimiter, specifier) => `from ${quote}${specifier}${quote}`,
			);
			// Match module specifiers, not the formatter's choice of quote delimiter.
			const desktopImport = /\bfrom\s*(["'])\.\/desktop\.ts\1/g;
			const nativeImports = /\bfrom\s*(["'])\.\/voice-native\.ts\1/g;
			assert.equal([...original.matchAll(desktopImport)].length, 1);
			assert.equal([...original.matchAll(nativeImports)].length, 2);
			const source = original
				.replace(desktopImport, () => `from ${JSON.stringify(desktop)}`)
				.replace(nativeImports, () => `from ${JSON.stringify(native)}`);
			const bridge = await import(dataUrl(source));
			assert.deepEqual(state.calls, [], "module loading must not access IPC or media");
			assert.deepEqual(await bridge.nativeDeviceCatalog(), { supported: false, devices: [] });
			assert.deepEqual(state.calls, [], "browser metadata must not call native IPC");
			state.desktop = true;
			assert.deepEqual(await bridge.nativeDeviceCatalog(), state.catalog);
			await bridge.startNativeVoice("es", "mic", "opaque_1");
			assert.deepEqual(await bridge.synthesizeNativeVoice("request-1", "Hola", "es"), [1, 2]);
			await bridge.cancelNativeSynthesis("request-1");
			assert.deepEqual(state.calls, [
				["catalog"],
				["start", "es", "mic", "opaque_1"],
				["synthesize", "request-1", "Hola", "es"],
				["cancel", "request-1"],
			]);
		} finally {
			delete globalThis[key];
		}
	});
}
