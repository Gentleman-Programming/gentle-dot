// Structural regressions for the Windows-only Rust/Tauri integration.
// These checks do not replace compilation with the Windows toolchain.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const computer = fileURLToPath(new URL("../../../apps/desktop/src-tauri/src/computer/", import.meta.url));
const integration = resolve(computer, "windows_app.rs");
const source = readFileSync(integration, "utf8");
const app = readFileSync(resolve(computer, "app.rs"), "utf8");

for (const name of ["capture", "dialogs", "overlay"]) {
	test(`path-attributed Windows integration resolves its ${name} module`, () => {
		// An explicit path is relative to windows_app.rs, not the logical app module.
		const declaration = source.match(new RegExp(`#\\[path = "([^"]+)"\\]\\s*mod ${name};`));
		assert.ok(declaration, `missing explicit path for ${name}`);
		assert.equal(declaration[1], `windows_app/${name}.rs`);
		assert.ok(existsSync(resolve(dirname(integration), declaration[1])));
	});
}

const command = app.match(
	/#\[cfg\(target_os = "windows"\)\]\s*#\[tauri::command\]\s*pub async fn computer_permissions\(([^)]*)\) -> PermissionsAnswer \{([\s\S]*?)\n\}/,
);

test("async Windows permissions command has owned inputs, not borrowed State", () => {
	assert.ok(command);
	assert.equal(command[1], "app: AppHandle");
	assert.match(command[2], /let desktop = app\.state::<Computer>\(\)\.desktop\.clone\(\);/);
	assert.match(
		command[2],
		/PermissionsAnswer \{ permissions, panic_shortcut: panic_shortcut_registered\(\) \}/,
	);
});

test("permissions still probe off the UI thread and fail closed on worker failure", () => {
	assert.ok(command);
	assert.match(
		command[2],
		/spawn_blocking\(move \|\| desktop\.permissions\(\)\)\.await\.unwrap_or\(Permissions \{\s*accessibility: false, screen_recording: false, screenshots_supported: false,\s*screenshots_unsupported: None,\s*\}\)/,
	);
	assert.match(
		app,
		/#\[cfg\(not\(target_os = "windows"\)\)\]\s*#\[tauri::command\]\s*pub fn computer_permissions\(computer: State<'_, Computer>\) -> PermissionsAnswer/,
	);
});
