use std::env;
use std::path::{Path, PathBuf};

/// Commands the UI may invoke; each one gets an `allow-<command>` permission.
const COMMANDS: &[&str] = &[
    "connection_info",
    "toggle_panel",
    "hide_panel",
    "set_dot_state",
    "rose_hidden",
    "set_rose_hidden",
    "set_panel_fullscreen",
    "computer_endpoint",
    "computer_permissions",
    "computer_request_permission",
    "computer_stop",
    "computer_status",
    "computer_set_yolo",
    "computer_working_ready",
    "voice_status",
    "voice_start",
    "voice_stop",
    "voice_cancel",
    "voice_model_status",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_remove",
    "shortcut_get",
    "shortcut_set",
    "connector_command",
];

fn find_in_path(program: &str, path: &str) -> Option<PathBuf> {
    env::split_paths(path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn main() {
    // Apps launched from Finder get a minimal PATH, so record what the build saw:
    // the absolute `node`, the daemon entry point, and PATH itself (the daemon
    // needs it to find `gentle-shell`). Runtime env vars override the first two.
    let path = env::var("PATH").unwrap_or_default();
    // Select for the Cargo target, not the build-script host (cross builds differ).
    // GENTLE_DOT_NODE remains a runtime override; no bundled Windows runtime is implied.
    let program = if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { "node.exe" } else { "node" };
    let node = find_in_path(program, &path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| program.into());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest_dir.join("../../../packages/daemon/src/cli.ts");
    // Windows canonicalize adds a verbatim (\\?\) prefix that Node 24's
    // entry-point realpathSync rejects. Keep Cargo's absolute manifest path;
    // Node resolves its parent components without the verbatim prefix.
    #[cfg(not(windows))]
    let script = script.canonicalize().unwrap_or(script);

    println!("cargo:rustc-env=GENTLE_DOT_BUILD_NODE={node}");
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_DAEMON_SCRIPT={}", script.display());
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_PATH={path}");
    println!("cargo:rerun-if-env-changed=PATH");
    // Only package-windows opts in. A normal release checkout must still run from source.
    let packaged_required = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED").as_deref() == Ok("1");
    println!("cargo:rustc-env=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED={}", if packaged_required { "1" } else { "0" });
    println!("cargo:rerun-if-env-changed=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED");
    println!(
        "cargo:rerun-if-changed={}",
        Path::new("../../../packages/daemon/src/cli.ts").display()
    );

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
