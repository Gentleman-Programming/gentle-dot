use std::env;
use std::path::{Path, PathBuf};

/// Commands the UI may invoke; each one gets an `allow-<command>` permission.
const COMMANDS: &[&str] = &["connection_info", "toggle_panel", "hide_panel", "set_dot_state"];

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
    let node = find_in_path("node", &path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "node".into());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest_dir.join("../../../packages/daemon/src/cli.ts");
    let script = script.canonicalize().unwrap_or(script);

    println!("cargo:rustc-env=GENTLE_DOT_BUILD_NODE={node}");
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_DAEMON_SCRIPT={}", script.display());
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_PATH={path}");
    println!("cargo:rerun-if-env-changed=PATH");
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
