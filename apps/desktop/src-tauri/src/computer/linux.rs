//! The Linux desktop backend: capture through the xdg-desktop-portal Screenshot interface, on
//! Hyprland (odd/tasks/linux-screenshot-capture.md S2–S4); pointer and keyboard input through the
//! compositor's `zwlr_virtual_pointer_v1` and `zwp_virtual_keyboard_v1`
//! (odd/tasks/linux-input-control.md S2); and the app identity `mcp`'s gates ask for (which app is in
//! front, which one owns the window under a point, which ones are running), read from Hyprland's
//! `hyprctl` IPC (odd/tasks/linux-input-control.md T6). Permissions mirror the portal's real grant.
//! The pure parts (portal response mapping, Hyprland monitor geometry and client JSON, the pointer
//! and keyboard plans) compile under `test` everywhere, following the Windows backend's
//! `any(windows, test)` convention (mod.rs:30-47).

use super::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};
use super::encode::JPEG_QUALITY;
use super::blocklist::AppIdentity;
use super::linux_input;
use super::risk::{AxElement, Focus};
use super::{AppInfo, Capture, InputEvent, Permissions};
use std::sync::Mutex;

/// How long to wait for the portal's permission dialog, matching the store's prompt timeout
/// (secure_store/linux.rs: the daemon's wait is longer).
const PROMPT_TIMEOUT_SECS: u64 = 120;

/// What the portal answered to a Screenshot request
/// (org.freedesktop.portal.Request Response codes).
#[derive(Debug, PartialEq)]
pub(crate) enum PortalOutcome {
    /// The user approved; the portal returned a file URI for the image.
    Granted(String),
    /// The user refused the dialog (response code 1).
    Denied,
    /// The dialog was dismissed (response code 2).
    Cancelled,
}

/// Map a portal Request `Response (u, v)` to an outcome. Code 0 is granted and must carry
/// a `uri`; anything but 0/1/2 is a protocol error.
pub(crate) fn portal_outcome(response: u32, uri: Option<&str>) -> Result<PortalOutcome, String> {
    match (response, uri) {
        (0, Some(uri)) => Ok(PortalOutcome::Granted(uri.to_string())),
        (0, None) => Err("the Screenshot portal answered 0 without a uri".into()),
        (1, _) => Ok(PortalOutcome::Denied),
        (2, _) => Ok(PortalOutcome::Cancelled),
        (other, _) => Err(format!("unknown Screenshot portal response code {other}")),
    }
}

/// The focused Hyprland monitor, from `hyprctl monitors -j` output: its top-left corner in
/// global points and its width in logical points (the unit `ScreenshotGeometry::for_display`
/// expects; Hyprland reports monitor width/height after scale).
#[derive(Debug, PartialEq)]
pub(crate) struct MonitorGeometry {
    pub origin: Point,
    pub logical_width: f64,
}

/// Pick the focused monitor out of `hyprctl monitors -j` JSON. Errors when the JSON does
/// not parse or no monitor is focused.
pub(crate) fn focused_monitor(monitors_json: &str) -> Result<MonitorGeometry, String> {
    let monitors: serde_json::Value =
        serde_json::from_str(monitors_json).map_err(|error| format!("hyprctl monitors -j: {error}"))?;
    let monitors = monitors.as_array().ok_or("hyprctl monitors -j: expected an array")?;
    monitors
        .iter()
        .find(|monitor| monitor["focused"].as_bool() == Some(true))
        .map(|monitor| -> Result<MonitorGeometry, String> {
            let point = |name: &str| {
                monitor[name].as_f64().ok_or(format!("hyprctl monitor: missing {name}"))
            };
            Ok(MonitorGeometry {
                origin: Point { x: point("x")?, y: point("y")? },
                logical_width: point("width")?,
            })
        })
        .unwrap_or_else(|| Err("no focused Hyprland monitor".into()))
        .and_then(|geometry| {
            if geometry.logical_width > 0.0 {
                Ok(geometry)
            } else {
                Err("focused Hyprland monitor has a non-positive width".into())
            }
        })
}

/// Turn the portal's `file://` URI into a local path, percent-decoded. Only `file://` with an
/// empty authority (what xdg-desktop-portal-hyprland returns) is accepted.
pub(crate) fn uri_to_path(uri: &str) -> Result<std::path::PathBuf, String> {
    let rest = uri
        .strip_prefix("file://")
        .ok_or_else(|| format!("the portal URI is not file://: {uri}"))?;
    if !rest.starts_with('/') {
        return Err(format!("the portal file URI has a non-local authority: {uri}"));
    }
    let bytes = percent_decode(rest)?;
    String::from_utf8(bytes)
        .map(std::path::PathBuf::from)
        .map_err(|_| "the portal file URI is not valid UTF-8".into())
}

/// Percent-decode a URI path: `%XX` becomes the byte, everything else stays literal.
/// A truncated or non-hex escape is an error rather than a silent mangling.
fn percent_decode(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3).ok_or("truncated % escape in the portal URI")?;
        let hi = (hex[0] as char).to_digit(16).ok_or("invalid % escape in the portal URI")?;
        let lo = (hex[1] as char).to_digit(16).ok_or("invalid % escape in the portal URI")?;
        decoded.push((hi * 16 + lo) as u8);
        index += 3;
    }
    Ok(decoded)
}

/// The Linux desktop backend: captures the focused monitor through the portal, and posts pointer
/// and keyboard events through the virtual pointer and virtual keyboard (S2).
pub(crate) struct LinuxDesktop {
    /// The portal's last Screenshot answer: `None` = not asked yet.
    grant: Mutex<Option<bool>>,
    /// Whether this session can create virtual input devices, asked once (S4): the probe connects
    /// to the compositor, and `permissions()` runs on every tool call.
    can_input: std::sync::OnceLock<bool>,
}

impl LinuxDesktop {
    pub(crate) fn new() -> Self {
        Self { grant: Mutex::new(None), can_input: std::sync::OnceLock::new() }
    }

    /// A backend whose input capability is already known, for the tests that cannot ask a
    /// compositor (the probe itself is `linux_input`'s, tested there with an injected display).
    #[cfg(test)]
    fn with_can_input(can_input: bool) -> Self {
        let desktop = Self::new();
        let _ = desktop.can_input.set(can_input);
        desktop
    }

    /// Whether acting on the screen can work at all, from `linux_input`'s probe (S4).
    fn accessibility(&self) -> bool {
        *self.can_input.get_or_init(linux_input::probe_virtual_input)
    }

    /// Screenshot of the focused monitor: ask the portal, then decode, downscale to
    /// `MAX_LONG_EDGE`, and encode as the JPEG the model gets, with the geometry that maps
    /// its pixels back to global points (S2).
    pub(crate) fn capture(&self) -> Result<Capture, String> {
        let monitor = focused_monitor(&hyprctl_monitors()?)?;
        let outcome = self.portal_screenshot()?;
        *self.grant.lock().expect("portal grant state") = Some(matches!(outcome, PortalOutcome::Granted(_)));
        let uri = match outcome {
            PortalOutcome::Granted(uri) => uri,
            PortalOutcome::Denied => return Err("the portal permission dialog was refused".into()),
            PortalOutcome::Cancelled => return Err("the portal screenshot was cancelled".into()),
        };
        let path = uri_to_path(&uri)?;
        let bytes = std::fs::read(&path).map_err(|error| format!("cannot read the portal screenshot {path:?}: {error}"))?;
        let image = image::load_from_memory(&bytes).map_err(|error| format!("cannot decode the portal screenshot: {error}"))?;
        let (width, height) = fit_long_edge(image.width(), image.height(), MAX_LONG_EDGE);
        let resized = image.resize_exact(width, height, image::imageops::FilterType::Triangle).to_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode(resized.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .map_err(|error| format!("cannot encode the screenshot: {error}"))?;
        Ok(Capture {
            data: jpeg,
            mime_type: "image/jpeg",
            geometry: ScreenshotGeometry::for_display(monitor.origin, monitor.logical_width, width, height),
        })
    }

    /// Ask org.freedesktop.portal.Screenshot for a monitor screenshot and wait for the
    /// Request's Response signal, synchronously (the trait is blocking `&self`). Connects per
    /// call, like the store does.
    fn portal_screenshot(&self) -> Result<PortalOutcome, String> {
        use dbus::arg::{PropMap, RefArg, Variant};
        use dbus::blocking::Connection;
        use std::collections::HashMap;
        use std::time::{Duration, Instant};

        let connection = Connection::new_session()
            .map_err(|error| format!("cannot reach the D-Bus session bus: {error}"))?;
        let portal = connection.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            Duration::from_secs(PROMPT_TIMEOUT_SECS),
        );
        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new("gentle_dot".to_string())));
        options.insert("interactive".into(), Variant(Box::new(false)));
        let (request,): (dbus::Path<'static>,) = portal
            .method_call("org.freedesktop.portal.Screenshot", "Screenshot", ("", options))
            .map_err(|error| format!("the Screenshot portal refused the request: {error}"))?;

        let (sender, receiver) = std::sync::mpsc::channel::<(u32, HashMap<String, Variant<Box<dyn RefArg>>>)>();
        let rule = dbus::message::MatchRule::new()
            .with_interface("org.freedesktop.portal.Request")
            .with_member("Response")
            .with_path(request.clone());
        connection
            .add_match(rule, move |(response, results): (u32, PropMap), _connection: &Connection, _message: &dbus::Message| {
                sender.send((response, results)).is_ok()
            })
            .map_err(|error| format!("cannot listen for the portal's answer: {error}"))?;

        let deadline = Instant::now() + Duration::from_secs(PROMPT_TIMEOUT_SECS);
        loop {
            if Instant::now() >= deadline {
                return Err(format!("the Screenshot portal did not answer within {PROMPT_TIMEOUT_SECS}s"));
            }
            if !connection
                .process(Duration::from_millis(250))
                .map_err(|error| format!("the D-Bus session bus failed: {error}"))?
            {
                continue;
            }
            if let Ok((response, results)) = receiver.try_recv() {
                let uri = results.get("uri").and_then(|variant| variant.as_str().map(str::to_string));
                return portal_outcome(response, uri.as_deref());
            }
        }
    }
}

