//! Linux/Niri login autostart identity and truthful state (task 5).
//!
//! The autostart plugin (tauri-plugin-autostart 2.7.0 over auto-launch 0.6)
//! registers Linux login launch as an XDG Autostart `.desktop` file named
//! `<app_name>.desktop` in `~/.config/autostart` with `Exec=<current_exe>`.
//! Its `is_enabled` only checks that the file exists: a stale entry (binary
//! moved, dev-path entry, leftover after uninstall) still reads enabled.
//! Its default `app_name` is `package_info().name`, which tauri-codegen sets
//! to the Tauri `productName` ("Gentle Dot", with a space), not the Cargo
//! package/binary name (`gentle-dot`).
//!
//! This module pins the stable identity (`gentle-dot`, matching the binary,
//! `StartupWMClass`, icon name, and the packaged
//! `/usr/share/applications/Gentle Dot.desktop`'s `Exec=gentle-dot`) and
//! reports state truthfully: enabled means a candidate entry exists AND its
//! `Exec` target resolves. The pre-fix productName entry
//! (`Gentle Dot.desktop`) is honored as a compatible existing name so a
//! preference stored by an older build is not lost; toggling removes the
//! non-canonical duplicate. No unconditional spawn-at-startup is added:
//! enable/disable semantics are preserved, and nothing here writes outside
//! the caller's explicit directory (tests use temp dirs, never the real
//! home, and never mutate process-global environment).

use std::fs;
use std::path::{Path, PathBuf};

/// Stable Linux autostart entry stem: the binary name. Compile-time tied to
/// `CARGO_PKG_NAME` by test below.
pub const STABLE_APP_NAME: &str = "gentle-dot";
/// Pre-fix entry stem derived from the Tauri `productName` through the
/// plugin's default `package_info().name`; honored read-only for migration.
pub const LEGACY_APP_NAME: &str = "Gentle Dot";

/// Candidate entry files in priority order: stable first, legacy second.
pub fn entry_files(autostart_dir: &Path) -> [PathBuf; 2] {
    [
        autostart_dir.join(format!("{STABLE_APP_NAME}.desktop")),
        autostart_dir.join(format!("{LEGACY_APP_NAME}.desktop")),
    ]
}

/// First `Exec=` value of a `.desktop` file, if any, trimmed of surrounding
/// whitespace (the plugin writes a trailing space with empty args; the
/// state check tolerates it). [`exec_target`] takes the executable token.
pub fn desktop_exec(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Exec")?;
        rest.trim_start().strip_prefix('=')
    })
}

