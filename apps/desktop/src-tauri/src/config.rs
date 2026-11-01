//! Desktop view of `~/.gentle-dot/config.json` and the connection details the UI needs.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 4317;

/// The panel shortcut a fresh install binds, per platform (Windows avoids `Alt+Space`, its
/// window-menu key). See [`crate::platform::Os::default_shortcut`].
pub fn default_shortcut() -> &'static str {
    crate::platform::Os::CURRENT.default_shortcut()
}

/// The assistant's memory mode (SW9), spelled `shared`/`private` in `config.json`: the user's own
/// Engram (`Shared`, the default) or a private store of the assistant's own (`Private`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMode {
    Shared,
    Private,
}

impl MemoryMode {
    pub const DEFAULT: MemoryMode = MemoryMode::Shared;

    pub fn as_str(self) -> &'static str {
        match self {
            MemoryMode::Shared => "shared",
            MemoryMode::Private => "private",
        }
    }

    /// The mode a `memory_set` call asked for, or the named error that refuses anything else.
    pub fn parse(value: &str) -> Result<MemoryMode, String> {
        match value {
            "shared" => Ok(MemoryMode::Shared),
            "private" => Ok(MemoryMode::Private),
            other => Err(invalid_memory(other)),
        }
    }
}

/// The named error for a `memory` value that is neither `shared` nor `private` (SW9): it names the
/// file and the value with the daemon's own wording. Known divergence from the daemon's JS
/// `String(value)`: a JSON object or array renders as Rust JSON (`{"a":1}`, `[1,2]`) where the
/// daemon renders `[object Object]` / `1,2`; scalars and `null` match exactly.
pub fn invalid_memory(value: &str) -> String {
    format!("Invalid memory in config.json: {value}")
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopConfig {
    pub data_dir: PathBuf,
    pub port: u16,
    pub shortcut: String,
    pub memory: MemoryMode,
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

/// Resolves the port, shortcut and memory mode: environment first, then the file, then defaults.
/// A missing or unreadable file never prevents the app from starting; a `memory` value the file
/// spells differently from `shared`/`private` is refused with a named error (SW9).
pub fn parse_config(
    data_dir: PathBuf,
    file: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<DesktopConfig, String> {
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
        .unwrap_or_else(|| default_shortcut())
        .to_string();
    let memory = parse_memory(&file)?;
    Ok(DesktopConfig { data_dir, port, shortcut, memory })
}

/// The mode `config.json` names: `shared` when the key is absent, matching the daemon, which reads
/// `undefined` as shared but refuses `null` and every other spelling with a named error.
fn parse_memory(file: &serde_json::Value) -> Result<MemoryMode, String> {
    match file.get("memory") {
        None => Ok(MemoryMode::DEFAULT),
        Some(serde_json::Value::String(text)) => MemoryMode::parse(text),
        Some(other) => Err(invalid_memory(&other.to_string())),
    }
}

/// Nothing names a home folder, so there is nowhere to keep the app's data.
pub const NO_HOME: &str =
    "Gentle Dot cannot find your home folder, so there is nowhere to keep its data. Set GENTLE_DOT_DATA_DIR to a folder and start it again.";

/// The data dir. `GENTLE_DOT_DATA_DIR` wins and needs no home unless its value names one with
/// `~`; otherwise the home comes from [`crate::platform::home_dir`], and a home that cannot be
/// resolved is an error rather than a relative `.gentle-dot` resolved against the working
/// directory — which is what made the app miss its own token on Windows (W22).
pub fn resolve_data_dir(os: crate::platform::Os, env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    match env("GENTLE_DOT_DATA_DIR").filter(|value| !value.is_empty()) {
        Some(dir) if !dir.starts_with('~') => Ok(PathBuf::from(dir)),
        _ => {
            let home = crate::platform::home_dir(os, &env).ok_or_else(|| NO_HOME.to_string())?;
            Ok(data_dir(env, &home))
        }
    }
}

/// Reads the real environment and `<data dir>/config.json`.
pub fn load_config() -> Result<DesktopConfig, String> {
    let env = |key: &str| std::env::var(key).ok();
    let dir = resolve_data_dir(crate::platform::Os::CURRENT, &env)?;
    let file = std::fs::read_to_string(dir.join("config.json")).ok();
    parse_config(dir, file.as_deref(), &env)
}

pub const INVALID_CONFIG: &str =
    "config.json is not valid JSON, so Gentle Dot left it as it is. Fix or remove it, then try again.";

/// The text of `config.json` with one key set and every other key kept. A file that is not a JSON
/// object is refused rather than replaced.
fn with_key(file: Option<&str>, key: &str, value: serde_json::Value) -> Result<String, String> {
    let mut json = match file {
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or(INVALID_CONFIG)?,
        None => serde_json::json!({}),
    };
    json[key] = value;
    let text = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    Ok(text + "\n")
}

/// The text of `config.json` with `shortcut` set and every other key kept.
pub fn with_shortcut(file: Option<&str>, shortcut: &str) -> Result<String, String> {
    with_key(file, "shortcut", shortcut.into())
}

/// The text of `config.json` with `memory` set and every other key kept (SW9).
pub fn with_memory(file: Option<&str>, memory: MemoryMode) -> Result<String, String> {
    with_key(file, "memory", memory.as_str().into())
}

fn save_key(path: &Path, key: &str, what: &str, value: serde_json::Value) -> Result<(), String> {
    let file = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Gentle Dot cannot read config.json ({error}), so the {what} was not saved.")),
    };
    let text = with_key(file.as_deref(), key, value)?;
    write_private(path, &text).map_err(|error| format!("Gentle Dot cannot save config.json ({error})."))
}

/// Saves the shortcut in `config.json` (S33.3): read, change one key, then write a private
/// temporary file and rename it over the old one, so a crash never leaves half a file.
pub fn save_shortcut(path: &Path, shortcut: &str) -> Result<(), String> {
    save_key(path, "shortcut", "shortcut", shortcut.into())
}

/// Saves the memory mode in `config.json` (SW9), the shortcut's way: one key changed, every other
/// key kept, written privately and renamed over the old file.
pub fn save_memory(path: &Path, memory: MemoryMode) -> Result<(), String> {
    save_key(path, "memory", "memory mode", memory.as_str().into())
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
    fn the_data_dir_never_falls_back_to_a_relative_path() {
        use crate::platform::Os;
        let windows = |pairs: &'static [(&'static str, &'static str)]| resolve_data_dir(Os::Windows, env_of(pairs));
        // Built with Path::join rather than written as a literal: this test drives the Windows
        // resolution on every host, and on macOS and Linux a backslash is not a separator, so the
        // literal is one component there while the resolved value is two. Comparing the two
        // constructions is the only portable way to assert the exact result (POSIX run 39869942335).
        let expected = Path::new(r"C:\Users\me").join(".gentle-dot");
        assert_eq!(windows(&[("USERPROFILE", r"C:\Users\me")]), Ok(expected.clone()));
        assert_eq!(
            windows(&[("HOMEDRIVE", "C:"), ("HOMEPATH", r"\Users\me")]),
            Ok(expected.clone())
        );
        // The W22 bug: a Windows GUI launch has no HOME. That is an error, never `.gentle-dot`.
        assert_eq!(windows(&[]), Err(NO_HOME.to_string()));
        assert_eq!(windows(&[("HOME", r"C:\Users\me")]), Err(NO_HOME.to_string()));
        // An explicit absolute dir needs no home; a `~` value still does.
        assert_eq!(windows(&[("GENTLE_DOT_DATA_DIR", r"D:\dot")]), Ok(PathBuf::from(r"D:\dot")));
        assert_eq!(
            resolve_data_dir(Os::Linux, env_of(&[("HOME", "/home/me"), ("GENTLE_DOT_DATA_DIR", "~/dot")])),
            Ok(PathBuf::from("/home/me/dot"))
        );
        assert_eq!(resolve_data_dir(Os::Linux, env_of(&[])), Err(NO_HOME.to_string()));
        assert_eq!(resolve_data_dir(Os::MacOs, env_of(&[("HOME", "/Users/me")])), Ok(PathBuf::from("/Users/me/.gentle-dot")));
    }

    #[test]
    fn defaults_without_file() {
        let config = parse_config(dir(), None, env_of(&[])).unwrap();
        assert_eq!(
            config,
            DesktopConfig { data_dir: dir(), port: DEFAULT_PORT, shortcut: default_shortcut().into(), memory: MemoryMode::DEFAULT }
        );
    }

    #[test]
    fn reads_port_and_shortcut_from_file() {
        let config = parse_config(dir(), Some(r#"{ "port": 5000, "shortcut": "Cmd+Shift+K", "workspace": "~" }"#), env_of(&[])).unwrap();
        assert_eq!(config.port, 5000);
        assert_eq!(config.shortcut, "Cmd+Shift+K");
    }

    #[test]
    fn memory_defaults_to_shared_and_reads_from_the_file() {
        assert_eq!(parse_config(dir(), None, env_of(&[])).unwrap().memory, MemoryMode::Shared);
        let private = parse_config(dir(), Some(r#"{ "memory": "private" }"#), env_of(&[])).unwrap();
        assert_eq!(private.memory, MemoryMode::Private);
        let shared = parse_config(dir(), Some(r#"{ "memory": "shared" }"#), env_of(&[])).unwrap();
        assert_eq!(shared.memory, MemoryMode::Shared);
    }

    #[test]
    fn an_invalid_memory_value_is_refused_with_the_file_and_the_value() {
        // The daemon reads only an absent key as shared; `null` is refused like any other value.
        let cases = [
            (r#"{ "memory": "privat" }"#, "privat"),
            (r#"{ "memory": "Private" }"#, "Private"),
            (r#"{ "memory": null }"#, "null"),
            (r#"{ "memory": 3 }"#, "3"),
            (r#"{ "memory": true }"#, "true"),
        ];
        for (file, value) in cases {
            assert_eq!(parse_config(dir(), Some(file), env_of(&[])), Err(format!("Invalid memory in config.json: {value}")));
        }
    }

    #[test]
    fn env_port_overrides_file() {
        let config = parse_config(dir(), Some(r#"{ "port": 5000 }"#), env_of(&[("GENTLE_DOT_PORT", "6000")])).unwrap();
        assert_eq!(config.port, 6000);
    }

    #[test]
    fn invalid_values_fall_back() {
        let config = parse_config(dir(), Some(r#"{ "port": 70000, "shortcut": 3 }"#), env_of(&[("GENTLE_DOT_PORT", "abc")])).unwrap();
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.shortcut, default_shortcut());
        let config = parse_config(dir(), Some(r#"{ "port": "5001", "shortcut": "  " }"#), env_of(&[])).unwrap();
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.shortcut, default_shortcut());
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let config = parse_config(dir(), Some("{ not json"), env_of(&[])).unwrap();
        assert_eq!(config.port, DEFAULT_PORT);
        let config = parse_config(dir(), Some("[1, 2]"), env_of(&[])).unwrap();
        assert_eq!(config.shortcut, default_shortcut());
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
        let config = parse_config(dir(), Some(&text), env_of(&[])).unwrap();
        assert_eq!(
            config,
            DesktopConfig { data_dir: dir(), port: 5000, shortcut: "Shift+Super+K".into(), memory: MemoryMode::DEFAULT }
        );
        let config = parse_config(dir(), Some(&text), env_of(&[("GENTLE_DOT_PORT", "6000")])).unwrap();
        assert_eq!(config.port, 6000);
        let text = with_shortcut(None, "F5").unwrap();
        assert_eq!(parse_config(dir(), Some(&text), env_of(&[])).unwrap().port, DEFAULT_PORT);
    }

    #[test]
    fn saving_a_memory_mode_keeps_every_other_key() {
        let text = with_memory(
            Some(r#"{ "port": 5000, "shortcut": "Alt+Space", "memory": "shared", "extra": { "a": [1] } }"#),
            MemoryMode::Private,
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "port": 5000, "shortcut": "Alt+Space", "memory": "private", "extra": { "a": [1] } })
        );
        let json: serde_json::Value = serde_json::from_str(&with_memory(None, MemoryMode::Private).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "memory": "private" }));
        // A file that is not an object is refused, exactly as the shortcut's writer refuses it.
        assert_eq!(with_memory(Some("{ not json"), MemoryMode::Private), Err(INVALID_CONFIG.to_string()));
        assert_eq!(with_memory(Some("[1, 2]"), MemoryMode::Private), Err(INVALID_CONFIG.to_string()));
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
        assert_eq!(parse_config(dir.clone(), std::fs::read_to_string(&fresh).ok().as_deref(), env_of(&[])).unwrap().shortcut, "F5");
    }

    #[test]
    fn saves_the_memory_mode_privately_in_place() {
        let dir = scratch("memory");
        let file = dir.join("config.json");
        std::fs::write(&file, r#"{ "port": 5000, "shortcut": "Alt+Space" }"#).unwrap();
        save_memory(&file, MemoryMode::Private).unwrap();
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "port": 5000, "shortcut": "Alt+Space", "memory": "private" }));
        // Nothing else is left in the folder (the temporary file was renamed over the old one).
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // The file the app wrote reads back as the private mode, with the other keys kept.
        let config = parse_config(dir.clone(), std::fs::read_to_string(&file).ok().as_deref(), env_of(&[])).unwrap();
        assert_eq!(config.memory, MemoryMode::Private);
        assert_eq!(config.shortcut, "Alt+Space");
        // A missing file is created with just the key.
        let fresh = scratch("memory-fresh").join("config.json");
        save_memory(&fresh, MemoryMode::Private).unwrap();
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fresh).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "memory": "private" }));
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
