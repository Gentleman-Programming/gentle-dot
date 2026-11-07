import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Preserve upstream's structural regression; this is not native execution proof.
it("wires package-only marker to fallible admission before launch without changing launch_spec", () => {
	const tauri = new URL("../../../apps/desktop/src-tauri/", import.meta.url);
	const build = readFileSync(new URL("build.rs", tauri), "utf8");
	const daemon = readFileSync(new URL("src/daemon.rs", tauri), "utf8");
	const launch = readFileSync(new URL("src/daemon/launch.rs", tauri), "utf8");
	expect(build).toContain("cargo:rerun-if-env-changed=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED");
	expect(build).toContain("cargo:rustc-env=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED=");
	expect(build).toContain('env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")');
	expect(daemon).toContain("cfg!(windows) && !cfg!(debug_assertions)");
	expect(daemon).toContain('option_env!("GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED") == Some("1")');
	expect(daemon).toMatch(/validate_packaged_runtime\([\s\S]*?\)\?;\s*launch_spec\(/);
	expect(launch).toContain("pub fn validate_packaged_runtime(");
	expect(launch).toContain("pub fn launch_spec(");
});
