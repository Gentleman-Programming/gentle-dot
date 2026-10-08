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
    fn connection_info_builds_ws_and_web_urls() {
        let info = connection_info(4317, "abc_-9");
        assert_eq!(info.url, "ws://127.0.0.1:4317/ws");
        assert_eq!(info.token, "abc_-9");
        assert_eq!(info.web_url, "http://127.0.0.1:4317/#token=abc_-9");
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["webUrl"], "http://127.0.0.1:4317/#token=abc_-9");
    }
}
