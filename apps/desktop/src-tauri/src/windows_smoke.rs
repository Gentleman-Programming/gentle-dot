//! Explicit development isolation; never selected by the production store factory.

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
use std::path::Path;
use std::path::PathBuf;

pub(crate) const ENABLED: bool = cfg!(all(feature = "windows-smoke-test", debug_assertions));
const SMOKE_ID: &str = "dev.gentleman.gentle-dot.windows-smoke";

pub(crate) struct Settings {
    root: PathBuf,
    runtime: PathBuf,
    port: u16,
    memory_port: u16,
    #[cfg(all(feature = "windows-smoke-test", debug_assertions))]
    identity_guards: Vec<crate::secure_store::SmokeDirectory>,
}

// Reject Win32 aliases, device namespaces, ADS and path normalization before any I/O.
fn absolute_directory(value: &str) -> Result<PathBuf, String> {
    let bytes = value.as_bytes();
    let invalid = || {
        "smoke paths must be explicit absolute plain drive directories without aliases".to_string()
    };
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || ![b'/', b'\\'].contains(&bytes[2])
    {
        return Err(invalid());
    }
    for part in value[3..].split(['/', '\\']) {
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part.ends_with([' ', '.'])
            || part.chars().any(|c| c < ' ' || ":*?\"<>|".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
            || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&base.as_str())
            || ["COM", "LPT"].iter().any(|prefix| {
                base.strip_prefix(*prefix)
                    .is_some_and(|n| n.len() == 1 && (b'1'..=b'9').contains(&n.as_bytes()[0]))
            })
        {
            return Err(invalid());
        }
    }
    Ok(PathBuf::from(value))
}

impl Settings {
    fn parse(env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let required =
            |key| env(key).ok_or_else(|| format!("{key} is required by windows-smoke-test"));
        let port = |key| -> Result<u16, String> {
            required(key)?
                .parse::<u16>()
                .ok()
                .filter(|p| *p >= 1024 && ![4317, 5173, 7437, 7438].contains(p))
                .ok_or_else(|| format!("{key} must be a nonstandard port from 1024 to 65535"))
        };
        let settings = Self {
            root: absolute_directory(&required("GENTLE_DOT_SMOKE_ROOT")?)?,
            runtime: absolute_directory(&required("GENTLE_DOT_SMOKE_RUNTIME_DIR")?)?,
            port: port("GENTLE_DOT_SMOKE_PORT")?,
            memory_port: port("GENTLE_DOT_SMOKE_ENGRAM_PORT")?,
            #[cfg(all(feature = "windows-smoke-test", debug_assertions))]
            identity_guards: Vec::new(),
        };
        if settings.port == settings.memory_port || settings.runtime.starts_with(&settings.root) {
            return Err(
                "smoke ports must differ and the read-only runtime must be outside the fresh root"
                    .into(),
            );
        }
        Ok(settings)
    }

