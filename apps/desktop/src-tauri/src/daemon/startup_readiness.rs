use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct StartupReadiness {
    pub(super) runtime: Runtime,
    pub(super) profile: Profile,
    pub(super) service: Service,
}

#[cfg_attr(not(all(windows, target_arch = "x86_64")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Runtime { Present, Missing, Unknown }

#[cfg_attr(not(all(windows, target_arch = "x86_64")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Profile { NoConflictFound, New, OwnerMismatch, Unsafe, Unknown }

#[cfg_attr(not(all(windows, target_arch = "x86_64")), allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Service { Starting, Ready, Blocked, Failed, #[default] Unknown }

#[cfg(any(test, all(windows, target_arch = "x86_64")))]
#[derive(Default)]
pub(super) struct Attempt {
    active: usize,
    overlapped: bool,
    outcome: Service,
}

#[cfg(any(test, all(windows, target_arch = "x86_64")))]
impl Attempt {
    pub(super) fn begin(&mut self) {
        self.overlapped |= self.active != 0;
        self.active += 1;
    }

    pub(super) fn finish(&mut self, outcome: Service) {
        self.active -= 1;
        if self.active == 0 {
            self.outcome = if self.overlapped { Service::Unknown } else { outcome };
            self.overlapped = false;
        }
    }

    pub(super) fn service(&self) -> Service {
        if self.active != 0 { Service::Starting } else { self.outcome }
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) fn packaged_runtime(runtime: Option<&std::path::Path>) -> Runtime {
    use super::launch::{PACKAGED_RUNTIME_FILES, PACKAGED_RUNTIME_HARNESS, windows_node_directory};
    use std::{fs, io::ErrorKind};
    // External/source overrides are not evidence about the runtime in use.
    if ["GENTLE_DOT_NODE", "GENTLE_DOT_DAEMON_SCRIPT"].iter().any(|key|
        std::env::var_os(key).is_some_and(|value| !value.is_empty())) {
        return Runtime::Unknown;
    }
    let Some(dir) = runtime.filter(|dir| dir.is_absolute()) else { return Runtime::Unknown };
    let required = !cfg!(debug_assertions)
        && option_env!("GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED") == Some("1");
    let mut outcome = Runtime::Present;
    for (relative, directory) in PACKAGED_RUNTIME_FILES.iter().map(|&name| (name, false))
        .chain([(PACKAGED_RUNTIME_HARNESS, true)]) {
        let path = if relative == "node/node.exe" && !required {
            // The launch resolver falls back to the inherited Node layout.
            // An inaccessible preferred path is inconclusive, not absent.
            if fs::metadata(dir.join(relative)).is_err_and(|e| e.kind() != ErrorKind::NotFound) {
                outcome = Runtime::Unknown;
                continue;
            }
            windows_node_directory(dir).join("node.exe")
        } else {
            dir.join(relative)
        };
        match fs::metadata(path) {
            Ok(info) if if directory { info.is_dir() } else { info.is_file() } => {},
            Ok(_) => return Runtime::Missing,
            Err(error) if error.kind() == ErrorKind::NotFound => return Runtime::Missing,
            Err(_) => outcome = Runtime::Unknown,
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_readiness_registration_is_local_panel_only() {
        let capabilities: serde_json::Value = serde_json::from_str(include_str!(
            "../../capabilities/default.json"
        )).unwrap();
        let grants: Vec<_> = capabilities["capabilities"].as_array().unwrap().iter()
            .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == "allow-startup-readiness"))
            .collect();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0]["windows"], serde_json::json!(["panel"]));
        assert!(grants[0].get("remote").is_none());
        assert_ne!(grants[0]["local"], false);
        assert!(include_str!("../../build.rs").contains("\"startup_readiness\","));
        assert!(include_str!("../shell.rs").contains("            startup_readiness,"));
    }

    #[test]
    fn startup_readiness_projection_is_closed() {
        let wire = StartupReadiness {
            runtime: Runtime::Present, profile: Profile::OwnerMismatch, service: Service::Blocked,
        };
        assert_eq!(serde_json::to_value(wire).unwrap(), serde_json::json!({
            "runtime": "present", "profile": "owner-mismatch", "service": "blocked"
        }));
    }

    #[test]
    fn startup_readiness_discards_overlapping_outcomes() {
        let mut state = Attempt::default();
        assert_eq!(state.service(), Service::Unknown);
        state.begin();
        assert_eq!(state.service(), Service::Starting);
        state.begin();
        state.finish(Service::Failed);
        assert_eq!(state.service(), Service::Starting);
        state.finish(Service::Ready);
        assert_eq!(state.service(), Service::Unknown);
        for outcome in [Service::Blocked, Service::Failed, Service::Ready, Service::Unknown] {
            state.begin();
            assert_eq!(state.service(), Service::Starting);
            state.finish(outcome);
            assert_eq!(state.service(), outcome);
        }
    }

    #[cfg(not(all(windows, target_arch = "x86_64")))]
    #[test]
    fn startup_readiness_unsupported_has_no_projection() {
        let daemon = super::super::Daemon::new(0, "inert".into(), None);
        assert!(daemon.startup_readiness().is_none());
    }
}
