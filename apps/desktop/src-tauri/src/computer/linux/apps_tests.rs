//! App-inventory and trusted-launch checks (T5a, S7): the pure Niri
//! `Windows` parser (identity, dedup, malformed/no-window handling), the
//! desktop-entry selection rules (exact id, unambiguous name, ambiguous and
//! not-found refusals), the own-entry guard, and one real GIO launch probe.
//!
//! The GIO probe runs the public [`super::apps::launch_installed_app`]
//! against a fixture-only `XDG_DATA_HOME`/`XDG_DATA_DIRS` in an isolated
//! child test process, so the parent's environment is never mutated and no
//! installed desktop app is ever started: the fixture entry runs an inert
//! script that writes a marker under the fixture directory only. If the
//! environment cannot run GIO at all, the probe fails loudly instead of
//! silently skipping.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;

use super::apps::{is_own_entry, parse_running_apps, select_entry_index, AppEntry};
use crate::computer::AppInfo;

/// Set by the parent test for the child probe process.
const CHILD_ENV: &str = "GENTLE_DOT_GIO_FIXTURE_CHILD";
/// The exact full path of the probe test, used as the child's `--exact`
/// filter so only this test runs in the isolated process.
const CHILD_TEST: &str = "computer::linux::apps_tests::gio_fixture_launches_only_the_inert_entry";

fn app(name: &str, active: bool) -> AppInfo {
    AppInfo { name: name.to_owned(), bundle_id: None, active }
}

#[test]
fn windows_request_is_the_reused_niri_wire() {
    assert_eq!(super::apps::WINDOWS_REQUEST, "\"Windows\"");
    assert_eq!(super::apps::WINDOWS_REQUEST, crate::niri::WINDOWS_REQUEST);
}

#[test]
fn windows_reply_derives_apps_by_app_id_and_dedups_windows() {
    let reply = json!({"Windows": [
        {"id": 1, "app_id": "org.gnome.TextEditor", "pid": 42, "is_focused": true, "title": "notes.txt"},
        {"id": 2, "app_id": "org.gnome.TextEditor", "pid": 42, "is_focused": false, "title": "other.txt"},
        {"id": 3, "app_id": "org.mozilla.firefox", "pid": 99, "is_focused": false},
    ]});
    assert_eq!(
        parse_running_apps(&reply).unwrap(),
        vec![app("org.gnome.TextEditor", true), app("org.mozilla.firefox", false)]
    );
}

#[test]
fn an_app_id_is_never_replaced_by_a_window_document_title() {
    let reply = json!({"Windows": [
        {"id": 1, "app_id": "org.gnome.TextEditor", "pid": 42, "title": "Confidential notes"},
    ]});
    let apps = parse_running_apps(&reply).unwrap();
    assert_eq!(apps, vec![app("org.gnome.TextEditor", false)]);
    assert!(!apps.iter().any(|entry| entry.name.contains("Confidential")));
}

#[test]
fn a_window_without_app_id_falls_back_to_a_positive_pid() {
    let reply = json!({"Windows": [
        {"id": 1, "pid": 7, "title": "Some Window", "is_focused": true},
        {"id": 2, "pid": 7, "title": "Another Window"},
    ]});
    // One process is one app identity even without an app_id.
    assert_eq!(parse_running_apps(&reply).unwrap(), vec![app("Some Window", true)]);

    let untitled = json!({"Windows": [{"id": 3, "pid": 8}]});
    assert_eq!(parse_running_apps(&untitled).unwrap(), vec![app("pid 8", false)]);
}

#[test]
fn no_windows_is_a_truthful_empty_inventory_not_an_error() {
    assert_eq!(parse_running_apps(&json!({"Windows": []})).unwrap(), Vec::<AppInfo>::new());
    assert_eq!(parse_running_apps(&json!([])).unwrap(), Vec::<AppInfo>::new());
}

#[test]
fn malformed_window_fields_are_refused_truthfully() {
    for reply in [
        json!({}),
        json!({"Windows": 7}),
        json!({"Windows": [7]}),
        json!({"Windows": [{"app_id": 7, "pid": 1}]}),
        json!({"Windows": [{"app_id": "org.x", "pid": "12"}]}),
        json!({"Windows": [{"app_id": "org.x", "pid": 4_294_967_296i64}]}),
        json!({"Windows": [{"title": "orphan"}]}),
        json!({"Windows": [{"app_id": "   "}]}),
    ] {
        assert!(parse_running_apps(&reply).is_err(), "reply {reply} must be refused");
    }
}

