//! Read-only bundled-file facts; no process launch, content reads, or user data.

use std::{fs, io::ErrorKind, path::Path};

pub struct Check {
    pub path: &'static str,
    pub status: &'static str,
}

pub struct Snapshot<'a> {
    pub process_os: &'a str,
    pub compiled_arch: &'a str,
    pub target: Option<&'static str>,
    pub checks: Vec<Check>,
}

/// Mapping mirrors scripts/package/lib.mjs TARGETS, not physical CPU detection.
/// Only the shell supplies these arguments; none are IPC input.
pub fn snapshot<'a>(runtime: Option<&Path>, os: &'a str, arch: &'a str) -> Snapshot<'a> {
    let target = match (os, arch) {
        ("windows", "x86_64") => Some("windows-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        _ => None,
    };
    let mut checks = Vec::new();
    if target.is_some() {
        let windows = os == "windows";
        let mut paths = vec![
            "MANIFEST.json",
            if windows { "node/bin/node.exe" } else { "node/bin/node" },
            "daemon/cli.mjs", "daemon/package.json",
            "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
            "daemon/node_modules/@earendil-works/pi-coding-agent/package.json",
            if windows { "bin/engram.exe" } else { "bin/engram" },
            if windows { "bin/pi.cmd" } else { "bin/pi" },
            "ui/index.html",
        ];
        if windows { paths.push("daemon/native/windows-stop.node"); }
        for path in paths {
            checks.push(Check { path, status: runtime.map_or("unknown", |root| file_fact(root, path)) });
        }
    }
    Snapshot { process_os: os, compiled_arch: arch, target, checks }
}

fn file_fact(root: &Path, relative: &str) -> &'static str {
    let mut path = root.to_path_buf();
    // Check each fixed intermediate directory too; do not follow a bundle symlink.
    let parts: Vec<_> = relative.split('/').collect();
    for index in 0..=parts.len() {
        if index > 0 { path.push(parts[index - 1]); }
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() { return "unknown"; }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 { return "unknown"; }
                }
                if index == parts.len() {
                    return if meta.is_file() { "present" } else { "unknown" };
                }
                if !meta.is_dir() { return "unknown"; }
            }
            Err(error) => return if error.kind() == ErrorKind::NotFound { "missing" } else { "unknown" },
        }
    }
    "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("readiness-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        root // Retain fixtures; cleanup belongs to the orchestrator.
    }

    #[test]
    fn fixed_target_paths_report_missing_then_present_without_reading_contents() {
        for (os, arch, target, node, engram, wrapper) in [
            ("windows", "x86_64", "windows-x64", "node.exe", "engram.exe", "pi.cmd"),
            ("macos", "aarch64", "darwin-arm64", "node", "engram", "pi"),
            ("linux", "aarch64", "linux-arm64", "node", "engram", "pi"),
            ("linux", "x86_64", "linux-x64", "node", "engram", "pi"),
        ] {
            let root = fixture();
            let missing = snapshot(Some(&root), os, arch);
            assert_eq!(missing.target, Some(target));
            assert_eq!((missing.process_os, missing.compiled_arch), (os, arch));
            let paths: Vec<_> = missing.checks.iter().map(|c| c.path).collect();
            let mut expected = vec!["MANIFEST.json".to_string(), format!("node/bin/{node}"),
                "daemon/cli.mjs".into(), "daemon/package.json".into(),
                "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs".into(),
                "daemon/node_modules/@earendil-works/pi-coding-agent/package.json".into(),
                format!("bin/{engram}"), format!("bin/{wrapper}"), "ui/index.html".into()];
            if os == "windows" { expected.push("daemon/native/windows-stop.node".into()); }
            assert_eq!(paths, expected);
            assert!(missing.checks.iter().all(|c| c.status == "missing"));
            for path in paths {
                let file = root.join(path);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, b"not executable or validated metadata").unwrap();
            }
            assert!(snapshot(Some(&root), os, arch).checks.iter().all(|c| c.status == "present"));
        }
    }

    #[test]
    fn unavailable_resources_and_unsupported_targets_are_unknown_not_ready() {
        let report = snapshot(None, "windows", "x86_64");
        assert!(report.checks.iter().all(|c| c.status == "unknown"));
        for (os, arch) in [("windows", "aarch64"), ("macos", "x86_64"), ("other", "x86_64")] {
            let report = snapshot(Some(&fixture()), os, arch);
            assert_eq!(report.target, None);
            assert!(report.checks.is_empty());
        }
    }

    #[test]
    fn nonregular_files_and_blocked_parent_paths_are_unknown() {
        let root = fixture();
        fs::create_dir(root.join("MANIFEST.json")).unwrap();
        fs::write(root.join("daemon"), b"not a directory").unwrap();
        let report = snapshot(Some(&root), "linux", "x86_64");
        assert_eq!(report.checks[0].status, "unknown");
        assert_eq!(report.checks[2].status, "unknown");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_resource_roots_are_not_followed() {
        let root = fixture();
        let link = fixture().join("runtime");
        std::os::unix::fs::symlink(root, &link).unwrap();
        assert!(snapshot(Some(&link), "linux", "x86_64").checks.iter().all(|c| c.status == "unknown"));
    }
}