    fn child_env(
        &self,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Vec<(String, String)>, String> {
        let system = absolute_directory(&env("SystemRoot").ok_or("SystemRoot is required")?)?;
        let profile = self.root.join("profile");
        let data = self.root.join("data");
        let mut values = vec![
            ("SystemRoot".into(), system.display().to_string()),
            ("WINDIR".into(), system.display().to_string()),
            (
                "COMSPEC".into(),
                system.join("System32/cmd.exe").display().to_string(),
            ),
            ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
            (
                "PATH".into(),
                format!(
                    "{};{};{};{}",
                    self.runtime.join("bin").display(),
                    self.runtime.join("node/bin").display(),
                    system.join("System32").display(),
                    system.display()
                ),
            ),
            ("GENTLE_DOT_PORT".into(), self.port.to_string()),
            ("GENTLE_DOT_HOST".into(), "127.0.0.1".into()),
            ("GENTLE_DOT_ENGRAM".into(), "private".into()),
            (
                "GENTLE_DOT_ENGRAM_PORT".into(),
                self.memory_port.to_string(),
            ),
            ("GENTLE_DOT_SUBAGENTS".into(), "off".into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            (
                "GENTLE_DOT_ALLOWED_ORIGINS".into(),
                crate::daemon::DEV_ALLOWED_ORIGINS.into(),
            ),
        ];
        for (key, path) in [
            ("HOME", profile.clone()),
            ("USERPROFILE", profile.clone()),
            ("APPDATA", profile.join("AppData/Roaming")),
            ("LOCALAPPDATA", profile.join("AppData/Local")),
            ("TEMP", self.root.join("tmp")),
            ("TMP", self.root.join("tmp")),
            ("TMPDIR", self.root.join("tmp")),
            ("XDG_CONFIG_HOME", profile.join(".config")),
            ("XDG_DATA_HOME", profile.join(".local/share")),
            ("XDG_CACHE_HOME", profile.join(".cache")),
            ("XDG_STATE_HOME", profile.join(".local/state")),
            ("GIT_CONFIG_GLOBAL", profile.join(".gitconfig")),
            ("GENTLE_DOT_DATA_DIR", data.clone()),
            ("GENTLE_DOT_AGENT_HOME", data.join("agent")),
            ("GENTLE_DOT_WORKSPACE", data.join("workspace")),
            ("GENTLE_DOT_RUNTIME", self.runtime.clone()),
            ("GENTLE_DOT_UI_DIR", self.runtime.join("ui")),
            ("ENGRAM_BIN", self.runtime.join("bin/engram.exe")),
        ] {
            values.push((key.into(), path.display().to_string()));
        }
        Ok(values)
    }
}

fn options_from(env: impl Fn(&str) -> Option<String>) -> Result<Option<Settings>, String> {
    if ENABLED {
        Settings::parse(env).map(Some)
    } else {
        Ok(None)
    }
}

pub(crate) fn options() -> Result<Option<Settings>, String> {
    let options = options_from(|key| std::env::var(key).ok())?;
    #[cfg(all(feature = "windows-smoke-test", debug_assertions))]
    let options = options
        .map(|mut settings| {
            let (root, guard) = crate::secure_store::canonical_smoke_root(&settings.root)
                .map_err(|error| error.to_string())?;
            settings.root = root;
            settings.identity_guards.push(guard);
            Ok::<_, String>(settings)
        })
        .transpose()?;
    Ok(options)
}

fn instance_identifier(canonical_root: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    use std::os::windows::ffi::OsStrExt;
    // Hash canonical UTF-16 losslessly. Unicode uppercase expansion could collide
    // distinct NTFS names (for example Straße and STRASSE), so do not case-fold here.
    let mut digest = Sha256::new();
    for unit in canonical_root.as_os_str().encode_wide() {
        digest.update(unit.to_le_bytes());
    }
    format!("{SMOKE_ID}.r{:x}", digest.finalize())
}

pub(crate) fn configure_context(
    context: &mut tauri::Context<tauri::Wry>,
    options: Option<&Settings>,
) {
    if let Some(options) = options {
        let config = context.config_mut();
        config.identifier = instance_identifier(&options.root);
        config.app.windows.clear();
        config.app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(options.root.join("tauri")),
        );
    }
}

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
struct Session {
    settings: Settings,
    child_env: Vec<(String, String)>,
    // Pinned, validated ancestry for the entire process lifetime; never repair a caller's DACL.
    _guards: Vec<crate::secure_store::SmokeDirectory>,
}
#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
static SESSION: std::sync::OnceLock<Session> = std::sync::OnceLock::new();

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
pub(crate) fn initialize(settings: Settings) -> Result<crate::config::DesktopConfig, String> {
    crate::daemon::validate_packaged_runtime(|_| None, true, Some(&settings.runtime))?;
    if !settings.runtime.join("bin/private-storage.exe").is_file() {
        return Err("smoke runtime requires bin/private-storage.exe".into());
    }
    let child_env = settings.child_env(|key| std::env::var(key).ok())?;
    check_ports(&settings)?;
    let mut guards = Vec::new();
    for relative in [
        "",
        "data",
        "profile",
        "tauri",
        "webview",
        "secrets",
        "tmp",
        "profile/AppData",
        "profile/AppData/Roaming",
        "profile/AppData/Local",
    ] {
        guards.push(
            crate::secure_store::prepare_smoke_directory(settings.root.join(relative), true)
                .map_err(|error| error.to_string())?,
        );
    }
    let config = crate::config::parse_config(settings.root.join("data"), None, |key| {
        (key == "GENTLE_DOT_PORT").then(|| settings.port.to_string())
    });
    SESSION
        .set(Session {
            settings,
            child_env,
            _guards: guards,
        })
        .map_err(|_| "smoke session already initialized")?;
    Ok(config)
}

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
fn check_ports(settings: &Settings) -> Result<(), String> {
    let _app = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, settings.port))
        .map_err(|_| "smoke daemon port is not free")?;
    let _memory =
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, settings.memory_port))
            .map_err(|_| "smoke private memory port is not free")?;
    Ok(())
}

