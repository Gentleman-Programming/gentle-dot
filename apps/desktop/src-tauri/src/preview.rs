//! Compile-time preview policy. No Tauri, registry, profile discovery or secret-store access.
use std::path::{Component, Path, PathBuf};

pub const IDENTIFIER: &str = "dev.gentleman.gentle-dot.preview";
pub const PRODUCT_NAME: &str = "Gentle Dot Preview";
pub const DISABLED: &str = "Unavailable in isolated local preview.";

#[derive(Debug)]
pub struct OwnedRoot {
    data: PathBuf,
}

impl OwnedRoot {
    pub fn data_dir(&self) -> &Path { &self.data }
    pub fn webview_dir(&self) -> PathBuf { self.data.join("webview") }

    /// Override profile locations before any plugin/thread starts. No profile discovery.
    pub fn environment(&self) -> Vec<(&'static str, PathBuf)> {
        [
            ("GENTLE_DOT_DATA_DIR", ""), ("HOME", "home"), ("USERPROFILE", "home"),
            ("APPDATA", "roaming"), ("LOCALAPPDATA", "local"),
            ("TEMP", "tmp"), ("TMP", "tmp"), ("TMPDIR", "tmp"),
            ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"),
        ].into_iter().map(|(key, child)| (key, self.data.join(child))).collect()
    }
}

/// Admission runs before configuration reads, plugins, windows, stores or daemon startup.
/// The callback reuses the production private-directory guard before any child writes.
pub fn prepare(
    identifier: &str,
    product_name: Option<&str>,
    bundled: bool,
    configured_windows: usize,
    root: Option<&Path>,
    protect: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<OwnedRoot, String> {
    if identifier != IDENTIFIER || product_name != Some(PRODUCT_NAME) || bundled || configured_windows != 0 {
        return Err("Local preview requires its preview identity, no bundle and no configured windows.".into());
    }
    let invalid = || "Local preview requires a fresh absolute gentle-dot-preview-* directory with an existing non-reparse parent, outside production data.".to_string();
    let root = root.ok_or_else(invalid)?;
    if !root.is_absolute() || root.parent().is_none_or(|parent| parent.parent().is_none()) {
        return Err(invalid());
    }
    #[cfg(windows)]
    if !matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_))) {
        return Err(invalid()); // No UNC, device or verbatim aliases.
    }
    for component in root.components() {
        match component {
            Component::ParentDir | Component::CurDir => return Err(invalid()),
            Component::Normal(name) => {
                let text = name.to_str().ok_or_else(invalid)?;
                if text.ends_with(['.', ' ']) || text.contains(':')
                    || text.eq_ignore_ascii_case(".gentle-dot")
                    || text.eq_ignore_ascii_case("dev.gentleman.gentle-dot")
                    || text.eq_ignore_ascii_case("Gentle Dot") {
                    return Err(invalid());
                }
            }
            _ => {}
        }
    }
    if !root.file_name().and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("gentle-dot-preview-") && name.len() > "gentle-dot-preview-".len()) {
        return Err(invalid());
    }
    // Do not follow junctions/symlinks into shared data. No recursive parent creation.
    for ancestor in root.parent().ok_or_else(invalid)?.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| invalid())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(invalid()); }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 { return Err(invalid()); }
        }
    }
    std::fs::create_dir(root).map_err(|_| invalid())?; // Exclusive: existing files/directories fail untouched.
    protect(root)?; // Reuse native privacy/ACL invariants, not an alternate synthetic guard.
    Ok(OwnedRoot { data: root.to_path_buf() })
}

pub fn port(value: Option<&str>) -> Result<u16, String> {
    value.filter(|text| !text.is_empty() && text.bytes().all(|c| c.is_ascii_digit()))
        .and_then(|text| text.parse::<u16>().ok()).filter(|port| *port != 0 && *port != 4317)
        .ok_or_else(|| "Local preview requires an explicit GENTLE_DOT_PORT in 1..65535 other than 4317.".into())
}

