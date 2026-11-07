import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
	new URL("../../../apps/desktop/src-tauri/src/computer/win32/identity.rs", import.meta.url),
	"utf8",
);
// Source contracts only: these checks do not execute Rust, HWND queries or input.
test("refusal keeps its predicate and identifies only a known protected executable", () => {
	assert.match(source, /if !leaf\.ends_with\("\.exe"\) \|\| protected_executable\(leaf\) \{/);
	assert.match(
		source,
		/let reason = if protected_executable\(leaf\) \{ leaf \} else \{ "unsupported executable suffix" \};/,
	);
	assert.match(source, /return Err\(format!\("protected executable target refused: \{reason\}"\)\);/);
});
test("the exact shell denylist remains present and Chrome is not newly blocked", () => {
	const list = source.slice(
		source.indexOf("fn protected_executable("),
		source.indexOf("pub(super) fn identity("),
	);
	const names = [...list.matchAll(/"([a-z0-9.-]+\.exe)"/g)].map((m) => m[1]);
	for (const name of [
		"powershell.exe",
		"pwsh.exe",
		"cmd.exe",
		"windowsterminal.exe",
		"consent.exe",
		"bitwarden.exe",
	])
		assert.ok(names.includes(name), name);
	for (const name of ["chrome.exe", "notepad.exe", "my-bitwarden-notes.exe"])
		assert.equal(names.includes(name), false, name);
});
