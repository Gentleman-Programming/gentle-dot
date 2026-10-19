//! Linux app inventory and trusted launching (T5a, S7): the two truthful
//! capabilities the live Niri report asked for, built only from existing
//! primitives.
//!
//! Inventory: [`query_running_apps`] reuses the existing bounded Niri
//! [`Client`](crate::niri::Client) path with
//! [`crate::niri::WINDOWS_REQUEST`] and parses the `Windows` reply in
//! [`parse_running_apps`]. A running app is an *identity* derived from a
//! managed window's non-empty `app_id` (preferred) or a positive `pid`,
//! deduplicated so several windows of one app are one entry, and marked
//! active when any of its windows is focused. A window title is never
//! presented as an app name while an `app_id` exists. This is a window
//! inventory, not an Accessibility or background-process list, and no
//! window id or geometry is derived from a pid.
//!
//! Launching: [`launch_installed_app`] selects one installed desktop entry
//! by exact desktop id (with or without the `.desktop` suffix) or by an
//! unambiguous display name, then asks GIO's platform launcher to start
//! *that entry's trusted `Exec`*. The user's string is only ever compared
//! to entry ids and names; it never becomes a command, an `Exec` line, a
//! shell, or a URI, and no `Exec` is constructed from it. The launch is
//! acknowledged by the platform launcher only: this module never claims the
//! window appeared, gained focus, or that the app became usable.
//!
//! Tests that must exercise the real GIO launcher run in an isolated child
//! process with fixture-only `XDG_DATA_HOME`/`XDG_DATA_DIRS` under `build/`
//! (see `apps_tests`), so no developer's installed apps are touched and no
//! process-global environment is mutated.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gtk::gio;
use gtk::gio::prelude::AppInfoExt;
use serde_json::Value;

use crate::computer::AppInfo;
use crate::niri::Client;

/// The Niri wire request this inventory queries; reused verbatim from the
/// existing client path, never a second IPC dialect.
pub const WINDOWS_REQUEST: &str = crate::niri::WINDOWS_REQUEST;

/// A running app's identity: the `app_id` when the window reports a usable
/// one, otherwise the owning process. Only used to deduplicate windows, so
/// two windows of one app collapse into one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity {
    App(String),
    Pid(i32),
}

/// The `Windows` array of a decoded Niri reply. Both the object shape
/// (`{"Windows": [...]}`) and a bare array are accepted; anything else is a
/// truthful error, never a guessed window list.
fn windows_of(reply: &Value) -> Result<&Vec<Value>, String> {
    if let Some(array) = reply.as_array() {
        return Ok(array);
    }
    reply
        .get("Windows")
        .and_then(Value::as_array)
        .ok_or_else(|| "niri Windows reply has no Windows array".to_owned())
}

/// Derive the running managed applications from a decoded Niri `Windows`
/// reply.
///
/// Genuine absence (`{"Windows": []}`) is an empty inventory, never an
/// error and never the unsupported refusal this seam used to return. A
/// window whose `app_id` is missing/blank falls back to a title-derived
/// name and its positive `pid`; a window with neither identity is refused,
/// because silently dropping it would understate what is running. A
/// non-positive `pid` counts as absent rather than malformed (Niri reports
/// it when the window has no `_NET_WM_PID`, and `usable_focus` refuses the
/// same value), so it never hides a window that carries an `app_id`.
pub fn parse_running_apps(reply: &Value) -> Result<Vec<AppInfo>, String> {
    let windows = windows_of(reply)?;
    let mut apps: Vec<(Identity, AppInfo)> = Vec::new();
    for (index, window) in windows.iter().enumerate() {
        let app_id = match window.get("app_id") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_str() {
                Some(text) => {
                    let text = text.trim();
                    (!text.is_empty()).then(|| text.to_owned())
                }
                None => {
                    return Err(format!(
                        "niri Windows reply window {index} has a non-string app_id"
                    ))
                }
            },
        };
        let pid = match window.get("pid") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let raw = value.as_i64().ok_or_else(|| {
                    format!("niri Windows reply window {index} has a non-numeric pid")
                })?;
                let pid = i32::try_from(raw).map_err(|_| {
                    format!("niri Windows reply window {index} pid is out of range")
                })?;
                (pid > 0).then_some(pid)
            }
        };
        let focused = window.get("is_focused").and_then(Value::as_bool).unwrap_or(false);
        let (identity, name) = if let Some(app_id) = app_id {
            // The app id is the identity; the window title stays a document
            // title and is never substituted for the app name.
            (Identity::App(app_id.clone()), app_id)
        } else if let Some(pid) = pid {
            let title = window
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty());
            let name = title.map(str::to_owned).unwrap_or_else(|| format!("pid {pid}"));
            (Identity::Pid(pid), name)
        } else {
            return Err(format!(
                "niri Windows reply window {index} has neither an app_id nor a usable pid \
                 (refusing an incomplete running-app inventory)"
            ));
        };
        match apps.iter_mut().find(|(existing, _)| *existing == identity) {
            Some((_, info)) => info.active |= focused,
            None => apps.push((identity, AppInfo { name, bundle_id: None, active: focused })),
        }
    }
    Ok(apps.into_iter().map(|(_, info)| info).collect())
}