pub fn blocked_command(command: &str) -> bool {
    matches!(command, "shortcut_get" | "shortcut_set")
        || command.starts_with("plugin:autostart|")
        || command.starts_with("plugin:global-shortcut|")
        || command.starts_with("voice_")
        || (command.starts_with("computer_") && command != "computer_stop")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let parent = std::env::temp_dir().join(format!("preview-policy-{}-{nonce}", std::process::id()));
        fs::create_dir(&parent).unwrap();
        parent
    }

    fn admit(path: Option<&Path>, calls: &Cell<usize>) -> Result<OwnedRoot, String> {
        prepare(IDENTIFIER, Some(PRODUCT_NAME), false, 0, path, |_| {
            calls.set(calls.get() + 1);
            Ok(())
        })
    }

    #[test]
    fn fresh_root_is_exclusive_and_both_surfaces_share_its_webview_directory() {
        let parent = fixture();
        let root = parent.join("gentle-dot-preview-owned");
        let calls = Cell::new(0);
        let owned = admit(Some(&root), &calls).unwrap();
        assert_eq!(owned.data_dir(), root);
        assert_eq!(owned.webview_dir(), root.join("webview"));
        assert_eq!(calls.get(), 1);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::write(root.join("sentinel"), b"synthetic").unwrap();
        assert!(admit(Some(&root), &calls).is_err());
        assert_eq!(calls.get(), 1);
        assert_eq!(fs::read(root.join("sentinel")).unwrap(), b"synthetic");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn rejected_identity_bundle_and_preconfigured_windows_never_create_or_protect_data() {
        let parent = fixture();
        let root = parent.join("gentle-dot-preview-identity");
        for (id, name, bundle, windows) in [
            ("dev.gentleman.gentle-dot", Some(PRODUCT_NAME), false, 0),
            (IDENTIFIER, Some("Gentle Dot"), false, 0),
            (IDENTIFIER, None, false, 0),
            (IDENTIFIER, Some(PRODUCT_NAME), true, 0),
            (IDENTIFIER, Some(PRODUCT_NAME), false, 1),
        ] {
            let calls = Cell::new(0);
            assert!(prepare(id, name, bundle, windows, Some(&root), |_| {
                calls.set(calls.get() + 1); Ok(())
            }).is_err());
            assert_eq!(calls.get(), 0);
            assert!(!root.exists());
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        }
    }

    #[test]
    fn missing_relative_shared_and_non_owned_names_are_inert() {
        let parent = fixture();
        let missing_parent = parent.join("missing").join("gentle-dot-preview-owned");
        let shared = parent.join(".gentle-dot").join("gentle-dot-preview-owned");
        let alias = parent.join("..").join("gentle-dot-preview-alias");
        let generic = parent.join("data");
        let calls = Cell::new(0);
        for root in [None, Some(Path::new("")), Some(Path::new("relative")),
            Some(shared.as_path()), Some(alias.as_path()), Some(generic.as_path()), Some(missing_parent.as_path())] {
            assert!(admit(root, &calls).is_err());
            assert_eq!(calls.get(), 0);
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        }
    }

    #[test]
    fn an_existing_file_is_not_read_or_changed() {
        let parent = fixture();
        let file = parent.join("gentle-dot-preview-file");
        fs::write(&file, b"sentinel").unwrap();
        let calls = Cell::new(0);
        assert!(admit(Some(&file), &calls).is_err());
        assert_eq!(calls.get(), 0);
        assert_eq!(fs::read(&file).unwrap(), b"sentinel");
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    }

    #[test]
    fn private_directory_failure_retains_only_the_owned_empty_root_and_stops() {
        let parent = fixture();
        let root = parent.join("gentle-dot-preview-acl-failure");
        let calls = Cell::new(0);
        let result = prepare(IDENTIFIER, Some(PRODUCT_NAME), false, 0, Some(&root), |_| {
            calls.set(calls.get() + 1); Err("synthetic ACL refusal".into())
        });
        assert_eq!(result.unwrap_err(), "synthetic ACL refusal");
        assert_eq!(calls.get(), 1);
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[test]
    fn preview_refuses_global_integrations_and_native_activation_but_keeps_stop_and_ui() {
        for command in ["shortcut_get", "shortcut_set", "plugin:autostart|enable",
            "plugin:autostart|is_enabled", "plugin:global-shortcut|unregister_all", "voice_start",
            "voice_model_download", "voice_synthesize", "computer_endpoint", "computer_set_yolo"] {
            assert!(blocked_command(command), "{command}");
        }
        for command in ["connection_info", "hide_panel", "toggle_panel", "computer_stop",
            "set_dot_state", "connector_command", "memory_get"] {
            assert!(!blocked_command(command), "{command}");
        }
    }

    #[test]
    fn preview_requires_an_explicit_nonproduction_nonzero_port() {
        for bad in [None, Some(""), Some("0"), Some("4317"), Some("65536"), Some("-1"), Some("no"), Some(" 5500 ")] {
            assert!(port(bad).is_err(), "{bad:?}");
        }
        assert_eq!(port(Some("5500")), Ok(5500));
        assert_eq!(port(Some("65535")), Ok(65535));
    }
}