/// One `hyprctl` answer: the command it was, its exit code and what it printed. The dispatch
/// answers use it to tell Hyprland's Lua-syntax refusal apart from a real failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandAnswer {
    /// The whole command, for the error the caller sees (`hyprctl dispatch focuswindow address:…`).
    pub(crate) command: String,
    pub(crate) status: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl CommandAnswer {
    /// Whether the command worked: exit 0 and no error on stdout, the way `hyprctl` reports an
    /// unknown request or dispatcher while still exiting 0.
    pub(crate) fn succeeded(&self) -> bool {
        self.status == 0 && !invalid_request(&self.stdout)
    }

    /// Whether Hyprland refused the classic `dispatch <dispatcher> <arg>` syntax because its
    /// dispatcher is Lua. 0.56 with a Lua config (Omarchy 4) wraps the classic request in
    /// `return hl.dispatch(...)`, cannot parse it, and exits 7 with that parse error:
    /// `error: [string "return hl.dispatch(focuswindow address:0x…"]:1: ')' expected near 'address'`
    /// (upstream hyprwm/Hyprland#16224). A live 0.56.2 session prints it on stdout with an empty
    /// stderr; other builds put it on stderr, so both are searched.
    pub(crate) fn refused_classic_syntax(&self) -> bool {
        self.status != 0
            && (self.stdout.contains("return hl.dispatch(") || self.stderr.contains("return hl.dispatch("))
    }

    /// The error the caller sees: the command, then what hyprctl printed (stderr, or the error
    /// stdout when it reported one there).
    pub(crate) fn failure(&self) -> String {
        let text = if self.stderr.trim().is_empty() { self.stdout.as_str() } else { self.stderr.as_str() };
        format!("{} failed: {}", self.command, text.trim())
    }
}

/// The one error `hyprctl` prints on stdout while still exiting 0.
fn invalid_request(stdout: &str) -> bool {
    stdout.starts_with("Invalid dispatcher") || stdout.starts_with("unknown request")
}

/// Run one `hyprctl <args>` and keep its answer whole: the exit code says what the dispatcher shim
/// refused, and the streams say why.
fn run_hyprctl(args: &[&str]) -> Result<CommandAnswer, String> {
    let command = format!("hyprctl {}", args.join(" "));
    let output = std::process::Command::new("hyprctl")
        .args(args)
        .output()
        .map_err(|error| format!("cannot run hyprctl: {error}"))?;
    Ok(CommandAnswer {
        command,
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// `hyprctl <args>` output, from the environment the app already runs in: the one place this
/// backend asks the compositor what is on screen (the dispatching half goes through
/// `hyprctl_dispatch`, which speaks both of Hyprland's dispatch syntaxes).
fn hyprctl(args: &[&str]) -> Result<String, String> {
    let answer = run_hyprctl(args)?;
    if !answer.succeeded() {
        return Err(answer.failure());
    }
    Ok(answer.stdout.clone())
}

/// The outcome of one dispatch for `open_app`/`activate`: the classic form's answer, plus the Lua
/// form's answer when the classic syntax was refused (`None` when the first answer decided it).
/// A real failure is never retried, so a window that went away or a command that cannot run is
/// reported as itself instead of hidden behind a second attempt.
pub(crate) fn dispatch_outcome(classic: CommandAnswer, lua: Option<CommandAnswer>) -> Result<(), String> {
    if classic.succeeded() {
        return Ok(());
    }
    match lua {
        Some(lua) if lua.succeeded() => Ok(()),
        Some(lua) => Err(lua.failure()),
        None => Err(classic.failure()),
    }
}

/// Run the plan's dispatch: the classic form first, and, when Hyprland 0.56 with a Lua config refuses
/// that syntax, the Lua form (`dispatch_outcome` decides from the two answers).
fn hyprctl_dispatch(plan: &OpenPlan) -> Result<(), String> {
    let classic = run_hyprctl(&["dispatch", plan.classic_dispatch().as_str()])?;
    let lua = if classic.refused_classic_syntax() {
        Some(run_hyprctl(&["dispatch", plan.lua_dispatch().as_str()])?)
    } else {
        None
    };
    dispatch_outcome(classic, lua)
}

/// `hyprctl monitors -j` output, from the environment the app already runs in.
fn hyprctl_monitors() -> Result<String, String> {
    hyprctl(&["monitors", "-j"])
}

/// One Hyprland client, as `hyprctl clients -j` lists it (`hyprctl activewindow -j` answers the
/// same shape for the focused one): the fields the app-identity layer needs
/// (odd/tasks/linux-input-control.md T6).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HyprClient {
    /// `0x55e4…`: the handle the focus dispatcher takes (`focuswindow address:0x…` in the classic
    /// syntax, `hl.dsp.focus({ window = 'address:0x…' })` in the Lua one).
    pub(crate) address: String,
    /// The app id the window sets now (`class`); apps rewrite it as their state changes.
    pub(crate) class: String,
    /// The app id the window started with (`initialClass`): the stable identity of the app.
    pub(crate) initial_class: String,
    pub(crate) title: String,
    pub(crate) pid: i32,
    /// The window's box, in global logical points.
    pub(crate) rect: Rect,
    pub(crate) workspace_id: i64,
    pub(crate) monitor_id: i64,
    /// Whether the compositor maps it at all.
    pub(crate) mapped: bool,
    /// Hyprland hides a window behind a fullscreen one, or on a hidden special workspace.
    pub(crate) hidden: bool,
    pub(crate) floating: bool,
    /// A pinned window shows on every workspace of its monitor.
    pub(crate) pinned: bool,
    /// 0 is the window focused now, higher is longer ago: Hyprland's only stacking signal.
    pub(crate) focus_history_id: i64,
}

/// A window's box, in global logical points: the same space `InputEvent` points and
/// `hyprctl monitors` use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl Rect {
    /// Whether `at` is inside, half-open so windows that touch a shared edge never both own the
    /// points on it.
    pub(crate) fn contains(&self, at: Point) -> bool {
        at.x >= self.x && at.x < self.x + self.width && at.y >= self.y && at.y < self.y + self.height
    }
}

/// The clients `hyprctl clients -j` lists.
pub(crate) fn parse_clients(json: &str) -> Result<Vec<HyprClient>, String> {
    let clients: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("hyprctl clients -j: {error}"))?;
    let clients = clients.as_array().ok_or("hyprctl clients -j: expected an array")?;
    clients.iter().map(parse_client).collect()
}

