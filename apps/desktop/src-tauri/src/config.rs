//! Desktop view of `~/.gentle-dot/config.json` and the connection details the UI needs.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 4317;
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopConfig {
    pub data_dir: PathBuf,
    pub port: u16,
    pub shortcut: String,
}

/// Result of the `connection_info` command (design §9).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub url: String,
    pub token: String,
    pub web_url: String,
}

/// `GENTLE_DOT_DATA_DIR` (with `~` expanded) or `~/.gentle-dot`.
pub fn data_dir(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    match env("GENTLE_DOT_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(dir) if dir == "~" => home.to_path_buf(),
        Some(dir) => match dir.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(dir),
        },
        None => home.join(".gentle-dot"),
    }
}

fn valid_port(value: Option<u64>) -> Option<u16> {
    value.and_then(|port| u16::try_from(port).ok())
}

/// Resolves the port and shortcut: environment first, then the file, then defaults.
/// A missing or invalid file never prevents the app from starting.
pub fn parse_config(
    data_dir: PathBuf,
    file: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> DesktopConfig {
    let file: serde_json::Value = file
        .and_then(|text| serde_json::from_str(text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_default();
    let port = valid_port(env("GENTLE_DOT_PORT").and_then(|v| v.trim().parse().ok()))
        .or_else(|| valid_port(file["port"].as_u64()))
        .unwrap_or(DEFAULT_PORT);
    let shortcut = file["shortcut"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SHORTCUT)
        .to_string();
    DesktopConfig { data_dir, port, shortcut }
}

/// Reads the real environment and `<data dir>/config.json`.
pub fn load_config() -> DesktopConfig {
    let env = |key: &str| std::env::var(key).ok();
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let dir = data_dir(env, &home);
    let file = std::fs::read_to_string(dir.join("config.json")).ok();
    parse_config(dir, file.as_deref(), env)
}

pub const INVALID_CONFIG: &str =
    "config.json is not valid JSON, so Gentle Dot left it as it is. Fix or remove it, then try again.";

/// The text of `config.json` with `shortcut` set and every other key kept.
/// A file that is not a JSON object is refused rather than replaced.
pub fn with_shortcut(file: Option<&str>, shortcut: &str) -> Result<String, String> {
    let mut json = match file {
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or(INVALID_CONFIG)?,
        None => serde_json::json!({}),
    };
    json["shortcut"] = shortcut.into();
    let text = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    Ok(text + "\n")
}

/// Saves the shortcut in `config.json` (S33.3): read, change one key, then write a private
/// temporary file and rename it over the old one, so a crash never leaves half a file.
pub fn save_shortcut(path: &Path, shortcut: &str) -> Result<(), String> {
    let file = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Gentle Dot cannot read config.json ({error}), so the shortcut was not saved.")),
    };
    let text = with_shortcut(file.as_deref(), shortcut)?;
    write_private(path, &text).map_err(|error| format!("Gentle Dot cannot save config.json ({error})."))
}

fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config.json");
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&temp).and_then(|mut out| {
        // `mode` only applies to a new file; a leftover temporary file is made private too.
        #[cfg(unix)]
        std::fs::set_permissions(&temp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        out.write_all(text.as_bytes())?;
        out.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&temp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

pub fn connection_info(port: u16, token: &str) -> ConnectionInfo {
    ConnectionInfo {
        url: format!("ws://127.0.0.1:{port}/ws"),
        token: token.to_string(),
        web_url: format!("http://127.0.0.1:{port}/#token={token}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    fn dir() -> PathBuf {
        PathBuf::from("/data")
    }

    #[test]
    fn data_dir_defaults_to_home_dot_folder() {
        assert_eq!(data_dir(env_of(&[]), Path::new("/Users/me")), PathBuf::from("/Users/me/.gentle-dot"));
    }

    #[test]
    fn data_dir_honors_env_and_expands_home() {
        let home = Path::new("/Users/me");
        assert_eq!(data_dir(env_of(&[("GENTLE_DOT_DATA_DIR", "/tmp/dot")]), home), PathBuf::from("/tmp/dot"));
        assert_eq!(data_dir(env_of(&[("GENTLE_DOT_DATA_DIR", "~/other")]), home), PathBuf::from("/Users/me/other"));
        assert_eq!(data_dir(env_of(&[("GENTLE_DOT_DATA_DIR", "")]), home), PathBuf::from("/Users/me/.gentle-dot"));
    }

    #[test]
    fn defaults_without_file() {
        let config = parse_config(dir(), None, env_of(&[]));
        assert_eq!(config, DesktopConfig { data_dir: dir(), port: DEFAULT_PORT, shortcut: DEFAULT_SHORTCUT.into() });
    }

    #[test]
    fn reads_port_and_shortcut_from_file() {
        let config = parse_config(dir(), Some(r#"{ "port": 5000, "shortcut": "Cmd+Shift+K", "workspace": "~" }"#), env_of(&[]));
        assert_eq!(config.port, 5000);
        assert_eq!(config.shortcut, "Cmd+Shift+K");
    }

    #[test]
    fn env_port_overrides_file() {
        let config = parse_config(dir(), Some(r#"{ "port": 5000 }"#), env_of(&[("GENTLE_DOT_PORT", "6000")]));
        assert_eq!(config.port, 6000);
    }

    #[test]
    fn invalid_values_fall_back() {
        let config = parse_config(dir(), Some(r#"{ "port": 70000, "shortcut": 3 }"#), env_of(&[("GENTLE_DOT_PORT", "abc")]));
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.shortcut, DEFAULT_SHORTCUT);
        let config = parse_config(dir(), Some(r#"{ "port": "5001", "shortcut": "  " }"#), env_of(&[]));
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.shortcut, DEFAULT_SHORTCUT);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let config = parse_config(dir(), Some("{ not json"), env_of(&[]));
        assert_eq!(config.port, DEFAULT_PORT);
        let config = parse_config(dir(), Some("[1, 2]"), env_of(&[]));
        assert_eq!(config.shortcut, DEFAULT_SHORTCUT);
    }

    #[test]
    fn saving_a_shortcut_keeps_every_other_key() {
        let text = with_shortcut(Some(r#"{ "port": 5000, "shortcut": "Alt+Space", "workspace": "~", "extra": { "a": [1] } }"#), "Ctrl+Alt+K").unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json, serde_json::json!({ "port": 5000, "shortcut": "Ctrl+Alt+K", "workspace": "~", "extra": { "a": [1] } }));
        let json: serde_json::Value = serde_json::from_str(&with_shortcut(None, "F5").unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "shortcut": "F5" }));
    }

    #[test]
    fn an_invalid_file_is_not_overwritten() {
        assert_eq!(with_shortcut(Some("{ not json"), "F5"), Err(INVALID_CONFIG.to_string()));
        assert_eq!(with_shortcut(Some("[1, 2]"), "F5"), Err(INVALID_CONFIG.to_string()));
    }

    #[test]
    fn parsing_is_unchanged_after_saving_a_shortcut() {
        // The file the app writes reads back like any hand-written one: port, shortcut, defaults.
        let text = with_shortcut(Some(r#"{ "port": 5000, "workspace": "~" }"#), "Shift+Super+K").unwrap();
        let config = parse_config(dir(), Some(&text), env_of(&[]));
        assert_eq!(config, DesktopConfig { data_dir: dir(), port: 5000, shortcut: "Shift+Super+K".into() });
        let config = parse_config(dir(), Some(&text), env_of(&[("GENTLE_DOT_PORT", "6000")]));
        assert_eq!(config.port, 6000);
        let text = with_shortcut(None, "F5").unwrap();
        assert_eq!(parse_config(dir(), Some(&text), env_of(&[])).port, DEFAULT_PORT);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch/config").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_the_shortcut_privately_in_place() {
        let dir = scratch("save");
        let file = dir.join("config.json");
        std::fs::write(&file, r#"{ "port": 5000 }"#).unwrap();
        save_shortcut(&file, "Ctrl+Alt+K").unwrap();
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "port": 5000, "shortcut": "Ctrl+Alt+K" }));
        // Nothing else is left in the folder (the temporary file was renamed over the old one).
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A missing file is created.
        let fresh = scratch("fresh").join("config.json");
        save_shortcut(&fresh, "F5").unwrap();
        assert_eq!(parse_config(dir.clone(), std::fs::read_to_string(&fresh).ok().as_deref(), env_of(&[])).shortcut, "F5");
    }

    #[test]
    fn a_bad_file_is_reported_and_left_untouched() {
        let dir = scratch("bad");
        let file = dir.join("config.json");
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(save_shortcut(&file, "F5"), Err(INVALID_CONFIG.to_string()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        // A folder where the file should be cannot be read as one.
        let unreadable = scratch("unreadable").join("config.json");
        std::fs::create_dir_all(&unreadable).unwrap();
        let error = save_shortcut(&unreadable, "F5").unwrap_err();
        assert!(error.starts_with("Gentle Dot cannot read config.json"), "{error}");
        assert!(unreadable.is_dir());
    }

    #[test]
    fn connection_info_builds_ws_and_web_urls() {
        let info = connection_info(4317, "abc_-9");
        assert_eq!(info.url, "ws://127.0.0.1:4317/ws");
        assert_eq!(info.token, "abc_-9");
        assert_eq!(info.web_url, "http://127.0.0.1:4317/#token=abc_-9");
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["webUrl"], "http://127.0.0.1:4317/#token=abc_-9");
    }
}
