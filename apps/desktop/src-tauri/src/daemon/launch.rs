//! Shared launch contracts and runtime selection, also exercised behind the Windows seam.

#[cfg(any(windows, test))]
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
pub use crate::app_channel::windows::ChildEndpoint;

/// `<data>/daemon.pid`: the ownership record of the daemon this app launched last.
pub const PID_FILE: &str = "daemon.pid";

/// Origins of the `tauri dev` server, allowed only on daemons spawned by debug builds.
pub const DEV_ALLOWED_ORIGINS: &str = r#"["http://127.0.0.1:5173","http://localhost:5173"]"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

/// A spawned process the app polls, stops, and reaps: a `std::process::Child`, or on macOS a
/// daemon spawned with its TCC responsibility disclaimed (`disclaimed`).
pub trait ChildProcess: Send {
    fn id(&self) -> u32;
    /// The exit status once the process ended (reaping it), `None` while it runs.
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    /// Sends SIGKILL unless the process was already reaped.
    fn kill(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<ExitStatus>;
    #[cfg(windows)]
    fn launch_failed(&self) -> bool { false }
    /// Authenticated-stop uncertainty is not permission for failed-startup cleanup.
    #[cfg(windows)]
    fn shutdown_requires_channel(&self) -> bool { !self.launch_failed() }
    #[cfg(windows)]
    fn retain_failure(&mut self) {}
    /// Windows requests authenticated stop with the channel open; errors retain ownership.
    #[cfg(windows)]
    fn shutdown_owned(&mut self, _grace: Duration) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "checked Windows child shutdown is unavailable"))
    }
    #[cfg(windows)]
    fn started_owned(&self) -> io::Result<u64> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "retained Windows creation identity is unavailable"))
    }
}

impl ChildProcess for Child {
    fn id(&self) -> u32 {
        Child::id(self)
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Child::try_wait(self)
    }

    fn kill(&mut self) -> io::Result<()> {
        Child::kill(self)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        Child::wait(self)
    }
}

/// Admit a package-required launch before selecting any build-machine fallback. Ordinary
/// checkout builds retain the old contract. A complete explicit Node/script override is
/// an intentional external runtime, not an accidental fallback; one override alone is not.
pub fn validate_packaged_runtime(
    env: impl Fn(&str) -> Option<String>,
    required: bool,
    runtime: Option<&Path>,
) -> Result<(), String> {
    if !required {
        return Ok(());
    }
    let overridden = |key: &str| env(key).is_some_and(|value| !value.is_empty());
    if overridden("GENTLE_DOT_NODE") && overridden("GENTLE_DOT_DAEMON_SCRIPT") {
        return Ok(());
    }
    let fail = |detail: String| format!(
        "The installed Windows runtime is missing or incomplete ({detail}). Reinstall Gentle Dot, \
         or explicitly select a complete runtime with GENTLE_DOT_RUNTIME_DIR. \
         To use an external daemon, set both GENTLE_DOT_NODE and GENTLE_DOT_DAEMON_SCRIPT; \
         this package will not silently use build-machine checkout paths."
    );
    let dir = runtime.ok_or_else(|| fail("runtime resource directory unavailable".into()))?;
    for relative in [
        "node/bin/node.exe", "daemon/cli.mjs", "daemon/package.json",
        "daemon/native/windows-stop.node", "daemon/node_modules/gentle-pi/package.json",
        "bin/engram.exe", "bin/pi.cmd", "ui/index.html",
    ] {
        if !dir.join(relative).is_file() {
            return Err(fail(dir.join(relative).display().to_string()));
        }
    }
    if !dir.join("daemon/node_modules/gentle-pi/.gentle-ai").is_dir() {
        return Err(fail(dir.join("daemon/node_modules/gentle-pi/.gentle-ai").display().to_string()));
    }
    Ok(())
}

#[cfg(windows)]
fn node_runtime_path(dir: &Path) -> PathBuf {
    // Node's entry resolver rejects verbatim drive paths. Only use the ordinary
    // spelling if Windows resolves it to the same canonical directory; special
    // namespace paths and names with different Win32 semantics stay untouched.
    if let Some(rest) = dir.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
            let ordinary = PathBuf::from(rest);
            if let (Ok(original), Ok(candidate)) = (fs::canonicalize(dir), fs::canonicalize(&ordinary)) {
                if original == candidate { return ordinary; }
            }
        }
    }
    dir.to_path_buf()
}