/// One client out of the JSON `hyprctl clients -j` and `hyprctl activewindow -j` answer with.
fn parse_client(client: &serde_json::Value) -> Result<HyprClient, String> {
    let text = |name: &str| -> Result<String, String> {
        client[name].as_str().map(str::to_string).ok_or_else(|| format!("hyprctl client: missing {name}"))
    };
    // `[x, y]` and `[width, height]`, in global logical points.
    let pair = |name: &str| -> Result<(f64, f64), String> {
        let missing = || format!("hyprctl client: missing {name}");
        let array = client[name].as_array().ok_or_else(missing)?;
        match array.as_slice() {
            [first, second] => Ok((
                first.as_f64().ok_or_else(|| format!("hyprctl client: {name} holds a non-number"))?,
                second.as_f64().ok_or_else(|| format!("hyprctl client: {name} holds a non-number"))?,
            )),
            _ => Err(missing()),
        }
    };
    let number = |name: &str| -> Result<f64, String> {
        client[name].as_f64().ok_or_else(|| format!("hyprctl client: missing {name}"))
    };
    let (x, y) = pair("at")?;
    let (width, height) = pair("size")?;
    Ok(HyprClient {
        address: text("address")?.trim().to_string(),
        class: text("class")?,
        initial_class: text("initialClass")?,
        title: text("title").unwrap_or_default(),
        pid: number("pid")? as i32,
        rect: Rect { x, y, width, height },
        workspace_id: client["workspace"]["id"].as_i64().ok_or("hyprctl client: missing workspace.id")?,
        monitor_id: client["monitor"].as_i64().ok_or("hyprctl client: missing monitor")?,
        // A client Hyprland states nothing about is a plain mapped window...
        mapped: client["mapped"].as_bool().unwrap_or(true),
        hidden: client["hidden"].as_bool().unwrap_or(false),
        floating: client["floating"].as_bool().unwrap_or(false),
        pinned: client["pinned"].as_bool().unwrap_or(false),
        // ...and one whose focus history it did not state never wins the topmost tie-break.
        focus_history_id: client["focusHistoryID"].as_i64().unwrap_or(i64::MAX),
    })
}

/// The focused client, from `hyprctl activewindow -j`; `None` when nothing is focused.
pub(crate) fn parse_active_window(json: &str) -> Result<Option<HyprClient>, String> {
    let active: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("hyprctl activewindow -j: {error}"))?;
    // Hyprland answers `{}` when the shown workspace has no window (older builds `null`).
    match &active {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Object(fields) if fields.is_empty() => Ok(None),
        _ => parse_client(&active).map(Some),
    }
}

/// The workspace each monitor shows, from `hyprctl monitors -j`: `(monitor id, workspace id)`.
pub(crate) fn active_workspaces(monitors_json: &str) -> Result<Vec<(i64, i64)>, String> {
    let monitors: serde_json::Value =
        serde_json::from_str(monitors_json).map_err(|error| format!("hyprctl monitors -j: {error}"))?;
    let monitors = monitors.as_array().ok_or("hyprctl monitors -j: expected an array")?;
    monitors
        .iter()
        .map(|monitor| {
            let id = monitor["id"].as_i64().ok_or("hyprctl monitor: missing id")?;
            let workspace = monitor["activeWorkspace"]["id"]
                .as_i64()
                .ok_or("hyprctl monitor: missing activeWorkspace")?;
            Ok((id, workspace))
        })
        .collect()
}

/// The clients the pointer can land on: mapped, not hidden, and on the workspace their monitor
/// shows (every other workspace of that monitor draws nothing there). A pinned window shows on
/// every workspace of its monitor.
pub(crate) fn on_screen<'a>(clients: &'a [HyprClient], active: &[(i64, i64)]) -> Vec<&'a HyprClient> {
    clients
        .iter()
        .filter(|client| {
            client.mapped
                && !client.hidden
                && (client.pinned
                    || active
                        .iter()
                        .any(|(monitor, workspace)| *monitor == client.monitor_id && *workspace == client.workspace_id))
        })
        .collect()
}

/// How high a client stacks: Hyprland draws floating windows above tiled ones, and among them the
/// most recently focused one is on top (focusing raises a window, and `focusHistoryID` 0 is the
/// focused one). Hyprland exposes no z-order list, so this is the closest true order it gives.
fn stacking(client: &HyprClient) -> (u8, i64) {
    (if client.floating { 0 } else { 1 }, client.focus_history_id)
}

/// The topmost window under `at` among `clients`.
pub(crate) fn window_owner<'a>(
    clients: impl IntoIterator<Item = &'a HyprClient>,
    at: Point,
) -> Option<&'a HyprClient> {
    clients.into_iter().filter(|client| client.rect.contains(at)).min_by_key(|client| stacking(client))
}

/// The app a client belongs to. Hyprland has no human-readable app name: `class` is what the app
/// calls itself — the id a user sees in `hyprctl clients` and the one a name check matches — so it
/// is the name, and `initialClass`, the id the window started with, is the bundle id, so an app
/// that rewrites its class later keeps one identity. The blocklist compares both the same way it
/// compares a macOS bundle id and a Windows executable name.
pub(crate) fn identity(client: &HyprClient) -> AppIdentity {
    let stated = |ids: [&String; 2]| ids.into_iter().find(|id| !id.trim().is_empty()).cloned();
    let bundle = stated([&client.initial_class, &client.class]);
    let name = stated([&client.class, &client.initial_class]);
    AppIdentity { pid: client.pid, bundle_id: bundle, name: name.unwrap_or_else(|| format!("process {}", client.pid)) }
}

/// One row per app (Hyprland lists windows, not apps), in the order the windows are listed, and
/// whether the app owns the focused window.
pub(crate) fn app_list(clients: &[HyprClient], active: Option<&HyprClient>) -> Vec<AppInfo> {
    let focused = active.map(identity);
    let mut apps: Vec<AppInfo> = Vec::new();
    for client in clients {
        let app = identity(client);
        let is_active = focused.as_ref().is_some_and(|front| front.pid == app.pid && front.bundle_id == app.bundle_id);
        match apps.iter_mut().find(|listed| listed.name == app.name && listed.bundle_id == app.bundle_id) {
            Some(listed) => listed.active |= is_active,
            None => apps.push(AppInfo { name: app.name, bundle_id: app.bundle_id, active: is_active }),
        }
    }
    apps
}

/// The app owning the topmost window under `at`, from the two hyprctl answers (the pure half of
/// `window_owner_at`, which `mcp::pointer_target` asks).
pub(crate) fn owner_at(clients_json: &str, monitors_json: &str, at: Point) -> Result<Option<AppIdentity>, String> {
    let clients = parse_clients(clients_json)?;
    let active = active_workspaces(monitors_json)?;
    Ok(window_owner(on_screen(&clients, &active), at).map(identity))
}

/// The app in front, from `hyprctl activewindow -j` output (the pure half of `frontmost_app`, which
/// `mcp::keyboard_target` asks).
pub(crate) fn frontmost(active_json: &str) -> Result<Option<AppIdentity>, String> {
    Ok(parse_active_window(active_json)?.map(|client| identity(&client)))
}

/// What `open_app` does on Hyprland.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenPlan {
    /// Focus the window this selector names (`address:0x…`): the app is already running.
    Focus { selector: String },
    /// Run it: no window of that app is running.
    Run { command: String },
}

impl OpenPlan {
    /// The classic `hyprctl dispatch <dispatcher> <arg>` form (`focuswindow address:0x…`, `exec …`).
    /// Hyprland before 0.56, and 0.56+ with a hyprlang config, take it as is.
    pub(crate) fn classic_dispatch(&self) -> String {
        match self {
            OpenPlan::Focus { selector } => format!("focuswindow {selector}"),
            OpenPlan::Run { command } => format!("exec {command}"),
        }
    }

    /// The Lua form Hyprland 0.56 needs when the config is Lua: `hl.dsp.focus({ window = 'address:…' })`
    /// and `hl.dsp.exec_raw("command")`. `hl.dsp.exec` does not exist there; `exec_raw` runs the
    /// command string itself, which is the same thing the classic `exec` did (live-verified).
    pub(crate) fn lua_dispatch(&self) -> String {
        match self {
            OpenPlan::Focus { selector } => format!("hl.dsp.focus({{ window = '{selector}' }})"),
            OpenPlan::Run { command } => format!("hl.dsp.exec_raw(\"{command}\")"),
        }
    }
}

/// `open_app`'s plan for `name`.
///
/// Hyprland has no app registry and no launcher of its own, so a name means what it can mean here:
/// if a window of that app is running, it is brought to the front — what `open -a` does for an app
/// that is already open on macOS; otherwise the name is run as a command, the way a launcher would
/// start it. `exec` runs through the shell (the classic `dispatch exec` and the Lua
/// `hl.dsp.exec_raw` alike), so a name carrying shell syntax is refused instead of run.
pub(crate) fn open_plan(name: &str, clients: &[HyprClient]) -> Result<OpenPlan, String> {
    let wanted = name.trim();
    if wanted.is_empty() {
        return Err("cannot open an app without a name".into());
    }
    // The class is the app id; a `.desktop` file's name names the same app.
    let wanted = wanted.strip_suffix(".desktop").unwrap_or(wanted);
    let running = clients
        .iter()
        .filter(|client| {
            client.class.eq_ignore_ascii_case(wanted) || client.initial_class.eq_ignore_ascii_case(wanted)
        })
        .min_by_key(|client| client.focus_history_id);
    if let Some(client) = running {
        return address_of(client).map(|address| OpenPlan::Focus { selector: format!("address:{address}") });
    }
    runnable(wanted)?;
    Ok(OpenPlan::Run { command: wanted.to_string() })
}