#[test]
fn an_app_id_window_is_listed_even_when_its_pid_is_unusable() {
    // Niri reports a non-positive pid for a window whose `_NET_WM_PID` is
    // absent, and the rest of this backend already treats that as an
    // unusable owner. It is not a malformed reply, and it must not hide a
    // window that names itself perfectly well.
    for pid in [json!(0), json!(-3), json!(null)] {
        let mut window = json!({"id": 1, "app_id": "org.gnome.TextEditor", "is_focused": true});
        if !pid.is_null() {
            window["pid"] = pid.clone();
        }
        let reply = json!({"Windows": [window]});
        assert_eq!(
            parse_running_apps(&reply).unwrap(),
            vec![app("org.gnome.TextEditor", true)],
            "pid {pid} must not refuse an app_id window"
        );
    }
}

#[test]
fn a_window_with_no_identity_at_all_is_still_refused() {
    for reply in [
        json!({"Windows": [{"pid": 0, "title": "orphan"}]}),
        json!({"Windows": [{"pid": -3, "title": "orphan"}]}),
        json!({"Windows": [{"app_id": "   ", "pid": 0, "title": "orphan"}]}),
    ] {
        let error = parse_running_apps(&reply).unwrap_err();
        assert!(error.contains("window 0"), "{error}");
    }
}

fn entries() -> Vec<AppEntry> {
    vec![
        AppEntry { id: "org.gnome.TextEditor.desktop".into(), name: "Text Editor".into() },
        AppEntry { id: "org.mozilla.firefox.desktop".into(), name: "Firefox".into() },
        AppEntry { id: "org.gnome.TextEditor.Plugin.desktop".into(), name: "Text Editor Plugin".into() },
    ]
}

#[test]
fn selection_matches_exact_desktop_ids_with_or_without_the_suffix() {
    let entries = entries();
    assert_eq!(select_entry_index(&entries, "org.gnome.TextEditor.desktop").unwrap(), 0);
    assert_eq!(select_entry_index(&entries, "org.gnome.TextEditor").unwrap(), 0);
    assert_eq!(select_entry_index(&entries, "  org.mozilla.firefox.desktop  ").unwrap(), 1);
}

#[test]
fn selection_matches_an_unambiguous_display_name_case_insensitively() {
    let entries = entries();
    assert_eq!(select_entry_index(&entries, "Firefox").unwrap(), 1);
    assert_eq!(select_entry_index(&entries, "firefox").unwrap(), 1);
    assert_eq!(select_entry_index(&entries, "TEXT EDITOR").unwrap(), 0);
}

#[test]
fn selection_refuses_prefixes_substrings_and_unknown_names() {
    let entries = entries();
    for query in ["Text", "Text Ed", "org.gnome", "fire", "org.gnome.TextEditor.Plug", "Prompt"] {
        let err = select_entry_index(&entries, query).unwrap_err();
        assert!(err.contains("no installed desktop entry"), "{query}: {err}");
    }
    assert!(select_entry_index(&entries, "   ").unwrap_err().contains("non-empty"));
}

#[test]
fn selection_names_every_id_when_a_display_name_is_ambiguous() {
    let entries = vec![
        AppEntry { id: "a.desktop".into(), name: "Editor".into() },
        AppEntry { id: "b.desktop".into(), name: "Editor".into() },
    ];
    let err = select_entry_index(&entries, "Editor").unwrap_err();
    assert!(err.contains("ambiguous"), "{err}");
    assert!(err.contains("a.desktop") && err.contains("b.desktop"), "{err}");
}

#[test]
fn an_adversarial_name_never_selects_an_entry() {
    // The user string only ever reaches an exact comparison, so shell
    // metacharacters, paths, and command substitutions cannot match.
    let entries = entries();
    for query in [
        "Text Editor; touch /tmp/owned",
        "Firefox && id",
        "Text Editor`id`",
        "./org.mozilla.firefox.desktop",
        "$(id)",
    ] {
        assert!(select_entry_index(&entries, query).is_err(), "{query} must not match");
    }
}