/// `<node> <daemon script>` (S29.5). With a bundled runtime (`<runtime>/daemon/cli.mjs`
/// exists) that is the runtime's own Node and daemon, a PATH of the runtime plus the
/// system folders, and `GENTLE_DOT_RUNTIME`; otherwise the build-time paths and PATH.
/// `GENTLE_DOT_NODE` and `GENTLE_DOT_DAEMON_SCRIPT` override the program and script in both.
pub fn launch_spec(env: impl Fn(&str) -> Option<String>, dev: bool, runtime: Option<&Path>) -> LaunchSpec {
    let pick = |key: &str, fallback: String| env(key).filter(|v| !v.is_empty()).unwrap_or(fallback);
    let bundled = runtime.filter(|dir| dir.join("daemon/cli.mjs").is_file());
    let (node, script, mut envs) = match bundled {
        Some(dir) => {
            #[cfg(windows)]
            let compatible = node_runtime_path(dir);
            #[cfg(windows)]
            let dir = compatible.as_path();
            let root = dir.display().to_string();
            #[cfg(unix)]
            let (node, script, path) = (
                format!("{root}/node/bin/node"),
                format!("{root}/daemon/cli.mjs"),
                format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
            );
            #[cfg(windows)]
            let (node, script, path) = {
                let system = PathBuf::from(env("SystemRoot").filter(|v| !v.is_empty())
                    .unwrap_or_else(|| r"C:\Windows".into()));
                (
                    dir.join("node/bin/node.exe").display().to_string(),
                    dir.join("daemon/cli.mjs").display().to_string(),
                    format!("{};{};{};{}", dir.join("bin").display(), dir.join("node/bin").display(),
                        system.join("System32").display(), system.display()),
                )
            };
            (
                node,
                script,
                vec![("PATH".to_string(), path), ("GENTLE_DOT_RUNTIME".to_string(), root)],
            )
        }
        None => (
            env!("GENTLE_DOT_BUILD_NODE").to_string(),
            env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT").to_string(),
            vec![("PATH".to_string(), env!("GENTLE_DOT_BUILD_PATH").to_string())],
        ),
    };
    if dev {
        envs.push(("GENTLE_DOT_ALLOWED_ORIGINS".into(), DEV_ALLOWED_ORIGINS.into()));
    }
    LaunchSpec {
        program: pick("GENTLE_DOT_NODE", node),
        args: vec![pick("GENTLE_DOT_DAEMON_SCRIPT", script)],
        envs,
    }
}