/// The window of `pid` to bring back to the front: the one it left focused most recently.
pub(crate) fn focus_plan(clients: &[HyprClient], pid: i32) -> Option<OpenPlan> {
    let client = clients.iter().filter(|client| client.pid == pid).min_by_key(|client| client.focus_history_id)?;
    let address = address_of(client).ok()?;
    Some(OpenPlan::Focus { selector: format!("address:{address}") })
}

/// The `0x…` handle Hyprland gave the window. Anything this layer did not read as one is refused
/// rather than handed to `dispatch focuswindow`.
fn address_of(client: &HyprClient) -> Result<String, String> {
    let address = client.address.trim();
    let hex = address
        .strip_prefix("0x")
        .ok_or_else(|| format!("hyprctl client address is not 0x-prefixed: {address}"))?;
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("hyprctl client address is not hexadecimal: {address}"));
    }
    Ok(address.to_string())
}

/// Whether a name can be handed to Hyprland's `exec` dispatcher (classic `dispatch exec`, Lua
/// `hl.dsp.exec_raw`), which runs it through the shell: no shell syntax, no control characters,
/// and no leading `-` (an option, not an app).
fn runnable(name: &str) -> Result<(), String> {
    const SHELL_SYNTAX: &[char] =
        &[';', '|', '&', '$', '`', '>', '<', '(', ')', '{', '}', '[', ']', '"', '\'', '\\', '*', '?', '#', '!', '~', '^'];
    if name.starts_with('-') {
        return Err(format!("cannot open `{name}`: an app's name does not start with `-`"));
    }
    if name.chars().any(|c| SHELL_SYNTAX.contains(&c) || c.is_control()) {
        return Err(format!(
            "cannot open `{name}`: it carries shell syntax, and Hyprland would run it through the shell"
        ));
    }
    Ok(())
}

/// The permission set the Linux backend reports (S3, S4). `grant` is the portal's last Screenshot
/// answer: `None` = not asked yet (Hyprland's portal has no pre-grant state to query; it prompts
/// per request), `Some(true)` = the dialog was approved, `Some(false)` = refused or cancelled.
///
/// `accessibility` is whether this session can create virtual input devices
/// (`linux_input::virtual_input_supported`): true on a Wayland session whose compositor has the
/// virtual pointer manager, false without a Wayland display or on GNOME and KDE, which need the
/// RemoteDesktop portal (S3). Linux has no system permission to grant for it, so the app never
/// asks for one; reporting it makes acting tools reachable through the same session model as
/// macOS and Windows (S4) instead of refusing every action as if the permission were missing.
/// No gate is loosened by it: the session grant, the working rings, the blocklist, the risk check
/// and Stop stay in the shared layer in front of `post`.
pub(crate) fn permissions_with(grant: Option<bool>, accessibility: bool) -> Permissions {
    let granted = grant.unwrap_or(true); // not asked yet: the portal prompts per request
    Permissions {
        accessibility,
        screen_recording: granted,
        screenshots_supported: granted,
        screenshots_unsupported: None,
    }
}

impl super::Desktop for LinuxDesktop {
    fn permissions(&self) -> Permissions {
        permissions_with(*self.grant.lock().expect("portal grant state"), self.accessibility())
    }

    fn capture(&self) -> Result<Capture, String> {
        Self::capture(self)
    }

    fn post(&self, event: &InputEvent) -> Result<(), String> {
        match event {
            // Pointer input: the plan mirrors Windows' steps, in the Wayland protocol's units.
            // The virtual screen comes from every monitor, not just the captured one, and the
            // session's kept device sends it (linux_input::InputCache).
            InputEvent::Move(_) | InputEvent::Click { .. } | InputEvent::Drag { .. } | InputEvent::Scroll { .. } => {
                let screen = linux_input::virtual_screen(&hyprctl_monitors()?)?;
                linux_input::execute(&linux_input::pointer_plan(event, &screen)?, &screen)
            }
            // Keys and text: the session's one virtual keyboard, its keymap uploaded once before
            // its first key (the device is kept alive across posts, InputCache). The plan refuses
            // what the built-in keymap cannot press before the compositor is touched.
            InputEvent::Key(_) | InputEvent::Text(_) => {
                linux_input::execute_keyboard(&linux_input::keyboard_plan(event)?)
            }
        }
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        let clients = parse_clients(&hyprctl(&["clients", "-j"])?)?;
        let active = parse_active_window(&hyprctl(&["activewindow", "-j"])?)?;
        Ok(app_list(&clients, active.as_ref()))
    }

    /// Focuses a window of the app; runs the name when no window of it is open. See `open_plan`.
    /// The dispatch speaks both of Hyprland's syntaxes (`hyprctl_dispatch`): the classic one, and
    /// the Lua one 0.56 with a Lua config needs (`hl.dsp.focus` / `hl.dsp.exec_raw`).
    fn open_app(&self, name: &str) -> Result<(), String> {
        let clients = parse_clients(&hyprctl(&["clients", "-j"])?)?;
        let plan = open_plan(name, &clients)?;
        hyprctl_dispatch(&plan)
    }

    fn element_at(&self, _at: Point) -> Vec<AxElement> {
        Vec::new()
    }

    /// Hyprland exposes no Accessibility tree, so which element has the focus (and whether a
    /// Return would press a default button) is not knowable: `mcp`'s risk check then weighs only
    /// the declared intent, as the trait allows.
    fn focused_element(&self) -> Option<Focus> {
        None
    }

    /// The focused window's app, from `hyprctl activewindow -j`.
    fn frontmost_app(&self) -> Option<AppIdentity> {
        frontmost(&hyprctl(&["activewindow", "-j"]).ok()?).ok()?
    }

    /// Hyprland has no separate focused app: the keyboard goes to the active window, the same app
    /// `frontmost_app` answers with, and `mcp` drops a focused app equal to the front one anyway.
    /// Answering `None` says exactly that, and refuses nothing that would otherwise be allowed.
    fn focused_app(&self) -> Option<AppIdentity> {
        None
    }

    /// The owner of the topmost window under `at`, in the global logical points `InputEvent` uses.
    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> {
        let clients = hyprctl(&["clients", "-j"]).ok()?;
        let monitors = hyprctl(&["monitors", "-j"]).ok()?;
        owner_at(&clients, &monitors, at).ok()?
    }