/// Leading executable token of an `Exec` value, with surrounding quotes
/// stripped. Desktop field codes (`%U`, `%f`, ...) trail the executable and
/// never lead it, so the first whitespace-separated token is the target.
/// A bare name (no `/`) is a `PATH` lookup candidate, not a path.
pub fn exec_target(exec_value: &str) -> Option<String> {
    let value = exec_value.trim_start();
    if value.is_empty() {
        return None;
    }
    let first = value.as_bytes()[0];
    let token = if first == b'"' || first == b'\'' {
        let rest = &value[1..];
        match rest.find(first as char) {
            Some(end) => &rest[..end],
            // Unterminated quote: take the rest rather than nothing.
            None => rest,
        }
    } else {
        match value.find(char::is_whitespace) {
            Some(end) => &value[..end],
            None => value,
        }
    };
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Whether an executable target resolves: an absolute path must exist; a
/// bare name must exist in one of `path_dirs` (host `$PATH` entries at
/// runtime, explicit fake bin dirs in tests).
pub fn exec_target_resolves(target: &str, path_dirs: &[PathBuf]) -> bool {
    if target.is_empty() {
        return false;
    }
    let path = Path::new(target);
    if path.is_absolute() {
        path.exists()
    } else if target.contains('/') {
        // A relative path never resolves from a login entry: the session
        // launcher does not run it from a known directory.
        false
    } else {
        path_dirs.iter().any(|dir| dir.join(path).exists())
    }
}

/// The enabled entry, if any: the first candidate (stable, then legacy)
/// whose file parses and whose `Exec` target resolves. A present-but-stale
/// entry (missing binary, unparsable, no `Exec`) reads disabled, never
/// enabled. Unreadable files count as absent (fail-closed).
pub fn enabled_entry(autostart_dir: &Path, path_dirs: &[PathBuf]) -> Option<PathBuf> {
    entry_files(autostart_dir).into_iter().find(|file| {
        let Ok(contents) = fs::read_to_string(file) else {
            return false;
        };
        let Some(target) = desktop_exec(&contents).and_then(exec_target) else {
            return false;
        };
        exec_target_resolves(&target, path_dirs)
    })
}

/// Removes every candidate entry except `keep` (migration cleanup after a
/// toggle: `None` fully disables, `Some(stable)` keeps the canonical entry).
/// Missing files are fine; other I/O errors surface to the caller.
pub fn remove_other_entries(autostart_dir: &Path, keep: Option<&Path>) -> std::io::Result<()> {
    for file in entry_files(autostart_dir) {
        if Some(file.as_path()) == keep {
            continue;
        }
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Managed Niri login-launch block: Niri never runs XDG Autostart entries,
/// so the toggle also maintains exactly this `spawn-at-startup` stanza in
/// the opt-in Niri include. Only lines between the two markers are owned:
/// user window rules outside them are preserved byte-identical. The block
/// is only ever added or removed by the explicit toggle path — never at
/// startup, setup, or import — so copying the template alone never
/// autostarts anything.
pub const NIRI_BEGIN: &str = "// gentle-dot:autostart begin (managed - do not edit)";
pub const NIRI_END: &str = "// gentle-dot:autostart end";

/// The Niri include file under an injected config dir. Tests pass temp
/// dirs; only the thin [`config_dir`] wrapper below resolves the real
/// home, and only the toggle path calls it.
pub fn niri_include_file(config_dir: &Path) -> PathBuf {
    config_dir.join("niri").join("gentle-dot.kdl")
}

/// KDL-quoted `spawn-at-startup` line for an absolute exe path.
/// Backslashes and double quotes are escaped; the caller guarantees an
/// absolute, existing path (the toggle resolves `current_exe`).
pub fn niri_spawn_line(exe: &Path) -> String {
    let quoted = exe.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!("spawn-at-startup \"{quoted}\"")
}

/// The full managed stanza for an exe path, markers included.
pub fn niri_spawn_block(exe: &Path) -> String {
    format!("{NIRI_BEGIN}\n{}\n{NIRI_END}\n", niri_spawn_line(exe))
}

/// Whether `contents` holds a complete managed block: both markers with a
/// `spawn-at-startup` line between them. Stray marker halves read absent.
pub fn has_managed_block(contents: &str) -> bool {
    let Some(begin) = contents.find(NIRI_BEGIN) else {
        return false;
    };
    let Some(end) = contents.find(NIRI_END) else {
        return false;
    };
    begin < end && contents[begin..end].contains("spawn-at-startup")
}

/// Strips the managed block (first begin marker through the first end
/// marker after it, whole lines), returning the remainder and whether a
/// block was removed. Everything outside the markers is untouched.
pub fn strip_managed_block(contents: &str) -> (String, bool) {
    let begin = contents.find(NIRI_BEGIN);
    let end = begin.and_then(|b| contents[b..].find(NIRI_END).map(|e| b + e));
    let (Some(begin), Some(end)) = (begin, end) else {
        return (contents.to_string(), false);
    };
    // Expand to whole lines so no marker fragment survives.
    let line_start = contents[..begin].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = contents[end..].find('\n').map(|i| end + i + 1).unwrap_or(contents.len());
    let mut kept = String::with_capacity(contents.len());
    kept.push_str(&contents[..line_start]);
    kept.push_str(&contents[line_end..]);
    (kept, true)
}

/// Adds (or replaces) the managed block for `exe` in the include file,
/// preserving user content. Creates parent dirs; an absent file starts
/// from empty. Toggle-only: never called at startup or setup.
pub fn ensure_niri_block(include_file: &Path, exe: &Path) -> std::io::Result<()> {
    let existing = fs::read_to_string(include_file).unwrap_or_default();
    let (mut kept, _) = strip_managed_block(&existing);
    if !kept.is_empty() && !kept.ends_with('\n') {
        kept.push('\n');
    }
    kept.push_str(&niri_spawn_block(exe));
    if let Some(parent) = include_file.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(include_file, kept)
}

/// Removes the managed block, leaving user content exactly as it was.
/// Returns whether a block was removed; an absent file is a silent `false`.
/// Toggle-only, like [`ensure_niri_block`].
pub fn remove_niri_block(include_file: &Path) -> std::io::Result<bool> {
    let existing = match fs::read_to_string(include_file) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let (kept, removed) = strip_managed_block(&existing);
    if removed {
        fs::write(include_file, kept)?;
    }
    Ok(removed)
}

/// Truthful login-launch state on Niri: enabled needs BOTH the valid XDG
/// desktop entry AND the managed Niri block. A half state reads disabled
/// and [`LoginState::missing`] names the gap for the toggle error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginState {
    pub xdg: bool,
    pub niri: bool,
}

impl LoginState {
    pub fn enabled(&self) -> bool {
        self.xdg && self.niri
    }

    pub fn missing(&self) -> Vec<&'static str> {
        let mut gaps = Vec::new();
        if !self.xdg {
            gaps.push("XDG desktop entry");
        }
        if !self.niri {
            gaps.push("Niri spawn-at-startup");
        }
        gaps
    }
}

/// Reads the dual state: `autostart_dir` from disk plus the already-read
/// Niri include contents (`None` where the file is absent/unreadable).
/// Pure over its inputs for deterministic tests; the toggle path supplies
/// real reads, tests supply temp dirs and inline strings.
pub fn login_state(
    autostart_dir: &Path,
    path_dirs: &[PathBuf],
    niri_contents: Option<&str>,
) -> LoginState {
    LoginState {
        xdg: enabled_entry(autostart_dir, path_dirs).is_some(),
        niri: niri_contents.is_some_and(has_managed_block),
    }
}

/// Whether login launch reads enabled for this session (D5, S14): on Niri
/// both the valid XDG entry AND the managed block are required; elsewhere
/// only the XDG entry counts and Niri config is never consulted. Pure over
/// its inputs; the shell supplies `platform::is_niri` for the flag, so
/// tests pin the matrix without windows or environment.
pub fn checked_for(state: LoginState, is_niri: bool) -> bool {
    if is_niri {
        state.enabled()
    } else {
        state.xdg
    }
}

/// XDG-only login state for non-Niri Linux (D5): the Niri include file is
/// neither read nor required, so the toggle never creates or touches Niri
/// config outside Niri. Opt-in preserved: this only reads.
pub fn xdg_state(autostart_dir: &Path, path_dirs: &[PathBuf]) -> LoginState {
    LoginState {
        xdg: enabled_entry(autostart_dir, path_dirs).is_some(),
        niri: false,
    }
}

/// Reads the Niri include file, or `None` where absent/unreadable
/// (fail-closed: counts as no block, never as enabled).
pub fn read_niri_include(include_file: &Path) -> Option<String> {
    fs::read_to_string(include_file).ok()
}

/// The host XDG autostart directory (`~/.config/autostart`), or `None` where
/// no home resolves. Thin runtime wrapper: the pure cores above carry the
/// tests, so this stays deliberately small.
#[cfg(target_os = "linux")]
pub fn autostart_dir() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("autostart"))
}