pub(crate) fn webview_directory() -> Option<PathBuf> {
    #[cfg(all(feature = "windows-smoke-test", debug_assertions))]
    return Some(
        SESSION
            .get()
            .expect("isolation must precede every webview")
            .settings
            .root
            .join("webview"),
    );
    #[cfg(not(all(feature = "windows-smoke-test", debug_assertions)))]
    None
}

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
pub(crate) fn connector_store() -> Box<dyn crate::secure_store::SecretStore> {
    let session = SESSION
        .get()
        .expect("isolation must precede the secret store");
    Box::new(crate::secure_store::WindowsDpapiStore::for_smoke(
        session.settings.root.join("secrets"),
    ))
}

#[cfg(all(feature = "windows-smoke-test", debug_assertions))]
pub(crate) fn launch_spec(data_dir: &Path) -> std::io::Result<crate::daemon::LaunchSpec> {
    let session = SESSION
        .get()
        .ok_or_else(|| std::io::Error::other("smoke isolation is not initialized"))?;
    if data_dir != session.settings.root.join("data") {
        return Err(std::io::Error::other(
            "smoke daemon data directory mismatch",
        ));
    }
    check_ports(&session.settings).map_err(std::io::Error::other)?;
    let mut spec = crate::daemon::launch_spec(|_| None, true, Some(&session.settings.runtime));
    spec.envs = session.child_env.clone();
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(root: &str) -> Result<Settings, String> {
        Settings::parse(|key| match key {
            "GENTLE_DOT_SMOKE_ROOT" => Some(root.into()),
            "GENTLE_DOT_SMOKE_RUNTIME_DIR" => Some(r"C:\synthetic-runtime".into()),
            "GENTLE_DOT_SMOKE_PORT" => Some("14317".into()),
            "GENTLE_DOT_SMOKE_ENGRAM_PORT" => Some("17438".into()),
            _ => None,
        })
    }

    #[test]
    fn explicit_absolute_plain_drive_paths_only() {
        for bad in [
            "",
            "relative",
            r"C:relative",
            r"\rooted",
            r"\\server\share\root",
            r"\\?\C:\root",
            r"C:\",
            r"C:\root\..\other",
            r"C:\root.",
            r"C:\root ",
            r"C:\root:stream",
            r"C:\NUL",
            r"C:\root\CON.txt",
        ] {
            assert!(settings(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            settings(r"C:\synthetic-✓\fresh").unwrap().root,
            PathBuf::from(r"C:\synthetic-✓\fresh")
        );
        assert!(Settings::parse(|_| None).is_err());
    }

    #[test]
    fn distinct_explicit_nonstandard_ports_are_required() {
        for (port, memory) in [
            ("0", "17438"),
            ("65536", "17438"),
            ("4317", "17438"),
            ("14317", "7437"),
            ("14317", "7438"),
            ("14317", "14317"),
            ("", "17438"),
        ] {
            assert!(Settings::parse(|key| Some(
                match key {
                    "GENTLE_DOT_SMOKE_ROOT" => r"C:\fresh",
                    "GENTLE_DOT_SMOKE_RUNTIME_DIR" => r"C:\runtime",
                    "GENTLE_DOT_SMOKE_PORT" => port,
                    "GENTLE_DOT_SMOKE_ENGRAM_PORT" => memory,
                    _ => return None,
                }
                .into()
            ))
            .is_err());
        }
    }

    #[test]
    fn build_guard_and_context_keep_production_separate() {
        assert_eq!(
            ENABLED,
            cfg!(all(feature = "windows-smoke-test", debug_assertions))
        );
        let mut context = tauri::generate_context!();
        let original = context.config().clone();
        if !ENABLED {
            assert!(
                options_from(|_| panic!("production must not read smoke variables"))
                    .unwrap()
                    .is_none()
            );
            configure_context(&mut context, None);
            assert_eq!(context.config(), &original);
        }
        let options = settings(r"C:\synthetic\fresh").unwrap();
        configure_context(&mut context, Some(&options));
        assert_eq!(
            context.config().identifier,
            instance_identifier(&options.root)
        );
        assert_ne!(context.config().identifier, original.identifier);
        assert!(context.config().app.windows.is_empty());
        assert_eq!(
            context.config().app.app_directories_override,
            Some(tauri::utils::config::AppDirectoriesOverride::Root(
                options.root.join("tauri")
            ))
        );
    }

    #[test]
    fn instance_identity_is_root_bound_not_a_global_smoke_instance() {
        let first = instance_identifier(std::path::Path::new(r"C:\canonical\first"));
        assert_ne!(
            first,
            instance_identifier(std::path::Path::new(r"C:\canonical\second"))
        );
        assert_eq!(
            first,
            instance_identifier(std::path::Path::new(r"C:\canonical\first"))
        );
        assert_ne!(
            instance_identifier(std::path::Path::new(r"C:\canonical\Straße")),
            instance_identifier(std::path::Path::new(r"C:\canonical\STRASSE"))
        );
        assert!(first.starts_with(SMOKE_ID));
        assert_ne!(first, "dev.gentleman.gentle-dot");
    }

    #[test]
    fn child_environment_reads_only_the_allowlist_and_generates_private_paths() {
        let options = settings(r"C:\synthetic\fresh").unwrap();
        let env = options
            .child_env(|key| {
                assert_eq!(
                    key, "SystemRoot",
                    "must not read provider or profile variables"
                );
                Some(r"C:\Windows".into())
            })
            .unwrap();
        let value = |key: &str| env.iter().find(|(k, _)| k == key).unwrap().1.clone();
        assert_eq!(value("HOME"), r"C:\synthetic\fresh\profile");
        assert_eq!(value("GENTLE_DOT_DATA_DIR"), r"C:\synthetic\fresh\data");
        assert_eq!(
            value("GENTLE_DOT_AGENT_HOME"),
            r"C:\synthetic\fresh\data\agent"
        );
        assert_eq!(value("GENTLE_DOT_ENGRAM"), "private");
        assert_eq!(value("GENTLE_DOT_ENGRAM_PORT"), "17438");
        assert_eq!(value("GIT_CONFIG_NOSYSTEM"), "1");
        for forbidden in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "OPENAI_API_KEY",
            "ENGRAM_URL",
            "GENTLE_DOT_AGENT_SCRIPT",
            "GENTLE_DOT_SECRETS_KEY",
        ] {
            assert!(!env.iter().any(|(key, _)| key == forbidden));
        }
    }
}