#[test]
fn the_own_entry_is_recognized_by_identity_not_by_a_name_substring() {
    let own = Path::new("/opt/gentle-dot/gentle-dot");
    // The stable and legacy desktop ids are our own entry.
    assert!(is_own_entry("gentle-dot.desktop", Path::new("/usr/bin/gentle-dot"), None));
    assert!(is_own_entry("Gentle Dot.desktop", Path::new(""), None));
    // An entry whose executable is the running binary is our own entry even
    // under another id.
    assert!(is_own_entry("launcher.desktop", own, Some(own)));
    // An unrelated entry is not refused just because its name contains a word.
    assert!(!is_own_entry(
        "dot-tools.desktop",
        Path::new("/usr/bin/dot-tools"),
        Some(own)
    ));
    assert!(!is_own_entry(
        "org.gnome.TextEditor.desktop",
        Path::new("/usr/bin/gnome-text-editor"),
        Some(own)
    ));
}

fn shell_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn desktop_exec_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    format!("\"{}\"", raw.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Write the fixture under `dir`: an inert executable that records that it
/// ran, plus the trusted desktop entry that points at it.
fn write_fixture(dir: &Path) {
    let applications = dir.join("data-home/applications");
    fs::create_dir_all(&applications).expect("fixture applications dir");
    fs::create_dir_all(dir.join("data-dirs")).expect("fixture data dirs");
    fs::create_dir_all(dir.join("config-home")).expect("fixture config dir");

    let marker = dir.join("marker.txt");
    let script = dir.join("fixture-exec.sh");
    fs::write(
        &script,
        format!("#!/bin/sh\nprintf 'fixture-ran' > {}\n", shell_single_quote(&marker.to_string_lossy())),
    )
    .expect("fixture script");
    let mut perms = fs::metadata(&script).expect("script metadata").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script, perms).expect("script executable");

    let desktop = applications.join("fixture.desktop");
    fs::write(
        &desktop,
        format!(
            "[Desktop Entry]\nType=Application\nName=Fixture Launcher\nExec={}\nTerminal=false\n",
            desktop_exec_quote(&script)
        ),
    )
    .expect("fixture desktop entry");
    let mut perms = fs::metadata(&desktop).expect("entry metadata").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&desktop, perms).expect("entry trusted");
}

fn fixture_dir() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let dir = root.join("build").join(format!("gio-fixture-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).expect("fixture root under build/");
    dir
}

#[test]
fn gio_fixture_launches_only_the_inert_entry() {
    if std::env::var_os(CHILD_ENV).is_some() {
        run_gio_child_probe();
        return;
    }
    let dir = fixture_dir();
    write_fixture(&dir);
    let exe = std::env::current_exe().expect("the running test binary is the child");
    let output = Command::new(exe)
        .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, &dir)
        .env("XDG_DATA_HOME", dir.join("data-home"))
        .env("XDG_DATA_DIRS", dir.join("data-dirs"))
        .env("XDG_CONFIG_HOME", dir.join("config-home"))
        .output()
        .expect("spawn the isolated GIO child");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let success = output.status.success();
    // The fixture lives under the gitignored build/ tree; remove it in
    // teardown so no scratch survives the test.
    let _ = fs::remove_dir_all(&dir);
    assert!(
        success,
        "isolated GIO probe failed ({:?}):\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("GIO_FIXTURE_OK"),
        "the child must report its proof sentinel:\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

/// Runs only inside the child process: isolated XDG dirs, fixture-only
/// desktop entries, and the public launcher entry point.
fn run_gio_child_probe() {
    let dir = PathBuf::from(std::env::var_os(CHILD_ENV).expect("child fixture dir"));
    let data_home = PathBuf::from(std::env::var("XDG_DATA_HOME").expect("child XDG_DATA_HOME"));
    let data_dirs = PathBuf::from(std::env::var("XDG_DATA_DIRS").expect("child XDG_DATA_DIRS"));
    assert!(data_home.starts_with(&dir), "child must use the fixture XDG_DATA_HOME");
    assert!(data_dirs.starts_with(&dir), "child must use the fixture XDG_DATA_DIRS");

    let marker = dir.join("marker.txt");
    let malicious = dir.join("malicious.txt");
    assert!(!marker.exists(), "the fixture must not have run before the launch");

    // The adversarial string is compared, never executed: a shell would
    // have written the malicious marker, so its absence is the proof.
    let adversarial = format!("Fixture Launcher; touch {}", malicious.display());
    assert!(super::apps::launch_installed_app(&adversarial).is_err(), "adversarial name must not match");
    assert!(!malicious.exists(), "the adversarial name reached a shell");

    // The exact id launches the trusted fixture entry and nothing else.
    super::apps::launch_installed_app("fixture.desktop").expect("the fixture entry launches");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let content = fs::read_to_string(&marker).expect("the inert fixture executable ran");
    assert_eq!(content.trim(), "fixture-ran");
    println!("GIO_FIXTURE_OK");
}