/// The host config dir (`~/.config`), or `None` where no home resolves.
/// Thin runtime wrapper: tests inject temp dirs into [`niri_include_file`]
/// instead, so they never touch the real home.
#[cfg(target_os = "linux")]
pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| Path::new(&home).join(".config"))
}

/// Host `$PATH` entries for bare-name `Exec` resolution. Thin runtime
/// wrapper; tests pass explicit dirs instead of touching the environment.
#[cfg(target_os = "linux")]
pub fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gentle-dot-autostart-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_entry(dir: &Path, file: &str, contents: &str) -> PathBuf {
        let path = dir.join(file);
        std::fs::write(&path, contents).unwrap();
        path
    }

    /// auto-launch 0.6 `build_xdg_autostart_data` byte shape (private there,
    /// replicated here only to document the contract the state check reads):
    /// `Exec=<absolute path> ` with a trailing space when args are empty.
    fn plugin_entry(app_name: &str, app_path: &str) -> String {
        format!(
            "[Desktop Entry]\n\
            Type=Application\n\
            Version=1.0\n\
            Name={app_name}\n\
            Comment={app_name} startup script\n\
            Exec={app_path} \n\
            StartupNotify=false\n\
            Terminal=false"
        )
    }

    #[test]
    fn stable_identity_matches_the_binary_package_name() {
        // The pinned stem must stay the binary name: the plugin writes
        // `Exec=<current_exe>` (the running `gentle-dot` binary), and the
        // packaged desktop file, WM class, and icon all use this stem.
        assert_eq!(STABLE_APP_NAME, env!("CARGO_PKG_NAME"));
        let dir = Path::new("/home/user/.config/autostart");
        let entries = entry_files(dir);
        assert_eq!(entries[0], dir.join("gentle-dot.desktop"));
    }

    #[test]
    fn legacy_product_name_entry_is_a_compatible_existing_name() {
        // The pre-fix default came from `package_info().name`, which
        // tauri-codegen sets to `productName` when present. If that config
        // drifts, this test names the new derivation instead of silently
        // orphaning host preferences.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["productName"], serde_json::Value::String(LEGACY_APP_NAME.to_string()));
        let dir = Path::new("/home/user/.config/autostart");
        assert_eq!(entry_files(dir)[1], dir.join("Gentle Dot.desktop"));
    }

    #[test]
    fn shell_wires_the_stable_identity_into_the_plugin() {
        // The `Builder::app_name` pin is one call site in shell.rs; if it is
        // dropped, the plugin falls back to the productName default and new
        // enables land beside (not over) the stable entry again.
        let shell = include_str!("shell.rs");
        assert!(
            shell.contains("app_name(crate::autostart::STABLE_APP_NAME)"),
            "shell.rs must pin the plugin app_name to the stable identity"
        );
    }

    #[test]
    fn exec_parsing_takes_the_leading_token_and_strips_quotes() {
        assert_eq!(
            desktop_exec("[Desktop Entry]\nExec=/usr/bin/gentle-dot \nType=Application\n"),
            Some("/usr/bin/gentle-dot")
        );
        // No Exec line, commented Exec, and empty files parse as absent.
        assert_eq!(desktop_exec("[Desktop Entry]\nType=Application\n"), None);
        assert_eq!(desktop_exec("#Exec=/bin/false\n"), None);
        assert_eq!(desktop_exec(""), None);
        // Leading token only; quotes stripped; field codes never lead.
        assert_eq!(exec_target("/usr/bin/gentle-dot "), Some("/usr/bin/gentle-dot".to_string()));
        assert_eq!(
            exec_target("\"/opt/Gentle Dot/gentle-dot\" --flag %U"),
            Some("/opt/Gentle Dot/gentle-dot".to_string())
        );
        assert_eq!(exec_target("gentle-dot %U"), Some("gentle-dot".to_string()));
        assert_eq!(exec_target("   "), None);
    }

    #[test]
    fn absolute_exec_must_exist_and_bare_names_search_path_dirs() {
        let bin = scratch("bindir");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let dirs = vec![bin.clone()];
        assert!(exec_target_resolves(exe.to_str().unwrap(), &dirs));
        assert!(!exec_target_resolves("/nonexistent/gentle-dot-xyz", &dirs));
        assert!(!exec_target_resolves("relative/gentle-dot", &dirs));
        // Bare names resolve through the provided dirs only: found here,
        // missing with an empty search list, never via the real host PATH.
        assert!(exec_target_resolves("gentle-dot", &dirs));
        assert!(!exec_target_resolves("gentle-dot", &[]));
        assert!(!exec_target_resolves("no-such-binary-xyz", &dirs));
    }

    #[test]
    fn enable_registers_exact_valid_exec_then_reads_enabled() {
        // Toggle-enable writes the stable file with the absolute executable;
        // state must then read back enabled against that exact Exec.
        let home = scratch("enable");
        let bin = scratch("enable-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let stable = write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        let found = enabled_entry(&home, &[bin]).expect("freshly enabled entry must read enabled");
        assert_eq!(found, stable);
        let stored = std::fs::read_to_string(&stable).unwrap();
        assert!(stored.contains(&format!("Exec={} ", exe.display())), "exact valid Exec must survive: {stored}");
    }

    #[test]
    fn stale_entry_reads_disabled_never_enabled() {
        // The plugin's existence-only `is_enabled` reads these as enabled;
        // the truthful check must not: missing binary, dev-path leftovers,
        // unparsable files, and entries without Exec are all disabled.
        let home = scratch("stale");
        write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, "/nonexistent/gentle-dot-xyz"));
        assert_eq!(enabled_entry(&home, &[]), None, "missing binary must read disabled");
        std::fs::remove_file(home.join("gentle-dot.desktop")).unwrap();
        write_entry(&home, "gentle-dot.desktop", "not a desktop file at all\n");
        assert_eq!(enabled_entry(&home, &[]), None, "unparsable entry must read disabled");
        std::fs::remove_file(home.join("gentle-dot.desktop")).unwrap();
        write_entry(&home, "gentle-dot.desktop", "[Desktop Entry]\nType=Application\nName=gentle-dot\n");
        assert_eq!(enabled_entry(&home, &[]), None, "entry without Exec must read disabled");
    }

    #[test]
    fn legacy_entry_with_valid_exec_reads_enabled_for_migration() {
        // A preference stored by a pre-fix build (productName filename) is
        // honored: the user asked for launch at login, and the binary is
        // really there. Toggle-disable from this state must clear it.
        let home = scratch("legacy");
        let bin = scratch("legacy-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let legacy = write_entry(&home, "Gentle Dot.desktop", &plugin_entry(LEGACY_APP_NAME, exe.to_str().unwrap()));
        assert_eq!(enabled_entry(&home, &[bin]), Some(legacy));
    }

    #[test]
    fn stable_wins_over_legacy_when_both_valid() {
        // Two valid entries (double registration) still report one
        // canonical state; the toggle path then converges them to one file.
        let home = scratch("both");
        let bin = scratch("both-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let stable = write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        write_entry(&home, "Gentle Dot.desktop", &plugin_entry(LEGACY_APP_NAME, exe.to_str().unwrap()));
        assert_eq!(enabled_entry(&home, &[bin]), Some(stable));
    }

    #[test]
    fn disable_removes_the_same_entry_and_reads_disabled() {
        // Toggle-disable removes the same entry enable wrote; state reads
        // disabled afterwards, and re-disabling an absent entry is fine.
        let home = scratch("disable");
        let bin = scratch("disable-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let stable = write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        let path_dirs = vec![bin];
        assert!(enabled_entry(&home, &path_dirs).is_some());
        remove_other_entries(&home, None).unwrap();
        assert!(!stable.exists(), "disable must remove the same entry");
        assert_eq!(enabled_entry(&home, &path_dirs), None);
        remove_other_entries(&home, None).unwrap();
    }

    #[test]
    fn enable_cleans_the_legacy_duplicate_but_keeps_stable() {
        // Toggle-enable converges a migrated host to one canonical file: the
        // legacy duplicate goes, the stable entry (and its enabled state)
        // stays, so login never launches twice.
        let home = scratch("converge");
        let bin = scratch("converge-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let stable = write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        let legacy = home.join("Gentle Dot.desktop");
        write_entry(&home, "Gentle Dot.desktop", &plugin_entry(LEGACY_APP_NAME, exe.to_str().unwrap()));
        remove_other_entries(&home, Some(&stable)).unwrap();
        assert!(stable.exists(), "stable entry must survive enable-cleanup");
        assert!(!legacy.exists(), "legacy duplicate must not survive enable-cleanup");
        assert_eq!(enabled_entry(&home, &[bin]), Some(stable));
    }

    #[test]
    fn niri_include_lives_beside_the_config_dir_never_home() {
        // The Niri include path derives from an injected config dir (tests
        // use temp dirs); nothing here resolves the real home on its own.
        let config = Path::new("/tmp/fake-config");
        assert_eq!(
            niri_include_file(config),
            config.join("niri").join("gentle-dot.kdl")
        );
    }

    #[test]
    fn niri_managed_block_roundtrips_and_preserves_user_content() {
        // Enable adds exactly one managed block quoting the absolute exe;
        // re-enable replaces (never duplicates); disable strips it while
        // keeping the user's own window rules byte-identical outside it.
        let config = scratch("niri-roundtrip");
        let bin = scratch("niri-roundtrip-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let include = niri_include_file(&config);
        let user_rules = "window-rule {\n    match title=\"^Gentle Dot$\"\n    open-floating true\n}\n";
        std::fs::create_dir_all(include.parent().unwrap()).unwrap();
        std::fs::write(&include, user_rules).unwrap();
        ensure_niri_block(&include, &exe).unwrap();
        let after_enable = std::fs::read_to_string(&include).unwrap();
        assert!(after_enable.starts_with(user_rules), "user content must survive: {after_enable}");
        assert!(has_managed_block(&after_enable), "managed block must be present after enable");
        assert!(
            after_enable.contains(&format!("spawn-at-startup \"{}\"", exe.display())),
            "block must quote the absolute exe: {after_enable}"
        );
        ensure_niri_block(&include, &exe).unwrap();
        let again = std::fs::read_to_string(&include).unwrap();
        assert_eq!(
            again.matches("spawn-at-startup").count(),
            1,
            "re-enable must not duplicate the block: {again}"
        );
        assert!(remove_niri_block(&include).unwrap(), "disable must report the block removed");
        let after_disable = std::fs::read_to_string(&include).unwrap();
        assert_eq!(after_disable, user_rules, "disable must restore the user's file exactly");
        assert!(!remove_niri_block(&include).unwrap(), "second disable is a silent no-op");
    }

    #[test]
    fn login_state_needs_both_backends_and_names_the_gap() {
        // Niri never runs XDG autostart, so enabled means BOTH the valid
        // desktop entry AND the managed Niri block; a half state reads
        // disabled and names exactly which side is missing.
        let home = scratch("login-state");
        let bin = scratch("login-state-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let dirs = vec![bin];
        let block = niri_spawn_block(&exe);
        let none = login_state(&home, &dirs, None);
        assert!(!none.enabled());
        assert_eq!(none.missing(), vec!["XDG desktop entry", "Niri spawn-at-startup"]);
        write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        let half = login_state(&home, &dirs, None);
        assert!(!half.enabled(), "XDG alone must not read enabled on Niri");
        assert_eq!(half.missing(), vec!["Niri spawn-at-startup"]);
        let niri_only = login_state(&scratch("login-empty"), &dirs, Some(&block));
        assert!(!niri_only.enabled(), "Niri block alone must not read enabled");
        assert_eq!(niri_only.missing(), vec!["XDG desktop entry"]);
        let full = login_state(&home, &dirs, Some(&block));
        assert!(full.enabled());
        assert!(full.missing().is_empty());
    }

    #[test]
    fn shell_autostart_gates_niri_behind_is_niri() {
        // D5 RED: the Niri side of login state/toggle runs only on Niri.
        // Non-Niri Linux keeps the XDG entry/plugin behavior and never
        // touches Niri config.
        let shell = include_str!("shell.rs");
        let checked = shell.split("fn autostart_checked").nth(1).expect("autostart_checked exists")
            .split("\nfn ").next().unwrap_or("");
        assert!(
            checked.contains("is_niri"),
            "autostart_checked must gate the Niri side on platform::is_niri"
        );
        let toggle = shell.split("fn toggle_autostart").nth(1).expect("toggle_autostart exists")
            .split("\nfn ").next().unwrap_or("");
        assert!(
            toggle.contains("is_niri"),
            "toggle_autostart must gate the Niri side on platform::is_niri"
        );
    }

    #[test]
    fn login_checked_matrix_niri_vs_other_linux() {
        // D5/S14: Niri needs both backends; other Linux needs only the XDG
        // entry and never touches Niri config. The shell gates on
        // `platform::is_niri` (pinned by the structural test above); this
        // pins the decision itself without windows or environment.
        let both = LoginState { xdg: true, niri: true };
        assert!(checked_for(both, true));
        assert!(checked_for(both, false));
        let xdg_only = LoginState { xdg: true, niri: false };
        assert!(!checked_for(xdg_only, true), "XDG alone must not read enabled on Niri");
        assert!(checked_for(xdg_only, false), "XDG alone reads enabled off Niri");
        let niri_only = LoginState { xdg: false, niri: true };
        assert!(!checked_for(niri_only, true));
        assert!(!checked_for(niri_only, false));
        let neither = LoginState { xdg: false, niri: false };
        assert!(!checked_for(neither, true));
        assert!(!checked_for(neither, false));
        // XDG-only read through the real entry check: a valid entry reads
        // enabled off Niri (and still needs its block on Niri); a stale
        // host reads disabled everywhere.
        let home = scratch("checked-xdg");
        let bin = scratch("checked-xdg-bin");
        let exe = bin.join("gentle-dot");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let dirs = vec![bin];
        write_entry(&home, "gentle-dot.desktop", &plugin_entry(STABLE_APP_NAME, exe.to_str().unwrap()));
        assert!(checked_for(xdg_state(&home, &dirs), false));
        assert!(!checked_for(xdg_state(&home, &dirs), true), "Niri still needs its block");
        std::fs::remove_file(home.join("gentle-dot.desktop")).unwrap();
        assert!(!checked_for(xdg_state(&home, &dirs), false));
    }

    #[test]
    fn shell_toggle_manages_both_backends_without_silent_fallback() {
        // The toggle wires both backends (XDG via the plugin plus the
        // managed Niri block) and never absorbs state errors silently.
        let shell = include_str!("shell.rs");
        assert!(
            shell.contains("ensure_niri_block"),
            "toggle-enable must add the managed Niri block"
        );
        assert!(
            shell.contains("remove_niri_block"),
            "toggle-disable must remove the managed Niri block"
        );
        assert!(
            !shell.contains("is_enabled().unwrap_or(false)"),
            "autostart state must never silently fall back to false"
        );
    }
}