    /// Brings the app's most recently focused window back to the front (a dialog took the focus).
    /// Best effort, like the other platforms: the trait gives it nothing to report with, and the
    /// focus dispatch speaks both of Hyprland's syntaxes (`hyprctl_dispatch`).
    fn activate(&self, pid: i32) {
        let Ok(clients) = hyprctl(&["clients", "-j"]).and_then(|json| parse_clients(&json)) else {
            return;
        };
        let Some(plan) = focus_plan(&clients, pid) else {
            return;
        };
        let _ = hyprctl_dispatch(&plan);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_response_zero_with_uri_is_granted() {
        assert_eq!(
            portal_outcome(0, Some("file:///tmp/shot.png")),
            Ok(PortalOutcome::Granted("file:///tmp/shot.png".into()))
        );
    }

    #[test]
    fn portal_response_zero_without_uri_is_a_protocol_error() {
        assert!(portal_outcome(0, None).is_err());
    }

    #[test]
    fn portal_response_one_is_denied_and_two_cancelled() {
        assert_eq!(portal_outcome(1, None), Ok(PortalOutcome::Denied));
        assert_eq!(portal_outcome(2, None), Ok(PortalOutcome::Cancelled));
    }

    #[test]
    fn portal_response_unknown_code_is_a_protocol_error() {
        assert!(portal_outcome(3, Some("file:///x.png")).is_err());
    }

    #[test]
    fn uri_to_path_decodes_plain_and_percent_encoded_paths() {
        assert_eq!(uri_to_path("file:///tmp/shot.png"), Ok(std::path::PathBuf::from("/tmp/shot.png")));
        assert_eq!(
            uri_to_path("file:///tmp/My%20Pics/shot%2Epng"),
            Ok(std::path::PathBuf::from("/tmp/My Pics/shot.png"))
        );
    }

    #[test]
    fn uri_to_path_rejects_other_schemes_and_hosts() {
        assert!(uri_to_path("https://example.com/shot.png").is_err());
        assert!(uri_to_path("file://other-host/tmp/shot.png").is_err());
        assert!(uri_to_path("/tmp/shot.png").is_err());
    }

    #[test]
    fn uri_to_path_rejects_broken_escapes() {
        assert!(uri_to_path("file:///tmp/%ZZ.png").is_err());
    }

    #[test]
    fn permissions_reflect_the_portal_grant() {
        let granted = permissions_with(Some(true), false);
        assert!(!granted.accessibility);
        assert!(granted.screen_recording);
        assert!(granted.screenshots_supported);
        assert_eq!(granted.screenshots_unsupported, None);
    }

    #[test]
    fn permissions_before_the_first_request_allow_trying_the_portal() {
        let waiting = permissions_with(None, false);
        assert!(waiting.screenshots_supported);
        assert!(waiting.screen_recording);
        assert!(!waiting.accessibility);
    }

    #[test]
    fn permissions_after_a_refusal_offer_screenshots_no_more() {
        let refused = permissions_with(Some(false), false);
        assert!(!refused.screenshots_supported);
        assert!(!refused.screen_recording);
    }

    #[test]
    fn permissions_report_accessibility_only_when_the_session_can_take_input() {
        let capable = permissions_with(Some(true), true);
        assert!(capable.accessibility);
        let incapable = permissions_with(Some(true), false);
        assert!(!incapable.accessibility);
        // The screen-recording answer stays the portal's: input capability is a separate question.
        for permissions in [capable, incapable] {
            assert!(permissions.screen_recording);
            assert!(permissions.screenshots_supported);
            assert_eq!(permissions.screenshots_unsupported, None);
        }
    }

    #[test]
    fn a_refused_portal_dialog_stops_screenshots_whatever_input_can_do() {
        for accessibility in [true, false] {
            let refused = permissions_with(Some(false), accessibility);
            assert!(!refused.screenshots_supported);
            assert!(!refused.screen_recording);
            assert_eq!(refused.accessibility, accessibility);
        }
    }

    #[test]
    fn the_desktop_reports_the_probed_capability_beside_the_portal_grant() {
        use super::super::Desktop;
        let capable = LinuxDesktop::with_can_input(true);
        let permissions = capable.permissions();
        assert!(permissions.accessibility);
        assert!(permissions.screen_recording); // the portal was not asked yet: it prompts per request
        assert!(permissions.screenshots_supported);
        let incapable = LinuxDesktop::with_can_input(false);
        assert!(!incapable.permissions().accessibility);
        assert!(incapable.permissions().screen_recording);
    }

    const MONITORS: &str = r#"[
        {"id":0,"name":"DP-1","width":2560,"height":1440,"x":0,"y":0,"scale":1.0,"focused":true},
        {"id":1,"name":"HDMI-A-1","width":1920,"height":1080,"x":2560,"y":0,"scale":1.0,"focused":false}
    ]"#;

    #[test]
    fn focused_monitor_picks_the_focused_one_with_its_origin() {
        assert_eq!(
            focused_monitor(MONITORS),
            Ok(MonitorGeometry { origin: Point { x: 0.0, y: 0.0 }, logical_width: 2560.0 })
        );
    }

    #[test]
    fn focused_monitor_errors_when_none_is_focused() {
        let none = r#"[{"id":0,"name":"DP-1","width":2560,"height":1440,"x":0,"y":0,"scale":1.0,"focused":false}]"#;
        assert!(focused_monitor(none).is_err());
    }

    #[test]
    fn focused_monitor_errors_on_broken_json() {
        assert!(focused_monitor("not json").is_err());
    }

    #[test]
    fn posts_refuse_what_the_keymap_cannot_press_before_touching_the_compositor() {        // A full keyboard post needs a compositor; these two are refused by the plan alone, so a
        // machine without one still checks the message a user gets. `fn` has no Linux key, and the
        // built-in US keymap cannot type `é`.
        let desktop = LinuxDesktop::new();
        let error = super::super::Desktop::post(&desktop, &InputEvent::Key(super::super::keys::parse_combo("fn+f1").unwrap()))
            .unwrap_err();
        assert!(error.contains("fn"), "{error}");
        let error = super::super::Desktop::post(&desktop, &InputEvent::Text("é".into())).unwrap_err();
        assert!(error.contains('é'), "{error}");
    }

    // ---- The app-identity layer (odd/tasks/linux-input-control.md T6) ----

    use super::super::blocklist::{blocked_reason, AppIdentity};

    fn at(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    /// `hyprctl clients -j` from a real Hyprland session, trimmed to the fields the app-identity
    /// layer reads: a tiled terminal on one monitor, two tiled Chrome windows on two workspaces of
    /// another monitor, a floating pinned window, and Gentle Dot's own two off-screen pinned Dots.
    const CLIENTS: &str = r#"[
  {"address": "0x55e48ab27980", "mapped": true, "hidden": false, "at": [1932, 38], "size": [1896, 1030], "workspace": {"id": 5, "name": "5"}, "floating": false, "monitor": 0, "class": "com.mitchellh.ghostty", "title": "omarchycinlo: sidebar-tree", "initialClass": "com.mitchellh.ghostty", "pid": 626136, "pinned": false, "focusHistoryID": 0},
  {"address": "0x55e4a5cc2940", "mapped": true, "hidden": false, "at": [702, 38], "size": [1206, 1030], "workspace": {"id": 1, "name": "1"}, "floating": false, "monitor": 1, "class": "google-chrome", "title": "CinloFood — Restaurant OS - Google Chrome", "initialClass": "google-chrome", "pid": 642109, "pinned": false, "focusHistoryID": 1},
  {"address": "0x55e48b3592c0", "mapped": true, "hidden": false, "at": [12, 38], "size": [1896, 1030], "workspace": {"id": 2, "name": "2"}, "floating": false, "monitor": 1, "class": "google-chrome", "title": "CLI Proxy API Management Center", "initialClass": "google-chrome", "pid": 642109, "pinned": false, "focusHistoryID": 5},
  {"address": "0x55e48ad3f2f0", "mapped": true, "hidden": false, "at": [521, 12], "size": [72, 72], "workspace": {"id": 1, "name": "1"}, "floating": true, "monitor": 1, "class": "Gentle-dot", "title": "Gentle Dot", "initialClass": "Gentle-dot", "pid": 109376, "pinned": true, "focusHistoryID": 4},
  {"address": "0x55e48ab66c90", "mapped": true, "hidden": false, "at": [1661, 944], "size": [72, 72], "workspace": {"id": 1, "name": "1"}, "floating": true, "monitor": 1, "class": "neko-dot", "title": "Neko Dot", "initialClass": "neko-dot", "pid": 5046, "pinned": true, "focusHistoryID": 7},
  {"address": "0x55e48ab41ff0", "mapped": true, "hidden": false, "at": [1821, -99], "size": [20, 20], "workspace": {"id": 1, "name": "1"}, "floating": true, "monitor": 1, "class": "Gentle-dot", "title": "gentle-dot", "initialClass": "Gentle-dot", "pid": 109376, "pinned": false, "focusHistoryID": 2},
  {"address": "0x55e4895016d0", "mapped": true, "hidden": false, "at": [1821, -99], "size": [20, 20], "workspace": {"id": 1, "name": "1"}, "floating": true, "monitor": 1, "class": "Gentle-dot", "title": "gentle-dot", "initialClass": "Gentle-dot", "pid": 109376, "pinned": false, "focusHistoryID": 10}
]"#;