/// Ask Niri for its windows over the existing bounded client path and
/// derive the running-app inventory. `timeout` is one total budget for
/// connect+write+read; there is no unbounded poll.
pub fn query_running_apps(socket: &Path, timeout: Duration) -> Result<Vec<AppInfo>, String> {
    let client = Client::new(socket, timeout);
    let reply = client.request(WINDOWS_REQUEST).map_err(|error| {
        format!("niri Windows request failed over {}: {error}", socket.display())
    })?;
    parse_running_apps(&reply).map_err(|detail| format!("niri Windows reply unusable: {detail}"))
}

/// One installed desktop entry as selection sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppEntry {
    /// Desktop file id, for example `org.gnome.TextEditor.desktop`.
    pub id: String,
    /// Display name, for example `Text Editor`.
    pub name: String,
}

/// Gentle Dot's own desktop ids (stable and legacy stems). These are the
/// existing stable app identity, not a name substring.
fn own_desktop_ids() -> [String; 2] {
    [
        format!("{}.desktop", crate::autostart::STABLE_APP_NAME),
        format!("{}.desktop", crate::autostart::LEGACY_APP_NAME),
    ]
}

/// Resolve an absolute path to its real file, or `None` when it is not
/// absolute or cannot be resolved. A bare `Exec` token is not guessed
/// against `PATH`; the desktop-id identity still catches our own entry.
fn canonical(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

/// Whether `id`/`executable` name this running Gentle Dot itself. Uses the
/// existing stable identity (desktop id stems and the running executable),
/// so no substring blocklist is needed and an unrelated entry that merely
/// shares a word is still launchable.
pub fn is_own_entry(id: &str, executable: &Path, own_executable: Option<&Path>) -> bool {
    let id = id.trim();
    if own_desktop_ids().iter().any(|own| id.eq_ignore_ascii_case(own)) {
        return true;
    }
    let Some(own) = own_executable else {
        return false;
    };
    if executable == own {
        return true;
    }
    match (canonical(executable), canonical(own)) {
        (Some(entry), Some(own)) => entry == own,
        _ => false,
    }
}

/// Select exactly one entry: an exact desktop id (with or without the
/// `.desktop` suffix) first, otherwise an unambiguous display name
/// (case-insensitive full string). Prefixes, substrings, and case-different
/// ids never match. An ambiguous name names every overlapping id instead of
/// guessing; an unknown query is a not-found error. The returned index
/// addresses the same enumeration the caller built `entries` from.
pub fn select_entry_index(entries: &[AppEntry], query: &str) -> Result<usize, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("open_app needs a non-empty app name or desktop id".to_owned());
    }
    let mut id_matches: Vec<usize> = Vec::new();
    let mut name_matches: Vec<usize> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let id = entry.id.trim();
        let bare = id.strip_suffix(".desktop").unwrap_or(id);
        if id == query || bare == query {
            id_matches.push(index);
        }
        if entry.name.trim().eq_ignore_ascii_case(query) {
            name_matches.push(index);
        }
    }
    let matches = if id_matches.is_empty() { name_matches } else { id_matches };
    match matches.as_slice() {
        [] => Err(format!(
            "no installed desktop entry matches `{query}` \
             (refusing to guess, and never launching a shell)"
        )),
        [index] => Ok(*index),
        many => {
            let ids: Vec<&str> =
                many.iter().map(|index| entries[*index].id.as_str()).collect();
            Err(format!(
                "`{query}` is ambiguous: it matches {} (use the exact desktop id)",
                ids.join(", ")
            ))
        }
    }
}

/// The GIO entries GIO itself would show and that carry a desktop id. A
/// fallback `GAppInfo` without an id is not an installed desktop entry.
fn launchable_infos() -> Vec<gio::AppInfo> {
    gio::AppInfo::all()
        .into_iter()
        .filter(|info| info.should_show())
        .filter(|info| info.id().is_some_and(|id| !id.trim().is_empty()))
        .collect()
}

fn entry_of(info: &gio::AppInfo) -> AppEntry {
    AppEntry {
        id: info.id().map(|id| id.to_string()).unwrap_or_default(),
        name: info.name().to_string(),
    }
}

/// Launch one installed desktop entry by exact id or unambiguous display
/// name. The selected entry's own trusted `Exec` is handed to GIO's
/// platform launcher; the user's string is never compiled into a command.
/// Refuses this running Gentle Dot's own entry so `open_app` cannot start an
/// uncontrolled duplicate. A successful return only means the platform
/// launcher accepted the request: it does not verify a window appeared,
/// gained focus, or that the app is usable.
pub fn launch_installed_app(name: &str) -> Result<(), String> {
    let query = name.trim();
    if query.is_empty() {
        return Err("open_app needs a non-empty app name or desktop id".to_owned());
    }
    let infos = launchable_infos();
    let entries: Vec<AppEntry> = infos.iter().map(entry_of).collect();
    let index = select_entry_index(&entries, query)?;
    let info = &infos[index];
    if is_own_entry(&entries[index].id, &info.executable(), std::env::current_exe().ok().as_deref()) {
        return Err(format!(
            "open_app refused: `{}` is this running Gentle Dot itself \
             (refusing to launch an uncontrolled duplicate)",
            entries[index].id
        ));
    }
    info.launch(&[], gio::AppLaunchContext::NONE).map_err(|error| {
        format!("GIO could not launch {}: {error}", entries[index].id)
    })
}