/// Where a bundled runtime would live: `GENTLE_DOT_RUNTIME_DIR`, else the app's `runtime`
/// resource. `launch_spec` uses it only when it holds `daemon/cli.mjs`.
pub fn runtime_dir(env: impl Fn(&str) -> Option<String>, resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    env("GENTLE_DOT_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| resource_dir.map(|dir| dir.join("runtime")))
}

#[cfg(test)]
mod packaged_runtime_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn build_time_windows_script_resolves_in_node_without_running_daemon() {
        let spec = launch_spec(|_| None, false, None);
        assert_eq!(spec.program, env!("GENTLE_DOT_BUILD_NODE"));
        assert_eq!(spec.args.len(), 1);
        assert_eq!(spec.envs, vec![("PATH".into(), env!("GENTLE_DOT_BUILD_PATH").into())]);
        // Exercise Node's entry-point realpathSync without importing the daemon.
        let output = std::process::Command::new(&spec.program)
            .env_remove("NODE_OPTIONS")
            .args(["-e", "process.stdout.write(require('node:fs').realpathSync(process.argv[1]))"])
            .arg(&spec.args[0]).output().unwrap();
        assert!(output.status.success(), "Node path resolution failed: {}", String::from_utf8_lossy(&output.stderr));
        assert!(output.stderr.is_empty());
        let resolved = String::from_utf8(output.stdout).unwrap();
        assert_eq!(fs::canonicalize(resolved).unwrap(), fs::canonicalize(&spec.args[0]).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn bundled_windows_runtime_uses_native_paths_and_preserves_overrides() {
        let runtime = fixture("launch-spec");
        let spec = launch_spec(|key| (key == "SystemRoot").then(|| r"D:\Windows".into()), false, Some(&runtime));
        assert_eq!(spec.program, runtime.join("node/bin/node.exe").display().to_string());
        assert_eq!(spec.args, vec![runtime.join("daemon/cli.mjs").display().to_string()]);
        assert_eq!(spec.envs, vec![
            ("PATH".into(), format!("{};{};D:\\Windows\\System32;D:\\Windows",
                runtime.join("bin").display(), runtime.join("node/bin").display())),
            ("GENTLE_DOT_RUNTIME".into(), runtime.display().to_string()),
        ]);
        let overridden = launch_spec(|key| match key {
            "SystemRoot" => Some(r"D:\Windows".into()),
            "GENTLE_DOT_NODE" => Some(r"E:\custom\node.exe".into()),
            "GENTLE_DOT_DAEMON_SCRIPT" => Some(r"E:\custom\cli.mjs".into()),
            _ => None,
        }, false, Some(&runtime));
        assert_eq!(overridden.program, r"E:\custom\node.exe");
        assert_eq!(overridden.args, vec![r"E:\custom\cli.mjs"]);
        assert_eq!(overridden.envs, spec.envs);
    }

    #[cfg(windows)]
    #[test]
    fn bundled_windows_paths_work_with_node_without_changing_overrides() {
        let runtime = fixture("installed path");
        let extended = fs::canonicalize(&runtime).unwrap();
        assert!(extended.to_str().unwrap().starts_with(r"\\?\"));
        let spec = launch_spec(|_| None, false, Some(&extended));
        let checked = std::process::Command::new(env!("GENTLE_DOT_BUILD_NODE"))
            .arg("--check").arg(&spec.args[0]).env_remove("NODE_OPTIONS").output().unwrap();
        assert!(checked.status.success(), "Node rejected bundled entry: {}", String::from_utf8_lossy(&checked.stderr));
        assert!(checked.stdout.is_empty());
        assert!(checked.stderr.is_empty());
        // Use the canonical long spelling even when the temp folder was given as an 8.3 path.
        let plain = PathBuf::from(&extended.to_str().unwrap()[r"\\?\".len()..]);
        assert_eq!(spec, launch_spec(|_| None, false, Some(&plain)));
        assert!(!spec.program.starts_with(r"\\?\"));
        assert!(!spec.args[0].starts_with(r"\\?\"));
        for (name, value) in &spec.envs {
            if name == "PATH" || name == "GENTLE_DOT_RUNTIME" { assert!(!value.contains(r"\\?\")); }
        }
        let overridden = launch_spec(|key| match key {
            "GENTLE_DOT_NODE" => Some("explicit-node".into()),
            "GENTLE_DOT_DAEMON_SCRIPT" => Some("explicit-entry".into()),
            _ => None,
        }, false, Some(&extended));
        assert_eq!(overridden.program, "explicit-node");
        assert_eq!(overridden.args, vec!["explicit-entry"]);
        let absent = extended.join("missing");
        assert_eq!(launch_spec(|_| None, false, Some(&absent)), launch_spec(|_| None, false, None));
    }

    fn fixture(name: &str) -> PathBuf {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let runtime = std::env::temp_dir().join(format!("gentle {name} {token}"));
        fs::create_dir_all(runtime.join("daemon")).unwrap();
        fs::write(runtime.join("daemon/cli.mjs"), "export {};\n").unwrap();
        // Synthetic fixture retained; no recursive cleanup of user paths.
        runtime
    }

    #[test]
    fn packaged_runtime_requires_every_artifact_and_the_harness_directory() {
        let runtime = fixture("required-runtime");
        let artifacts = [
            "node/bin/node.exe", "daemon/package.json", "daemon/native/windows-stop.node",
            "daemon/node_modules/gentle-pi/package.json", "bin/engram.exe", "bin/pi.cmd", "ui/index.html",
        ];
        for artifact in artifacts {
            let error = validate_packaged_runtime(env_of(&[]), true, Some(&runtime)).unwrap_err();
            assert!(error.contains(&runtime.join(artifact).display().to_string()));
            let path = runtime.join(artifact);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"").unwrap();
        }
        let harness = runtime.join("daemon/node_modules/gentle-pi/.gentle-ai");
        assert!(validate_packaged_runtime(env_of(&[]), true, Some(&runtime)).unwrap_err()
            .contains(&harness.display().to_string()));
        fs::create_dir(harness).unwrap();
        assert!(validate_packaged_runtime(env_of(&[]), true, Some(&runtime)).is_ok());
    }

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| (*value).to_string())
    }

    #[test]
    fn packaged_runtime_refuses_checkout_fallback_but_preserves_explicit_launches() {
        assert!(validate_packaged_runtime(env_of(&[]), false, None).is_ok());
        let error = validate_packaged_runtime(env_of(&[]), true, None).unwrap_err();
        assert!(error.contains("will not silently use build-machine checkout paths"));
        assert!(validate_packaged_runtime(env_of(&[("GENTLE_DOT_NODE", "custom-node")]), true, None).is_err());
        assert!(validate_packaged_runtime(env_of(&[("GENTLE_DOT_DAEMON_SCRIPT", "custom-cli")]), true, None).is_err());
        assert!(validate_packaged_runtime(env_of(&[
            ("GENTLE_DOT_NODE", "custom-node"), ("GENTLE_DOT_DAEMON_SCRIPT", ""),
        ]), true, None).is_err());
        assert!(validate_packaged_runtime(env_of(&[
            ("GENTLE_DOT_NODE", "custom-node"), ("GENTLE_DOT_DAEMON_SCRIPT", "custom-cli"),
        ]), true, None).is_ok());
        assert!(validate_packaged_runtime(env_of(&[]), true, Some(Path::new(env!("CARGO_MANIFEST_DIR")))).is_err());
    }
}