    /// The same session's `hyprctl monitors -j`, trimmed to each monitor's id and the workspace it
    /// shows: the terminal's monitor shows workspace 5, the Chrome windows' monitor shows 1.
    const PLACED: &str = r#"[
  {"id": 0, "name": "HDMI-A-1", "width": 1920, "height": 1080, "x": 1920, "y": 0, "scale": 1.0, "focused": true, "activeWorkspace": {"id": 5, "name": "5"}},
  {"id": 1, "name": "DP-1", "width": 1920, "height": 1080, "x": 0, "y": 0, "scale": 1.0, "focused": false, "activeWorkspace": {"id": 1, "name": "1"}},
  {"id": 2, "name": "HEADLESS-TABLET", "width": 1280, "height": 800, "x": 1920, "y": 1080, "scale": 1.0, "focused": false, "activeWorkspace": {"id": 8, "name": "8"}}
]"#;

    /// `hyprctl activewindow -j`, as that session answered it.
    const ACTIVE: &str = r#"{
    "address": "0x55e48ab27980",
    "mapped": true,
    "hidden": false,
    "visible": true,
    "acceptsInput": true,
    "at": [1932, 38],
    "size": [1896, 1030],
    "workspace": {
        "id": 5,
        "name": "5"
    },
    "floating": false,
    "monitor": 0,
    "class": "com.mitchellh.ghostty",
    "title": "omarchycinlo: sidebar-tree",
    "initialClass": "com.mitchellh.ghostty",
    "initialTitle": "Ghostty",
    "pid": 626136,
    "xwayland": false,
    "pinned": false,
    "pinFullscreened": false,
    "fullscreen": 0,
    "fullscreenClient": 0,
    "grouped": [],
    "tags": ["terminal*"],
    "swallowing": "0x0",
    "focusHistoryID": 0,
    "inhibitingIdle": false,
    "xdgTag": "",
    "xdgDescription": "",
    "contentType": "none",
    "tearingHint": false,
    "stableId": "1800005a"
}"#;

    fn clients() -> Vec<HyprClient> {
        parse_clients(CLIENTS).unwrap()
    }

    fn placed() -> Vec<(i64, i64)> {
        active_workspaces(PLACED).unwrap()
    }

    /// The topmost on-screen client under `at`, the way `window_owner_at` asks for it.
    fn topmost(at: Point) -> Option<HyprClient> {
        let clients = clients();
        let placed = placed();
        window_owner(on_screen(&clients, &placed), at).cloned()
    }

    #[test]
    fn clients_parse_the_fields_the_identity_layer_reads() {
        let clients = clients();
        assert_eq!(clients.len(), 7);
        let ghostty = &clients[0];
        assert_eq!(ghostty.address, "0x55e48ab27980");
        assert_eq!(ghostty.class, "com.mitchellh.ghostty");
        assert_eq!(ghostty.initial_class, "com.mitchellh.ghostty");
        assert_eq!(ghostty.title, "omarchycinlo: sidebar-tree");
        assert_eq!(ghostty.pid, 626136);
        assert_eq!(ghostty.rect, Rect { x: 1932.0, y: 38.0, width: 1896.0, height: 1030.0 });
        assert_eq!((ghostty.workspace_id, ghostty.monitor_id), (5, 0));
        assert!(ghostty.mapped && !ghostty.hidden && !ghostty.floating && !ghostty.pinned);
        assert_eq!(ghostty.focus_history_id, 0);
        let dot = &clients[3];
        assert!(dot.floating && dot.pinned);
        assert_eq!(dot.rect, Rect { x: 521.0, y: 12.0, width: 72.0, height: 72.0 });
    }

    #[test]
    fn a_client_without_the_optional_fields_still_parses() {
        let minimal = r#"[{"address": "0x1", "class": "kitty", "initialClass": "kitty", "title": "t", "pid": 7, "at": [0, 0], "size": [10, 10], "workspace": {"id": 2, "name": "2"}, "monitor": 0}]"#;
        let client = &parse_clients(minimal).unwrap()[0];
        // A mapped, plain window unless Hyprland says otherwise...
        assert!(client.mapped);
        assert!(!client.hidden && !client.floating && !client.pinned);
        // ...and one whose focus history it did not state never wins the topmost tie-break.
        assert_eq!(client.focus_history_id, i64::MAX);
    }

    #[test]
    fn clients_json_hyprland_did_not_write_is_a_descriptive_error() {
        assert!(parse_clients("not json").unwrap_err().contains("hyprctl clients -j"));
        assert!(parse_clients(r#"{"address": "0x1"}"#).unwrap_err().contains("expected an array"));
        let missing =
            r#"[{"address": "0x1", "class": "kitty", "initialClass": "kitty", "pid": 7, "size": [10, 10], "workspace": {"id": 2}, "monitor": 0}]"#;
        let error = parse_clients(missing).unwrap_err();
        assert!(error.contains("hyprctl client"), "{error}");
    }

    #[test]
    fn the_active_window_is_the_focused_client() {
        let active = parse_active_window(ACTIVE).unwrap().expect("a window is focused");
        assert_eq!(active.address, "0x55e48ab27980");
        assert_eq!(active.class, "com.mitchellh.ghostty");
        assert_eq!(active.pid, 626136);
        assert_eq!(active.rect, Rect { x: 1932.0, y: 38.0, width: 1896.0, height: 1030.0 });
        assert_eq!(active.focus_history_id, 0);
    }

    #[test]
    fn no_focused_window_is_none() {
        // Hyprland answers `{}` for a workspace with no window; older builds `null`.
        assert_eq!(parse_active_window("{}"), Ok(None));
        assert_eq!(parse_active_window("null"), Ok(None));
        let error = parse_active_window("no compositor").unwrap_err();
        assert!(error.contains("hyprctl activewindow -j"), "{error}");
    }

    #[test]
    fn the_workspace_each_monitor_shows_is_read() {
        assert_eq!(placed(), [(0, 5), (1, 1), (2, 8)]);
        assert!(active_workspaces(r#"[{"id": 0}]"#).is_err());
        assert!(active_workspaces("not json").is_err());
    }

    #[test]
    fn the_owner_is_the_window_whose_box_contains_the_point() {
        let owner = topmost(at(800.0, 100.0)).expect("a Chrome window covers this point");
        assert_eq!(owner.address, "0x55e4a5cc2940");
        assert_eq!(topmost(at(560.0, 50.0)).map(|client| client.address), Some("0x55e48ad3f2f0".into()));
        assert_eq!(topmost(at(5000.0, 5000.0)), None);
    }

    #[test]
    fn a_point_only_a_window_off_its_monitors_workspace_covers_owns_nothing() {
        // DP-1 shows workspace 1, so the Chrome window on workspace 2 draws nothing there — even
        // though its box is the one under this point.
        let covered = clients().into_iter().any(|client| client.rect.contains(at(100.0, 100.0)));
        assert!(covered, "the fixture must have a window under the point");
        assert_eq!(topmost(at(100.0, 100.0)), None);
    }

    #[test]
    fn an_edge_belongs_to_one_window_only() {
        // Half-open boxes: the near corner is inside, the far edge is not (the only other window
        // under it is the hidden one).
        assert_eq!(topmost(at(702.0, 38.0)).map(|client| client.address), Some("0x55e4a5cc2940".into()));
        assert_eq!(topmost(at(1908.0, 100.0)), None);
    }

    #[test]
    fn floating_windows_are_above_tiled_ones() {
        // The point is inside both the tiled Chrome window and a floating pinned one.
        let owner = topmost(at(1700.0, 980.0)).expect("the floating window covers this point");
        assert_eq!(owner.class, "neko-dot");
    }

    #[test]
    fn the_most_recently_focused_floating_window_is_on_top() {
        // Gentle Dot's two Dots share a box: the one focused more recently (focusHistoryID 2) wins.
        assert_eq!(topmost(at(1830.0, -90.0)).map(|client| client.address), Some("0x55e48ab41ff0".into()));
    }

    #[test]
    fn pinned_windows_stay_on_screen_and_the_others_go_with_their_workspace() {
        let clients = clients();
        let other_workspace = [(0, 5), (1, 3), (2, 8)]; // DP-1 switched to workspace 3
        let shown = on_screen(&clients, &other_workspace);
        assert_eq!(
            window_owner(shown, at(560.0, 50.0)).map(|client| client.address.clone()),
            Some("0x55e48ad3f2f0".into())
        );
        assert_eq!(window_owner(on_screen(&clients, &other_workspace), at(800.0, 100.0)), None);
    }

    #[test]
    fn a_hidden_or_unmapped_window_owns_nothing() {
        let mut clients = clients();
        let index = clients.iter().position(|client| client.address == "0x55e4a5cc2940").unwrap();
        let placed = placed();
        clients[index].hidden = true;
        assert_eq!(window_owner(on_screen(&clients, &placed), at(800.0, 100.0)), None);
        clients[index].hidden = false;
        clients[index].mapped = false;
        assert_eq!(window_owner(on_screen(&clients, &placed), at(800.0, 100.0)), None);
    }

    #[test]
    fn the_identity_names_the_app_and_keeps_the_class_it_started_with() {
        assert_eq!(
            identity(&clients()[1]),
            AppIdentity { pid: 642109, bundle_id: Some("google-chrome".into()), name: "google-chrome".into() }
        );
        // Apps rewrite their class as their state changes; `initialClass` keeps one identity.
        let rewritten = HyprClient { class: "com.discordapp.Discord".into(), initial_class: "discord".into(), ..clients()[1].clone() };
        let discord = identity(&rewritten);
        assert_eq!(discord.bundle_id.as_deref(), Some("discord"));
        assert_eq!(discord.name, "com.discordapp.Discord");
        // A window with no class at all is still an app, by its pid.
        let unnamed = HyprClient { class: String::new(), initial_class: String::new(), pid: 77, ..clients()[1].clone() };
        assert_eq!(identity(&unnamed), AppIdentity { pid: 77, bundle_id: None, name: "process 77".into() });
    }

    #[test]
    fn list_apps_lists_one_row_per_app_and_marks_the_one_in_front() {
        let clients = clients();
        let active = parse_active_window(ACTIVE).unwrap();
        let apps = app_list(&clients, active.as_ref());
        let names: Vec<&str> = apps.iter().map(|app| app.name.as_str()).collect();
        assert_eq!(names, ["com.mitchellh.ghostty", "google-chrome", "Gentle-dot", "neko-dot"]);
        assert_eq!(apps[0].bundle_id.as_deref(), Some("com.mitchellh.ghostty"));
        assert!(apps[0].active, "the focused window's app is the active one");
        assert!(!apps[1].active && !apps[2].active && !apps[3].active);
        // Gentle Dot's three windows are one app.
        assert_eq!(apps.iter().filter(|app| app.name == "Gentle-dot").count(), 1);
        // Nothing focused: no row claims to be in front.
        assert!(app_list(&clients, None).iter().all(|app| !app.active));
    }

    #[test]
    fn the_app_in_front_is_the_active_window() {
        let front = frontmost(ACTIVE).unwrap().expect("a window is focused");
        assert_eq!(front.name, "com.mitchellh.ghostty");
        assert_eq!(front.pid, 626136);
        assert_eq!(frontmost("{}").unwrap(), None);
        assert!(frontmost("not json").is_err());
    }

    #[test]
    fn open_app_focuses_the_window_of_an_app_that_is_running() {
        let plan = open_plan("google-chrome", &clients()).unwrap();
        // The more recently focused of the app's windows, by its exact handle.
        assert_eq!(plan, OpenPlan::Focus { selector: "address:0x55e4a5cc2940".into() });
        assert_eq!(plan.classic_dispatch(), "focuswindow address:0x55e4a5cc2940");
        // The Lua form of the same dispatch, for Hyprland 0.56 with a Lua config.
        assert_eq!(plan.lua_dispatch(), "hl.dsp.focus({ window = 'address:0x55e4a5cc2940' })");
        // The class is the app id: case and a `.desktop` file name the same app.
        assert_eq!(open_plan("Google-Chrome", &clients()).unwrap(), plan);
        assert_eq!(open_plan("google-chrome.desktop", &clients()).unwrap(), plan);
        assert_eq!(
            open_plan("com.mitchellh.ghostty", &clients()).unwrap(),
            OpenPlan::Focus { selector: "address:0x55e48ab27980".into() }
        );
    }

    #[test]
    fn open_app_runs_a_name_no_window_has() {
        let plan = open_plan("firefox", &clients()).unwrap();
        assert_eq!(plan, OpenPlan::Run { command: "firefox".into() });
        assert_eq!(plan.classic_dispatch(), "exec firefox");
        assert_eq!(plan.lua_dispatch(), "hl.dsp.exec_raw(\"firefox\")");
        assert_eq!(open_plan("  firefox  ", &clients()).unwrap(), OpenPlan::Run { command: "firefox".into() });
    }

    #[test]
    fn open_app_refuses_an_empty_name_and_shell_syntax() {
        let clients = clients();
        let error = open_plan("   ", &clients).unwrap_err();
        assert!(error.contains("without a name"), "{error}");
        // The `exec` dispatcher runs through the shell, so a name that is a shell line is refused.
        for name in ["firefox; rm -rf ~", "firefox && curl x | sh", "$(reboot)", "firefox\necho hi", "firefox > /dev/null"] {
            let error = open_plan(name, &clients).unwrap_err();
            assert!(error.contains("shell"), "{name}: {error}");
        }
        let error = open_plan("-delete", &clients).unwrap_err();
        assert!(error.contains("does not start with `-`"), "{error}");
    }

    /// One `hyprctl` answer, as the app reads it: the command, the exit code and the streams.
    fn answer(command: &str, status: i32, stdout: &str, stderr: &str) -> CommandAnswer {
        CommandAnswer { command: command.to_string(), status, stdout: stdout.to_string(), stderr: stderr.to_string() }
    }

    /// What Hyprland 0.56.2 with a Lua config answers the classic `dispatch focuswindow address:…`,
    /// verbatim from a live session (upstream hyprwm/Hyprland#16224): exit 7, and this on stdout.
    const LUA_REFUSAL: &str = "error: [string \"return hl.dispatch(focuswindow address:0x561e73abeb00\"]:1: ')' expected near 'address'\n\n → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax might need to be updated.";

    /// The same refusal as the live session prints it on stdout (exit 7).
    fn refusal(command: &str, stdout: &str) -> CommandAnswer {
        answer(command, 7, stdout, "")
    }

    #[test]
    fn hyprland_056_refuses_the_classic_dispatch_syntax_with_a_lua_parse_error() {
        let refused = refusal("hyprctl dispatch focuswindow address:0x561e73abeb00", LUA_REFUSAL);
        assert!(!refused.succeeded());
        assert!(refused.refused_classic_syntax());
        // Some builds put the same parse error on stderr instead; the rule reads both.
        let on_stderr = answer("hyprctl dispatch focuswindow address:0x561e73abeb00", 7, "", LUA_REFUSAL);
        assert!(on_stderr.refused_classic_syntax());
        // Every classic dispatcher with an argument is refused the same way, `exec` included.
        let exec = refusal(
            "hyprctl dispatch exec sleep 0.1",
            "error: [string \"return hl.dispatch(exec sleep 0.1)\"]:1: ')' expected near 'sleep'",
        );
        assert!(exec.refused_classic_syntax());
        assert!(!exec.succeeded());
        // A real failure is not a syntax refusal, so it is not retried.
        let gone = answer("hyprctl dispatch focuswindow address:0xdeadbeef", 1, "error: window not found", "");
        assert!(!gone.refused_classic_syntax());
        // hyprctl also reports an unknown request on stdout while exiting 0.
        let unknown = answer("hyprctl dispatch nonsense", 0, "Invalid dispatcher, nothing happened.", "");
        assert!(!unknown.succeeded());
        assert!(!unknown.refused_classic_syntax());
    }

    #[test]
    fn the_lua_form_is_tried_only_when_the_classic_syntax_was_refused() {
        let classic_command = "hyprctl dispatch focuswindow address:0x561e73abeb00";
        let lua_command = "hyprctl dispatch hl.dsp.focus({ window = 'address:0x561e73abeb00' })";
        // The classic form worked: nothing else is tried, whatever the Lua answer would be.
        let worked = answer(classic_command, 0, "ok", "");
        assert_eq!(dispatch_outcome(worked.clone(), None), Ok(()));
        assert_eq!(dispatch_outcome(worked, Some(answer(lua_command, 1, "", "boom"))), Ok(()));
        // Hyprland refused the classic syntax: the Lua form decides the outcome.
        assert_eq!(
            dispatch_outcome(refusal(classic_command, LUA_REFUSAL), Some(answer(lua_command, 0, "ok", ""))),
            Ok(())
        );
        let lua_failed = answer(lua_command, 1, "warning: hl.focus: window not found", "");
        assert_eq!(
            dispatch_outcome(refusal(classic_command, LUA_REFUSAL), Some(lua_failed.clone())),
            Err(lua_failed.failure())
        );
        // A real classic failure is reported as itself, with the command that failed.
        let gone = answer(classic_command, 1, "error: window not found", "");
        let error = dispatch_outcome(gone, None).unwrap_err();
        assert!(error.starts_with("hyprctl dispatch focuswindow address:0x561e73abeb00 failed:"), "{error}");
        assert!(error.contains("window not found"), "{error}");
        // A refusal with no Lua answer to fall back on is still an error, never a silent success.
        assert!(dispatch_outcome(refusal(classic_command, LUA_REFUSAL), None).is_err());
    }

    #[test]
    fn the_lua_form_uses_the_dispatchers_that_exist_on_056() {
        // `hl.dsp.exec` does not exist there; `exec_raw` takes the command string itself.
        let run = OpenPlan::Run { command: "firefox".into() };
        assert_eq!(run.lua_dispatch(), "hl.dsp.exec_raw(\"firefox\")");
        assert!(!run.lua_dispatch().contains("hl.dsp.exec("), "{}", run.lua_dispatch());
        let focus = OpenPlan::Focus { selector: "address:0x55e4a5cc2940".into() };
        assert_eq!(focus.lua_dispatch(), "hl.dsp.focus({ window = 'address:0x55e4a5cc2940' })");
    }

    #[test]
    fn a_focus_selector_is_only_built_from_a_hyprland_address() {
        let mut clients = clients();
        let index = clients.iter().position(|client| client.class == "google-chrome").unwrap();
        clients[index].address = "0xZZ".into();
        assert!(open_plan("google-chrome", &clients).is_err());
        clients[index].address = "55e4a5cc2940".into();
        assert!(open_plan("google-chrome", &clients).is_err());
        assert_eq!(focus_plan(&clients, 642109), None);
    }

    #[test]
    fn bringing_an_app_back_focuses_the_window_it_left_in_front() {
        let plan = focus_plan(&clients(), 109376).expect("Gentle Dot's windows are there");
        assert_eq!(plan, OpenPlan::Focus { selector: "address:0x55e48ab41ff0".into() });
        assert_eq!(plan.classic_dispatch(), "focuswindow address:0x55e48ab41ff0");
        assert_eq!(plan.lua_dispatch(), "hl.dsp.focus({ window = 'address:0x55e48ab41ff0' })");
        // An app with no window here has nothing to bring back.
        assert_eq!(focus_plan(&clients(), 4242), None);
    }

    #[test]
    fn a_pointer_target_now_resolves_and_the_blocklist_gate_has_something_to_refuse() {
        // `mcp::pointer_target` asks `window_owner_at` and refuses the blocklist's answer: these
        // are the answers it gets on Linux now, instead of `None` for every point.
        let target = owner_at(CLIENTS, PLACED, at(800.0, 100.0)).unwrap().expect("a window covers the point");
        assert_eq!(target.name, "google-chrome");
        assert_eq!(blocked_reason(&target, 4242), None);
        let own = owner_at(CLIENTS, PLACED, at(1830.0, -90.0)).unwrap().expect("one of Gentle Dot's Dots covers the point");
        assert_eq!(blocked_reason(&own, 109376), Some("Gentle Dot"));
        // A point no window covers is still the unknown target `mcp` refuses.
        assert_eq!(owner_at(CLIENTS, PLACED, at(5000.0, 5000.0)).unwrap(), None);
        assert!(owner_at("not json", PLACED, at(0.0, 0.0)).is_err());
    }

    #[test]
    fn a_keyboard_target_now_resolves_to_the_active_window() {
        let front = frontmost(ACTIVE).unwrap().expect("a window is focused");
        assert_eq!(blocked_reason(&front, 4242), None);
        // Nothing focused is the one answer that still refuses keys.
        assert_eq!(frontmost("{}").unwrap(), None);
    }

    /// The live pointer smoke (T4's manual verification helper): moves the real cursor to a fixed
    /// point through the production path and checks it arrived. No clicks, no keys.
    /// Run: cargo test --lib live_pointer_smoke -- --ignored --nocapture
    #[test]
    #[ignore = "moves the real cursor; run with --ignored on a live Hyprland session"]
    fn live_pointer_smoke() {
        let desktop = LinuxDesktop::new();
        let point = |at: Point| {
            let screen = linux_input::virtual_screen(&hyprctl_monitors().unwrap()).unwrap();
            println!("screen {screen:?}");
            let plan = linux_input::pointer_plan(&InputEvent::Move(at), &screen).unwrap();
            println!("plan {plan:?}");
            super::super::Desktop::post(&desktop, &InputEvent::Move(at)).expect("live pointer move");
            std::thread::sleep(std::time::Duration::from_millis(300));
            hyprctl(&["cursorpos"]).unwrap()
        };
        // A first move away from the target makes the second one a real move whatever the cursor
        // was doing, and shows that two posts of one session both land.
        println!("away: {}", point(Point { x: 1200.0, y: 600.0 }));
        let after = point(Point { x: 60.0, y: 60.0 });
        println!("cursor after: {after}");
        let parts: Vec<&str> = after.trim().split(',').collect();
        assert_eq!(parts.len(), 2, "unexpected cursorpos format: {after}");
        let x: f64 = parts[0].trim().parse().expect("a cursor x");
        let y: f64 = parts[1].trim().parse().expect("a cursor y");
        assert!((x - 60.0).abs() <= 2.0 && (y - 60.0).abs() <= 2.0, "cursor at {x},{y}, expected ~60,60");
    }

    /// The live keyboard smoke (T4's manual verification helper): launches a Ghostty running a
    /// raw-mode `cat > file`, focuses it by window address, types "ab" and Return through the
    /// delivery path under test, and polls the file to measure when (or whether) the bytes arrive.
    /// Run: cargo test --lib live_keyboard_smoke -- --ignored --nocapture
    #[test]
    #[ignore = "opens a terminal window and types into it; run with --ignored on a live Hyprland session"]
    fn live_keyboard_smoke() {
        use crate::computer::keys::parse_combo;

        // A raw-mode tty writes each byte as it arrives, so the file shows the text apart from
        // the Return, instead of waiting for the line to end first.
        const SCRIPT: &str = "stty -icanon -echo; cat > /tmp/gentle-keyboard-smoke.txt";
        let target_file = "/tmp/gentle-keyboard-smoke.txt";
        let _ = std::fs::remove_file(target_file);
        let desktop = LinuxDesktop::new();

        let before: Vec<String> = parse_clients(&hyprctl(&["clients", "-j"]).unwrap())
            .unwrap()
            .into_iter()
            .map(|client| client.address)
            .collect();
        // Open and focus through the production dispatch wrapper, the way `open_app` does: it
        // speaks both of Hyprland's dispatch syntaxes (hyprctl_dispatch).
        hyprctl_dispatch(&OpenPlan::Run { command: format!("ghostty -e sh -c '{SCRIPT}'") })
            .unwrap_or_else(|error| panic!("launch: {error}"));
        std::thread::sleep(std::time::Duration::from_millis(2000));
        let window = parse_clients(&hyprctl(&["clients", "-j"]).unwrap())
            .unwrap()
            .into_iter()
            .find(|client| client.class == "com.mitchellh.ghostty" && !before.contains(&client.address))
            .expect("the smoke terminal did not open");
        let focused = OpenPlan::Focus { selector: format!("address:{}", window.address) };
        // The focus dispatch can race the window's own initial focus, so ask again until it
        // sticks; a window that never takes it makes the run meaningless.
        for _ in 0..5 {
            hyprctl_dispatch(&focused).unwrap_or_else(|error| panic!("focus: {error}"));
            std::thread::sleep(std::time::Duration::from_millis(400));
            let active = parse_active_window(&hyprctl(&["activewindow", "-j"]).unwrap()).unwrap();
            if active.as_ref().map(|client| client.address.as_str()) == Some(window.address.as_str()) {
                break;
            }
        }
        let active = parse_active_window(&hyprctl(&["activewindow", "-j"]).unwrap()).unwrap();
        assert_eq!(
            active.as_ref().map(|client| client.address.as_str()),
            Some(window.address.as_str()),
            "the cat window did not take focus"
        );
        println!("cat window focused at address {}", window.address);

        // Each post is timed on its own: the raw-mode cat writes the bytes as they arrive.
        let poll = |target: char| -> Option<std::time::Duration> {
            let started = std::time::Instant::now();
            for _ in 0..100 {
                if std::fs::read_to_string(target_file).is_ok_and(|written| written.contains(target)) {
                    return Some(started.elapsed());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            None
        };
        let focused_now = |what: &str| {
            let active = parse_active_window(&hyprctl(&["activewindow", "-j"]).unwrap()).unwrap();
            println!("{what} focus: {:?}", active.map(|window| window.address));
        };

        let sent = std::time::Instant::now();
        super::super::Desktop::post(&desktop, &InputEvent::Text("ab".into())).expect("the text post");
        let text = poll('a').map(|_| sent.elapsed());
        println!("text post delivered in {text:?}");
        // A post that took longer than this did not arrive when it was sent.
        assert!(text.is_some_and(|delay| delay < std::time::Duration::from_secs(1)), "text delivery: {text:?}");

        focused_now("before return:");
        let sent = std::time::Instant::now();
        super::super::Desktop::post(&desktop, &InputEvent::Key(parse_combo("return").unwrap()))
            .expect("the Return post");
        let enter = poll('\n').map(|_| sent.elapsed());
        println!("return post delivered in {enter:?}");
        assert!(enter.is_some_and(|delay| delay < std::time::Duration::from_secs(1)), "Return delivery: {enter:?}");

        let written = std::fs::read_to_string(target_file).unwrap_or_default();
        println!("file: {written:?}");

        // Close the smoke terminal: in raw mode ^D is a literal byte, so end it by pid.
        let _ = std::process::Command::new("kill").arg(window.pid.to_string()).status();
        assert_eq!(written, "ab\n", "what the raw-mode cat received");
    }
}
