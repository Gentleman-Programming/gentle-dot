//! The MCP endpoint (S24.1): JSON-RPC 2.0 over streamable HTTP with `initialize`,
//! `tools/list`, and `tools/call`, behind a per-launch bearer token. Each call passes the
//! guards in order: rate limit, permissions, session grant, blocklist, risky-action
//! confirmation; then it acts and returns a fresh screenshot (S24.2–S24.4).
//!
//! A successful post means the input was delivered to the compositor, never that the screen
//! changed: the helper has no consumption signal and never claims the effect it did not
//! observe (S4, S5). On this Linux desktop keyboard input is additionally pinned to the
//! window that held the focus when the action started; a dialog that steals the focus is
//! undone by window id, and every typed fragment and synthesized Return is re-checked
//! against that same window immediately before it is posted, so a focus that moves
//! mid-typing stops the rest instead of sending it to the wrong window.
//!
//! `batch` (S24.8) runs up to 20 actions in one call. Each step takes the single tool's path
//! (`perform`) and counts as one action for the rate limit; a full window delays the step
//! instead of refusing it. Coordinates refer to the screenshot taken before the batch, and one
//! screenshot follows it. The first refused, declined, or failed step stops the batch.
//!
//! The glow (S28): once an action's input is posted, `perform` reports where it acted to the
//! glow sink, so a refused, declined, stopped, or failed action (or batch step) reports
//! nothing. The sink only queues the mark; it never changes a check, the order, or a result.
//!
//! The working rings (S1, S5): once the session is granted, every call that captures or acts
//! (all but `list_apps`) runs prepared: the rings show and Gentle Dot's own windows are out of
//! the way first, and they come back once the call ends, however it ends. A preparation that
//! fails sends nothing, and a Stop during it drops the call. The guards stay as they are.

use super::blocklist::{blocked_name, blocked_reason, AppIdentity};
use super::control::Control;
use super::coords::{Point, ScreenshotGeometry};
use super::glow::Mark;
use super::keys::{parse_combo, KeyCombo};
use super::rate::{RateLimiter, MAX_ACTIONS_PER_SECOND};
use super::risk::{assess, Act};
use super::working::{NoPreparation, Preparation};
use super::{BackendPolicy, Clock, Desktop, Dialogs, FocusTarget, GLOBAL_TARGET, InputEvent, MouseButton};
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, MutexGuard};

/// Supported MCP revisions, newest first; the newest answers an unknown request.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Time for the screen to settle before the screenshot that follows an action.
const SETTLE_MS: u64 = 150;
const OPEN_APP_SETTLE_MS: u64 = 1500;
const MAX_BATCH_STEPS: usize = 20;
/// The tools a batch step may use: actions only (a batch returns its own screenshot).
const BATCH_TOOLS: &[&str] = &["click", "move", "drag", "scroll", "type", "key", "open_app", "wait"];
/// Between batch steps, so each step's guards read the focus and windows the previous step left.
const STEP_PAUSE_MS: u64 = 100;
const MAX_WAIT_MS: u64 = 5000;
const WAIT_SLICE_MS: u64 = 100;
/// macOS posts at most 20 UTF-16 units of text per keyboard event.
const TEXT_CHUNK_UNITS: usize = 20;

/// The base scroll wording shared by both policies (S6): `dy` is required and `dx` is optional
/// and defaults to 0, so a purely vertical scroll needs only `dy`.
const SCROLL_DESCRIPTION: &str = "Scroll at a point. `dy` is required and `dx` is optional \
(0 by default), so a purely vertical scroll can omit `dx`; in pixels, `dy` > 0 scrolls down \
and `dx` > 0 scrolls right.";

/// The Linux per-operation scroll tick cap (S6), named in the desktop-global catalog so the
/// agent can split a longer gesture itself. It must match `linux::pointer::MAX_SCROLL_TICKS`,
/// which is what enforces it.
const LINUX_MAX_SCROLL_TICKS: u32 = 120;

/// The `key` tool wording shared by both policies. The desktop-global catalog appends the real
/// function-key range, since `keys::parse_combo` stops at `f12`; the macOS wording stays
/// byte-identical (T22, S4).
const KEY_DESCRIPTION: &str =
    "Press a key combo in the frontmost app, for example `cmd+shift+t`, `return`, or `esc`.";

const STOPPED: &str = "Computer control was stopped; this action was dropped.";
const NOT_ALLOWED: &str = "Computer control was not allowed by the user. Nothing was done.";
const NEEDS_PERMISSION: &str = "Gentle Dot needs the";
const GRANT_IT: &str = "Ask the user to grant it in Connectors → Computer.";
const NEEDS_SCREENSHOT: &str = "Take a screenshot first: coordinates are pixels of the latest screenshot.";
const UNKNOWN_TARGET: &str = "Cannot tell which app is under that point, so the action was refused. \
Take a new screenshot and try again.";

/// Global-mode keyboard refusals (T4, T16, S4/S5). Each one names its own cause — no snapshot,
/// a focus that moved during the capture, a focus that could not be read, Gentle Dot's own
/// window, an absent or invalid owner — so a live failure is diagnosable from the reply alone,
/// and each keeps the self-service next step instead of one generic sentence. None claims that
/// an action happened.
const NO_KEYBOARD_SNAPSHOT: &str = "No screenshot has been taken yet, so there is no keyboard target. \
Take a screenshot and try again.";
const FOCUS_MOVED_DURING_CAPTURE: &str = "The keyboard focus moved to another window while the last screenshot \
was taken, so it bound no keyboard target. Nothing was sent; focus the window you want, take a new screenshot, and try again.";
const NO_WINDOW_AT_CAPTURE: &str = "The last screenshot observed no focused window, so it bound no keyboard target. \
Nothing was sent; focus the window you want, take a new screenshot, and try again.";
const FOCUS_QUERY_FAILED_AT_CAPTURE: &str = "The keyboard focus could not be read while the last screenshot was taken, \
so it bound no keyboard target. Nothing was sent; take a new screenshot and try again.";
const OWN_FOCUS_WINDOW: &str = "Gentle Dot's own window has the keyboard focus, so nothing was sent. \
Click the window you want to receive the input, take a new screenshot, and try again.";
const NO_WINDOW_OWNER: &str = "The focused window does not report its process, so Gentle Dot cannot rule out its own \
window. Nothing was sent; click the window you want, take a new screenshot, and try again.";
const INVALID_OWNER_PID: &str = "The focused window reports an invalid owner process, so Gentle Dot cannot rule out its own \
window. Nothing was sent; click the window you want, take a new screenshot, and try again.";
/// Neutral reasons the captured target is no longer the focused window. A caller that already
/// posted some events adds its own delivery claim instead of asserting that nothing happened.
const FOCUS_MOVED_REASON: &str = "the keyboard focus moved to another window";
const FOCUS_LOST_REASON: &str = "the keyboard focus could not be read";
const FOCUS_OWNER_CHANGED: &str = "the focused window no longer belongs to the process this action captured";

const INSTRUCTIONS: &str = "Controls this Mac. Take a screenshot first; x and y are pixels of the latest \
screenshot. Every action returns a fresh screenshot. Use `batch` for a predictable sequence (click a field, \
type, press tab, type, press return) so it runs in one call; end the batch whenever you must see the screen \
before deciding the next step. The user must allow a session, risky actions ask the user to confirm, and \
some apps (System Settings, password managers) are off limits.";

/// What `initialize` tells the agent in global mode (T2, S5; S9): the same catalog drives
/// the Linux desktop as a whole, with no reliable per-app exclusion and no Mac permissions.
/// The session grant authorizes ordinary input, so a confirmation appears only for a
/// detected risk; the desktop cannot tell which app or control receives the input, so the
/// detectable signal is the action's declared intent (plus any accessibility metadata a
/// future backend adds), never a claim that the target is certified safe.
const GLOBAL_INSTRUCTIONS: &str = "Controls this Linux desktop as a whole: pointer input reaches whatever is under \
the point, keyboard input reaches the external window observed with the latest screenshot (a focus that changed \
since then is refused), and there is no reliable per-app exclusion. This desktop moves the keyboard focus to the \
window under the pointer, so moving the pointer changes which window receives the keyboard: take a fresh \
screenshot after moving and before typing. Take a screenshot first; x and y are pixels of \
the latest screenshot. Every action returns a fresh screenshot. A successful action means the input was delivered, \
not that the screen changed, so verify with a new screenshot. Use `batch` for a predictable sequence (click a field, \
type, press tab, type, press return) so it runs in one call; end the batch whenever you must see the screen before \
deciding the next step. The user must allow a 30-minute session, and that grant authorizes ordinary desktop input \
for the session: it does not ask again per action. A confirmation appears only when a risk is detected; on Linux the \
desktop cannot tell which app or control receives the input, so the detectable signal is the action's declared \
`intent` (plus anything a future accessibility feed adds), never a claim that the target is certified safe. Yolo \
mode skips only that risk confirmation; Stop cancels immediately. Risky targets cannot be fenced off per app.";

pub struct HttpRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub authorization: Option<&'a str>,
    pub body: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpReply {
    pub status: u16,
    pub body: Option<Value>,
}

enum Tool {
    Screenshot,
    Click { x: f64, y: f64, button: MouseButton, count: u8 },
    Move { x: f64, y: f64 },
    Drag { from: (f64, f64), to: (f64, f64) },
    Scroll { x: f64, y: f64, dx: i32, dy: i32 },
    Type { text: String },
    Key { combo: KeyCombo },
    OpenApp { name: String },
    ListApps,
    Wait { ms: u64 },
    /// Steps with their tool names, checked one by one when they run.
    Batch { steps: Vec<(&'static str, Call)> },
}

struct Call {
    tool: Tool,
    intent: Option<String>,
}

type Content = Vec<Value>;

/// A tool error; its content is a message, or what a batch did before it stopped.
struct Failed(Content);

impl From<String> for Failed {
    fn from(message: String) -> Self {
        Failed(vec![text(message)])
    }
}

impl From<&str> for Failed {
    fn from(message: &str) -> Self {
        Failed(vec![text(message)])
    }
}

fn text(text: impl Into<String>) -> Value {
    json!({"type": "text", "text": text.into()})
}

/// A prepared call (S1, S5); dropping it clears the rings and shows the windows again.
struct Prepared<'a> {
    working: &'a dyn Preparation,
    operation: u64,
}

impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        self.working.finish(self.operation);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn rpc_reply(status: u16, id: Value, outcome: Result<Value, (i64, String)>) -> HttpReply {
    let body = match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    };
    HttpReply { status, body: Some(body) }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    let mut properties = properties.as_object().cloned().unwrap_or_default();
    properties.insert(
        "intent".into(),
        json!({"type": "string", "description": "What this step is for, in a few words. Shown to the user when the action needs a confirmation."}),
    );
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

fn coordinate(description: &str) -> Value {
    json!({"type": "number", "minimum": 0, "description": description})
}

/// The tool catalog (S24.2). The launch and inventory descriptions follow the policy (S7): the
/// macOS wording stays exactly what it was, while the desktop-global one names what the Linux
/// backend can truthfully promise.
fn tools(policy: BackendPolicy) -> Value {
    let x = coordinate("Pixels from the left edge of the latest screenshot.");
    let y = coordinate("Pixels from the top edge of the latest screenshot.");
    let scroll = match policy {
        BackendPolicy::Targeted => SCROLL_DESCRIPTION.to_string(),
        // The catalog is the agent's only way to plan around the backend limit before it hits it.
        BackendPolicy::DesktopGlobal => format!(
            "{SCROLL_DESCRIPTION} At most {LINUX_MAX_SCROLL_TICKS} axis ticks are accepted per call \
on this Linux desktop; split a longer scroll into several calls."
        ),
    };
    let (open_app, list_apps) = match policy {
        BackendPolicy::Targeted => (
            "Open or bring forward an app by name or bundle id.".to_string(),
            "List the running apps.".to_string(),
        ),
        BackendPolicy::DesktopGlobal => (
            "Open an installed app by desktop id or display name. A success answer means the \
platform launcher accepted the request; it does not confirm that a window opened or gained focus."
                .to_string(),
            "List the apps Niri manages windows for: one entry per managed window app id, not \
background apps and not bundle ids."
                .to_string(),
        ),
    };
    // Only the desktop-global catalog names the accepted function-key limit (T22, S4): the
    // limit is real on both platforms, but macOS visible output stays byte-identical.
    let key = match policy {
        BackendPolicy::Targeted => KEY_DESCRIPTION.to_string(),
        BackendPolicy::DesktopGlobal => format!(
            "{KEY_DESCRIPTION} Function keys are `f1` to `f12`; `f13` to `f24` are rejected."
        ),
    };
    json!([
        {"name": "screenshot", "description": "Take a screenshot of the display under the pointer. Returns the image and its size.",
         "inputSchema": schema(json!({}), &[])},
        {"name": "click", "description": "Click at a point of the latest screenshot.",
         "inputSchema": schema(json!({"x": x, "y": y,
            "button": {"type": "string", "enum": ["left", "right"], "default": "left"},
            "count": {"type": "integer", "enum": [1, 2, 3], "default": 1, "description": "2 for a double click, 3 for a triple click."}}), &["x", "y"])},
        {"name": "move", "description": "Move the pointer to a point of the latest screenshot.",
         "inputSchema": schema(json!({"x": x, "y": y}), &["x", "y"])},
        {"name": "drag", "description": "Press at one point, move to another, and release.",
         "inputSchema": schema(json!({"fromX": x, "fromY": y, "toX": x, "toY": y}), &["fromX", "fromY", "toX", "toY"])},
        {"name": "scroll", "description": scroll,
         "inputSchema": schema(json!({"x": x, "y": y,
            "dx": {"type": "integer", "description": "Horizontal scroll, in pixels. Optional; defaults to 0. Omit it for a purely vertical scroll."},
            "dy": {"type": "integer", "description": "Vertical scroll, in pixels. Required; dy > 0 scrolls down."}}), &["x", "y", "dy"])},
        {"name": "type", "description": "Type text into the frontmost app. A newline presses Return.",
         "inputSchema": schema(json!({"text": {"type": "string"}}), &["text"])},
        {"name": "key", "description": key,
         "inputSchema": schema(json!({"combo": {"type": "string"}}), &["combo"])},
        {"name": "open_app", "description": open_app,
         "inputSchema": schema(json!({"name": {"type": "string"}}), &["name"])},
        {"name": "list_apps", "description": list_apps,
         "inputSchema": schema(json!({}), &[])},
        {"name": "wait", "description": "Wait, then take a screenshot.",
         "inputSchema": schema(json!({"ms": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS}}), &["ms"])},
        {"name": "batch", "description": "Run 1 to 20 actions in order in one call, then return one screenshot. Use it for \
predictable sequences, for example type, `tab`, type; or click a field, type, `return`. Coordinates are pixels of \
the screenshot taken before the batch, so batch only steps whose targets you can already see; when a step's result \
decides what comes next, end the batch there and look at the screenshot it returns. Each step is checked like a \
single call; the batch stops at the first refused, declined, or failed step and says which steps ran.",
         "inputSchema": schema(json!({"steps": {"type": "array", "minItems": 1, "maxItems": MAX_BATCH_STEPS,
            "items": {"type": "object", "description": "A tool name plus that tool's arguments, for example {\"tool\": \"type\", \"text\": \"hello\"}.",
                "properties": {"tool": {"type": "string", "enum": BATCH_TOOLS}}, "required": ["tool"]}}}), &["steps"])}
    ])
}

fn number(args: &Map<String, Value>, key: &str) -> Result<f64, String> {
    args.get(key).and_then(Value::as_f64).ok_or_else(|| format!("`{key}` must be a number"))
}

fn integer(args: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = number(args, key)?;
    if value.fract() != 0.0 || value.abs() > 1e9 {
        return Err(format!("`{key}` must be a whole number"));
    }
    Ok(value as i64)
}

fn string(args: &Map<String, Value>, key: &str) -> Result<String, String> {
    args.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("`{key}` must be a string"))
}

/// The call for `name`, `None` for an unknown tool, or why the arguments are invalid.
fn parse_call(name: &str, args: &Value) -> Option<Result<Call, String>> {
    let empty = Map::new();
    let args = args.as_object().unwrap_or(&empty);
    let point = |kx: &str, ky: &str| -> Result<(f64, f64), String> { Ok((number(args, kx)?, number(args, ky)?)) };
    let tool = || -> Result<Tool, String> {
        Ok(match name {
            "screenshot" => Tool::Screenshot,
            "click" => {
                let (x, y) = point("x", "y")?;
                let button = match args.get("button").map(|b| b.as_str()) {
                    None | Some(Some("left")) => MouseButton::Left,
                    Some(Some("right")) => MouseButton::Right,
                    _ => return Err("`button` must be \"left\" or \"right\"".into()),
                };
                let count = if args.contains_key("count") { integer(args, "count")? } else { 1 };
                if !(1..=3).contains(&count) {
                    return Err("`count` must be 1, 2, or 3".into());
                }
                Tool::Click { x, y, button, count: count as u8 }
            }
            "move" => {
                let (x, y) = point("x", "y")?;
                Tool::Move { x, y }
            }
            "drag" => Tool::Drag { from: point("fromX", "fromY")?, to: point("toX", "toY")? },
            "scroll" => {
                let (x, y) = point("x", "y")?;
                let delta = |key| integer(args, key).and_then(|v| i32::try_from(v).map_err(|e| e.to_string()));
                // `dx` is optional (S6): a purely vertical scroll omits it and defaults to 0.
                let dx = if args.contains_key("dx") { delta("dx")? } else { 0 };
                Tool::Scroll { x, y, dx, dy: delta("dy")? }
            }
            "type" => {
                let text = string(args, "text")?;
                // Newlines press Return (and are checked); tabs move the focus. Nothing else,
                // including Unicode line and paragraph separators that could act as Return.
                let control = |c: char| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}');
                if text.chars().any(|c| control(c) && !matches!(c, '\n' | '\r' | '\t')) {
                    return Err("`text` must not contain control characters other than newline and tab".into());
                }
                // The risk check sees the focus before the text; after a tab it may sit on a send button.
                if text.split_once('\t').is_some_and(|(_, rest)| rest.contains([' ', '\n', '\r'])) {
                    return Err("`text` must not type a space or a newline after a tab; send them in a separate call".into());
                }
                Tool::Type { text }
            }
            "key" => Tool::Key { combo: parse_combo(&string(args, "combo")?)? },
            "open_app" => {
                let name = string(args, "name")?.trim().to_string();
                if name.is_empty() {
                    return Err("`name` must not be empty".into());
                }
                Tool::OpenApp { name }
            }
            "list_apps" => Tool::ListApps,
            "batch" => Tool::Batch { steps: batch_steps(args)? },
            "wait" => {
                let ms = integer(args, "ms")?;
                if !(0..=MAX_WAIT_MS as i64).contains(&ms) {
                    return Err(format!("`ms` must be between 0 and {MAX_WAIT_MS}"));
                }
                Tool::Wait { ms: ms as u64 }
            }
            other => return Err(format!("unknown tool `{other}`")),
        })
    };
    const NAMES: &[&str] =
        &["screenshot", "click", "move", "drag", "scroll", "type", "key", "open_app", "list_apps", "wait", "batch"];
    if !NAMES.contains(&name) {
        return None;
    }
    let intent = args.get("intent").and_then(Value::as_str).map(str::to_string);
    Some(tool().map(|tool| Call { tool, intent }))
}

/// The steps of a `batch`, each parsed like a single call. Any invalid step refuses the batch.
fn batch_steps(args: &Map<String, Value>) -> Result<Vec<(&'static str, Call)>, String> {
    let steps = args.get("steps").and_then(Value::as_array).ok_or("`steps` must be a list of steps")?;
    if steps.is_empty() || steps.len() > MAX_BATCH_STEPS {
        return Err(format!("`steps` must hold 1 to {MAX_BATCH_STEPS} steps"));
    }
    let step = |n: usize, step: &Value| -> Result<(&'static str, Call), String> {
        let mut step = step.as_object().cloned().ok_or(format!("step {n} must be an object"))?;
        let name = step.remove("tool").and_then(|t| t.as_str().map(str::to_string));
        let name = name.ok_or(format!("step {n} needs a `tool`"))?;
        let tool = BATCH_TOOLS.iter().copied().find(|t| *t == name).ok_or_else(|| {
            format!("step {n}: `{name}` cannot be a batch step; use one of {}", BATCH_TOOLS.join(", "))
        })?;
        match parse_call(tool, &Value::Object(step)) {
            Some(Ok(call)) => Ok((tool, call)),
            Some(Err(error)) => Err(format!("step {n} ({tool}): {error}")),
            None => Err(format!("step {n}: unknown tool `{tool}`")),
        }
    };
    steps.iter().enumerate().map(|(i, s)| step(i + 1, s)).collect()
}

/// Splits text into chunks of at most `TEXT_CHUNK_UNITS` UTF-16 units, never inside a character.
fn chunks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if current.encode_utf16().count() + c.len_utf16() > TEXT_CHUNK_UNITS {
            out.push(std::mem::take(&mut current));
        }
        current.push(c);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// What the compositor reported about the keyboard focus at one moment around a capture
/// (T16, S4/S5). The three outcomes stay distinct so a refusal can name its cause and the
/// screenshot metadata can stay `null` when the observation did not succeed.
#[derive(Debug, Clone, PartialEq)]
enum FocusObservation {
    /// The compositor named the focused window.
    Window(FocusTarget),
    /// The compositor reported no focused window.
    NoWindow,
    /// The compositor's query failed.
    Failed,
}

impl FocusObservation {
    /// The focused window's `app_id`, when the observation succeeded and the window reported
    /// one. Never a fallback to the title: a document title is not an app name (T16, S4).
    fn app_id(&self) -> Option<&str> {
        match self {
            FocusObservation::Window(window) => window.app_id.as_deref(),
            FocusObservation::NoWindow | FocusObservation::Failed => None,
        }
    }
}

/// Why a capture bound no keyboard target (T16, S4/S5). Each variant maps to one refusal that
/// names the cause, so a live failure is diagnosable without reading the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusRefusal {
    /// The focus moved to a different window, or to a different owner, while the image was taken.
    Moved,
    /// No window held the focus around the capture.
    NoWindow,
    /// The compositor's focus query failed.
    QueryFailed,
    /// Gentle Dot's own window held the focus.
    OwnWindow,
    /// The focused window reports no owner process.
    NoOwnerPid,
    /// The focused window reports a non-positive owner process.
    InvalidOwnerPid,
}

impl FocusRefusal {
    /// The refusal a keyboard action gets for this cause. The owner rules reuse the same string
    /// whether the capture or the pre-post check detected the problem.
    fn message(self) -> &'static str {
        match self {
            FocusRefusal::Moved => FOCUS_MOVED_DURING_CAPTURE,
            FocusRefusal::NoWindow => NO_WINDOW_AT_CAPTURE,
            FocusRefusal::QueryFailed => FOCUS_QUERY_FAILED_AT_CAPTURE,
            FocusRefusal::OwnWindow => OWN_FOCUS_WINDOW,
            FocusRefusal::NoOwnerPid => NO_WINDOW_OWNER,
            FocusRefusal::InvalidOwnerPid => INVALID_OWNER_PID,
        }
    }
}

/// The keyboard target a screenshot bound (T16, S4/S5): the external window input may reach, or
/// the cause none could be bound. Never a guessed window.
#[derive(Debug, Clone, PartialEq)]
enum KeyboardBinding {
    Bound(FocusTarget),
    Refused(FocusRefusal),
}

/// The latest request scope: the geometry of the last screenshot and, in global mode, the
/// external window the keyboard must target for actions planned from it. One struct under the
/// existing `actions` mutex, so the geometry and the keyboard target can never disagree.
#[derive(Debug, Clone, PartialEq)]
struct Snapshot {
    geometry: ScreenshotGeometry,
    /// The keyboard target observed with this screenshot, or why none was bound (targeted
    /// policy, an unknown or own focus, a failed query, or a focus that moved mid-capture).
    keyboard: KeyboardBinding,
}

/// Whether a window's owner process lets it receive keyboard input (T16, S4/S5): never Gentle
/// Dot's own pid, and never an absent or non-positive pid (pid 0 is the kernel, not an app).
fn usable_owner(pid: Option<i32>, own_pid: i32) -> Result<(), FocusRefusal> {
    match pid {
        Some(pid) if pid == own_pid => Err(FocusRefusal::OwnWindow),
        Some(pid) if pid > 0 => Ok(()),
        Some(_) => Err(FocusRefusal::InvalidOwnerPid),
        None => Err(FocusRefusal::NoOwnerPid),
    }
}

/// The keyboard binding a capture may use (T16, S4/S5): only the same usable external window
/// observed before and after the image. Identity is the window id and its owner pid — a title
/// or app-id repaint in between is cosmetic and must not drop the binding — while a moved
/// window, a changed owner, Gentle Dot's own window, and a missing or non-positive owner all
/// bind nothing, exactly as before.
fn bind_keyboard_target(
    before: &FocusObservation,
    after: &FocusObservation,
    own_pid: i32,
) -> KeyboardBinding {
    let (before, after) = match (before, after) {
        (FocusObservation::Window(before), FocusObservation::Window(after)) => (before, after),
        (FocusObservation::Failed, _) | (_, FocusObservation::Failed) => {
            return KeyboardBinding::Refused(FocusRefusal::QueryFailed)
        }
        _ => return KeyboardBinding::Refused(FocusRefusal::NoWindow),
    };
    if before.window_id != after.window_id || before.pid != after.pid {
        return KeyboardBinding::Refused(FocusRefusal::Moved);
    }
    match usable_owner(after.pid, own_pid) {
        Ok(()) => KeyboardBinding::Bound(after.clone()),
        Err(refusal) => KeyboardBinding::Refused(refusal),
    }
}

/// A window's identity for a refusal message (T22, S4): the compositor window id plus the app
/// id the observation reported, or its title when it reported none. It never invents an
/// identity it does not hold, so a window with neither is named by its id alone.
fn window_label(window: &FocusTarget) -> String {
    match (&window.app_id, &window.title) {
        (Some(app_id), _) => format!("window {} ({app_id})", window.window_id),
        (None, Some(title)) => format!("window {} ({title})", window.window_id),
        (None, None) => format!("window {}", window.window_id),
    }
}

pub struct Helper {
    desktop: Arc<dyn Desktop>,
    dialogs: Arc<dyn Dialogs>,
    clock: Arc<dyn Clock>,
    control: Arc<Control>,
    token: String,
    own_pid: i32,
    limiter: Mutex<RateLimiter>,
    /// Serializes actions and holds the latest request scope: the screenshot geometry plus the
    /// keyboard window observed with that screenshot.
    actions: Mutex<Option<Snapshot>>,
    /// Where an action that went through acted (S28); must return at once.
    glow: Box<dyn Fn(Mark) + Send + Sync>,
    /// The working rings around each call that captures or acts (S1, S5).
    working: Arc<dyn Preparation>,
    /// `Targeted` unless a backend opts into `DesktopGlobal` (T2, S5).
    policy: BackendPolicy,
}

impl Helper {
    pub fn new(
        desktop: Arc<dyn Desktop>,
        dialogs: Arc<dyn Dialogs>,
        clock: Arc<dyn Clock>,
        control: Arc<Control>,
        token: String,
        own_pid: i32,
    ) -> Self {
        Helper {
            desktop,
            dialogs,
            clock,
            control,
            token,
            own_pid,
            limiter: Mutex::new(RateLimiter::new(MAX_ACTIONS_PER_SECOND, 1000)),
            actions: Mutex::new(None),
            glow: Box::new(|_| {}),
            working: Arc::new(NoPreparation),
            policy: BackendPolicy::Targeted,
        }
    }

    /// The backend policy this helper enforces.
    pub fn policy(&self) -> BackendPolicy {
        self.policy
    }

    /// Drives the desktop under `policy`. `Targeted` stays the default; only an
    /// explicit backend opts into `DesktopGlobal`, never production Linux yet (T5).
    pub fn with_policy(mut self, policy: BackendPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Prepares each call that captures or acts with `working` (S1, S5).
    pub fn with_working(mut self, working: Arc<dyn Preparation>) -> Self {
        self.working = working;
        self
    }

    /// Reports each action that went through to `glow`, which must only queue it (S28).
    pub fn with_glow(mut self, glow: impl Fn(Mark) + Send + Sync + 'static) -> Self {
        self.glow = Box::new(glow);
        self
    }

    fn authorized(&self, header: Option<&str>) -> bool {
        let Some((scheme, token)) = header.and_then(|h| h.trim().split_once(' ')) else {
            return false;
        };
        scheme.eq_ignore_ascii_case("bearer") && constant_time_eq(token.trim().as_bytes(), self.token.as_bytes())
    }

    pub fn handle(&self, request: &HttpRequest<'_>) -> HttpReply {
        if !self.authorized(request.authorization) {
            return rpc_reply(401, Value::Null, Err((-32001, "Unauthorized".into())));
        }
        if request.path != "/mcp" {
            return HttpReply { status: 404, body: None };
        }
        if request.method != "POST" {
            return HttpReply { status: 405, body: None };
        }
        let Ok(message) = serde_json::from_str::<Value>(request.body) else {
            return rpc_reply(400, Value::Null, Err((-32700, "Parse error".into())));
        };
        if !message.is_object() {
            return rpc_reply(400, Value::Null, Err((-32600, "Invalid request".into())));
        }
        // Notifications and responses get no reply.
        let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id").cloned()) else {
            return HttpReply { status: 202, body: None };
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let outcome = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tools(self.policy)})),
            "tools/call" => self.tools_call(&params),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        rpc_reply(200, id, outcome)
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params["protocolVersion"].as_str();
        let version = requested.filter(|v| PROTOCOL_VERSIONS.contains(v)).unwrap_or(PROTOCOL_VERSIONS[0]);
        json!({
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "gentle-dot-computer", "version": env!("CARGO_PKG_VERSION")},
            "instructions": self.instructions(),
        })
    }

    /// The `initialize` instructions for this helper's policy: the Mac catalog text, or the
    /// desktop-global Linux one that promises no per-app exclusion (T2, S5).
    fn instructions(&self) -> &'static str {
        match self.policy {
            BackendPolicy::Targeted => INSTRUCTIONS,
            BackendPolicy::DesktopGlobal => GLOBAL_INSTRUCTIONS,
        }
    }

    fn tools_call(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params["name"].as_str().ok_or((-32602, "Invalid params: `name` is required".to_string()))?;
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        self.control.expire(self.clock.now_ms());
        let epoch = self.control.epoch();
        self.call_tool_from(epoch, name, &args).ok_or((-32602, format!("Unknown tool: {name}")))
    }

    /// A `tools/call` that arrived while the session was at `epoch`.
    fn call_tool_from(&self, epoch: u64, name: &str, args: &Value) -> Option<Value> {
        let outcome = parse_call(name, args)?.map_err(Failed::from).and_then(|call| self.run(epoch, call));
        Some(match outcome {
            Ok(content) => json!({"content": content}),
            Err(Failed(content)) => json!({"content": content, "isError": true}),
        })
    }

    fn run(&self, epoch: u64, call: Call) -> Result<Content, Failed> {
        // A batch counts each of its steps instead (`pace`).
        let counted = !matches!(call.tool, Tool::Batch { .. });
        if counted && !lock(&self.limiter).try_acquire(self.clock.now_ms()) {
            return Err(format!("Too many actions: at most {MAX_ACTIONS_PER_SECOND} per second. Wait a moment.").into());
        }
        self.check_permissions(&call.tool)?;
        let mut latest = lock(&self.actions);
        self.control.expire(self.clock.now_ms());
        if self.control.epoch() != epoch {
            return Err(STOPPED.into());
        }
        if !self.control.is_active(self.clock.now_ms()) {
            // The screenshot of an ended session no longer describes the screen.
            *latest = None;
            if !self.with_dialog(|| self.dialogs.ask_grant())? {
                return Err(NOT_ALLOWED.into());
            }
            // Commit the grant only while the epoch this call started under still holds, checked
            // and granted under one session mutex: a Stop or panic while the dialog was open
            // invalidates the pending consent, so no session is reopened and nothing is sent.
            if !self.control.grant_if_epoch(epoch, self.clock.now_ms()) {
                return Err(STOPPED.into());
            }
        }
        // Until the call ends, however it ends, the rings show and the Dot and panel are hidden.
        let _prepared = match call.tool {
            Tool::ListApps => None,
            _ => Some(self.prepare(epoch)?),
        };
        self.act(epoch, &mut latest, call)
    }

    /// Shows the working rings and hides Gentle Dot's windows (S1, S5), then checks the session
    /// again: a Stop meanwhile drops the call. Nothing is captured or sent when this fails.
    fn prepare(&self, epoch: u64) -> Result<Prepared<'_>, Failed> {
        let operation = match self.working.begin() {
            Ok(operation) => operation,
            Err(error) => return Err(self.still_running(epoch).err().unwrap_or(error).into()),
        };
        let prepared = Prepared { working: self.working.as_ref(), operation };
        self.still_running(epoch)?;
        Ok(prepared)
    }

    fn check_permissions(&self, tool: &Tool) -> Result<(), String> {
        if let Tool::Batch { steps } = tool {
            return steps.iter().try_for_each(|(_, step)| self.check_permissions(&step.tool));
        }
        let permissions = self.desktop.permissions();
        let sees = !matches!(tool, Tool::ListApps);
        let acts = matches!(
            tool,
            Tool::Click { .. }
                | Tool::Move { .. }
                | Tool::Drag { .. }
                | Tool::Scroll { .. }
                | Tool::Type { .. }
                | Tool::Key { .. }
        );
        if sees && !permissions.screenshots_supported {
            // The Linux backend reports the same capability flags, but its errors must not
            // promise macOS versions or permission grant flows that do not exist there.
            if self.policy == BackendPolicy::DesktopGlobal {
                return Err("Screenshots are unavailable on this Linux desktop, so computer control cannot see it.".into());
            }
            return Err("Screenshots need macOS 14 or later, so computer control is unavailable on this Mac.".into());
        }
        if sees && !permissions.screen_recording {
            // Stock Wayland has no Screen Recording permission concept (screencopy
            // needs no portal grant): the flag never gates the DesktopGlobal path.
            if self.policy != BackendPolicy::DesktopGlobal {
                return Err(format!("{NEEDS_PERMISSION} Screen Recording permission. {GRANT_IT}"));
            }
        }
        if acts && !permissions.accessibility {
            // Stock Wayland has no Accessibility equivalent: the flag never gates
            // the DesktopGlobal path (a denied flag must not block Linux input).
            if self.policy != BackendPolicy::DesktopGlobal {
                return Err(format!("{NEEDS_PERMISSION} Accessibility permission. {GRANT_IT}"));
            }
        }
        Ok(())
    }

    /// Runs a dialog that takes the focus (a dialog activates Gentle Dot), then brings the
    /// keyboard focus back to the exact window it was on. Global mode restores the window id;
    /// macOS keeps its pid-based frontmost restore. Returns the answer, or why focus could
    /// not be restored, so a caller never posts after losing its target.
    fn with_dialog(&self, dialog: impl FnOnce() -> bool) -> Result<bool, String> {
        if self.policy == BackendPolicy::DesktopGlobal {
            // The focus reads are best effort: a failed query must not stop a screenshot, while
            // the keyboard guard stays strict about the target the request already bound.
            let before = self.desktop.focused_window().ok().flatten();
            let answer = dialog();
            if let Some(before) = before {
                match self.desktop.focused_window() {
                    Ok(Some(now)) if now.window_id == before.window_id => {}
                    _ => self.desktop.focus_window(&before)?,
                }
            }
            return Ok(answer);
        }
        let before = self.desktop.frontmost_app();
        let answer = dialog();
        if let Some(before) = before {
            if self.desktop.frontmost_app().map(|app| app.pid) != Some(before.pid) {
                self.desktop.activate(before.pid);
            }
        }
        Ok(answer)
    }

    fn still_running(&self, epoch: u64) -> Result<(), String> {
        if self.control.epoch() != epoch || !self.control.is_active(self.clock.now_ms()) {
            return Err(STOPPED.into());
        }
        Ok(())
    }

    fn post(&self, epoch: u64, event: InputEvent) -> Result<(), String> {
        self.still_running(epoch)?;
        self.desktop.post(&event)
    }

    fn refuse_blocked(&self, app: &AppIdentity) -> Result<(), String> {
        match blocked_reason(app, self.own_pid) {
            Some(label) => Err(format!("Gentle Dot does not control {label}. The action was refused.")),
            None => Ok(()),
        }
    }

    /// The app owning the window under `at`, refused when blocked or unknown. Its name, for messages.
    /// Global mode skips this lookup on purpose (T2, S5): without per-app attribution the
    /// desktop itself is the only target it may name.
    fn pointer_target(&self, at: Point) -> Result<String, String> {
        if self.policy == BackendPolicy::DesktopGlobal {
            let _ = at;
            return Ok(GLOBAL_TARGET.into());
        }
        let app = self.desktop.window_owner_at(at).ok_or(UNKNOWN_TARGET)?;
        self.refuse_blocked(&app).map(|()| app.name)
    }

    /// The frontmost app and the app owning the focused element (they differ for a
    /// non-activating panel), each refused when blocked. The one receiving the keys, for messages.
    /// Global mode skips both lookups on purpose (T2, S5): keys go to the desktop as a whole.
    fn keyboard_target(&self) -> Result<String, String> {
        if self.policy == BackendPolicy::DesktopGlobal {
            return Ok(GLOBAL_TARGET.into());
        }
        let front = self.desktop.frontmost_app().ok_or("Cannot tell which app is in front.")?;
        self.refuse_blocked(&front)?;
        match self.desktop.focused_app().filter(|focused| focused.pid != front.pid) {
            Some(focused) => self.refuse_blocked(&focused).map(|()| focused.name),
            None => Ok(front.name),
        }
    }

    fn confirm_if_risky(&self, risk: Option<String>, action: &str, target: &str) -> Result<(), String> {
        // Ask only for a risk the caller actually detected (S9). Global mode cannot classify a
        // target, and inventing a reason from that unknown made ordinary input ask per action;
        // the session grant covers ordinary input, and this step covers detected risk only.
        // Yolo still skips only this step; grant, Stop, and expiry live outside it.
        let Some(reason) = risk else {
            return Ok(());
        };
        // Yolo mode (S24.9), switched on by the user in the app, skips only this confirmation.
        if self.control.yolo(self.clock.now_ms()) {
            return Ok(());
        }
        let message = format!("{action} in {target}.\n\nThis needs your OK because of {reason}.");
        if self.with_dialog(|| self.dialogs.confirm(&message))? {
            Ok(())
        } else {
            Err(format!("The user declined: {action} in {target}. Nothing was done."))
        }
    }

    /// The keyboard target this request is bound to: the external window observed with the
    /// latest screenshot. Deliberately NOT the window focused now, so a focus that moved after
    /// the screenshot is caught as a mismatch instead of silently becoming the target. Targeted
    /// policy keeps its own path (`Ok(None)`).
    fn keyboard_focus(&self, latest: &Option<Snapshot>) -> Result<Option<FocusTarget>, String> {
        if self.policy != BackendPolicy::DesktopGlobal {
            return Ok(None);
        }
        let snapshot = latest.as_ref().ok_or_else(|| NO_KEYBOARD_SNAPSHOT.to_string())?;
        match &snapshot.keyboard {
            KeyboardBinding::Bound(window) => {
                // The capture already validated this window; re-check the same rule so a target
                // that became unusable can never receive input.
                self.usable_focus(window)?;
                Ok(Some(window.clone()))
            }
            KeyboardBinding::Refused(refusal) => Err(refusal.message().to_string()),
        }
    }

    /// Whether `window` may receive keyboard input: never Gentle Dot's own window (by pid,
    /// never by name or app id), and never a window whose owner is absent or non-positive
    /// (pid 0 or negative is not a real process).
    fn usable_focus(&self, window: &FocusTarget) -> Result<(), String> {
        usable_owner(window.pid, self.own_pid).map_err(|refusal| refusal.message().to_string())
    }

    /// Global mode: why the focus is no longer the exact window this action captured, or
    /// `Ok(())`. The window id and the captured owner pid must both still match, so an id
    /// reused by another process never silently passes. Every cause names the window the last
    /// screenshot bound and, when it is known, the window focused now, so a refusal reads as a
    /// cause instead of bad luck (T22, S4); the reason stays neutral because a caller may
    /// already have posted some events.
    fn focus_mismatch(&self, focus: &FocusTarget) -> Result<(), String> {
        let bound = window_label(focus);
        match self.desktop.focused_window() {
            Ok(Some(window)) if window.window_id == focus.window_id => match (window.pid, focus.pid) {
                (Some(now), Some(captured)) if now == captured => self.usable_focus(&window),
                _ => Err(format!(
                    "{FOCUS_OWNER_CHANGED}: the last screenshot bound {bound}, and the focused window now is {}",
                    window_label(&window)
                )),
            },
            Ok(Some(window)) => Err(format!(
                "{FOCUS_MOVED_REASON}: the last screenshot bound {bound}, and the focused window now is {}",
                window_label(&window)
            )),
            Ok(None) => Err(format!(
                "{FOCUS_LOST_REASON}: the last screenshot bound {bound}, and no window is focused now"
            )),
            Err(error) => Err(format!(
                "{FOCUS_LOST_REASON} ({error}): the last screenshot bound {bound}, so the focused window now is unknown"
            )),
        }
    }

    /// Validates the captured target immediately before one post. `sent` is how many events
    /// of this action were already delivered, so a partial delivery is reported truthfully
    /// instead of claiming that nothing happened. The check and the post are separate IPC
    /// calls, so a focus that moves between them is not pinned by the compositor.
    fn check_target_before_post(
        &self,
        focus: Option<&FocusTarget>,
        target: &str,
        sent: usize,
    ) -> Result<(), String> {
        let Some(focus) = focus else { return Ok(()) };
        if let Err(reason) = self.focus_mismatch(focus) {
            return Err(if sent == 0 {
                format!("Nothing was sent in {target}: {reason}. Click the window you want and try again.")
            } else {
                format!(
                    "{sent} keyboard event(s) were sent in {target}, then the input stopped: {reason}. \
The rest was not sent; click the window you want and try again."
                )
            });
        }
        Ok(())
    }

    /// The success line for a posted input. Global mode may claim delivery only: it has no
    /// signal that the screen changed, and never verifies that text appeared. Targeted mode
    /// keeps its exact wording.
    fn global_claim(&self, done: String) -> String {
        if self.policy == BackendPolicy::DesktopGlobal {
            format!("{done} The input was delivered; the screen was not verified.")
        } else {
            done
        }
    }

    /// What the compositor says about the keyboard focus right now (T16, S4/S5). The outcome
    /// stays distinguishable so a capture can name the cause it bound nothing, and so the
    /// screenshot metadata can stay `null` when the observation did not succeed. Best effort: a
    /// capture still returns without a keyboard target rather than failing the screenshot.
    fn observe_keyboard_focus(&self) -> FocusObservation {
        if self.policy != BackendPolicy::DesktopGlobal {
            return FocusObservation::NoWindow;
        }
        match self.desktop.focused_window() {
            Ok(Some(window)) => FocusObservation::Window(window),
            Ok(None) => FocusObservation::NoWindow,
            Err(_) => FocusObservation::Failed,
        }
    }

    fn screenshot(&self, latest: &mut Option<Snapshot>) -> Result<Content, String> {
        // Observe the keyboard target around the capture: the same usable external window before
        // and after, or the cause none could be bound. A focus that moves while the image is
        // taken, an unknown or own window, and a failed query all leave the keyboard target
        // unavailable instead of guessing one; the screenshot itself is still returned.
        let before = self.observe_keyboard_focus();
        let capture = self.desktop.capture()?;
        let after = self.observe_keyboard_focus();
        let keyboard = bind_keyboard_target(&before, &after, self.own_pid);
        *latest = Some(Snapshot { geometry: capture.geometry, keyboard });
        // Targeted mode names the frontmost app, exactly as before. Global mode cannot attribute
        // an app, so it repeats no backend "frontmost"; it names the focused window's app id from
        // the same observation that decided the keyboard target, and stays null when that
        // observation failed or named no id (T16, S4).
        let front = match self.policy {
            BackendPolicy::Targeted => self.desktop.frontmost_app().map(|app| app.name),
            BackendPolicy::DesktopGlobal => after.app_id().map(str::to_owned),
        };
        let meta = json!({
            "imageWidth": capture.geometry.image_width,
            "imageHeight": capture.geometry.image_height,
            "scale": capture.geometry.scale,
            "frontApp": front,
        });
        let data = base64::engine::general_purpose::STANDARD.encode(&capture.data);
        Ok(vec![json!({"type": "image", "data": data, "mimeType": capture.mime_type}), text(meta.to_string())])
    }

    /// What was done, then a fresh screenshot once the screen settled.
    fn after(&self, latest: &mut Option<Snapshot>, done: String, settle_ms: u64) -> Result<Content, String> {
        self.clock.sleep_ms(settle_ms);
        let mut content = vec![text(done)];
        match self.screenshot(latest) {
            Ok(blocks) => content.extend(blocks),
            Err(error) => content.push(text(format!("No screenshot: {error}"))),
        }
        Ok(content)
    }

    fn act(&self, epoch: u64, latest: &mut Option<Snapshot>, call: Call) -> Result<Content, Failed> {
        match call.tool {
            Tool::Screenshot => Ok(self.screenshot(latest)?),
            Tool::ListApps => {
                let apps = self.desktop.list_apps()?;
                Ok(vec![text(serde_json::to_string(&apps).map_err(|e| e.to_string())?)])
            }
            Tool::Batch { steps } => self.batch(epoch, latest, steps, call.intent.as_deref()),
            tool => {
                let (done, settle_ms) = self.perform(epoch, latest, tool, call.intent.as_deref())?;
                Ok(self.after(latest, done, settle_ms)?)
            }
        }
    }

    /// Runs a batch's steps in order, then one screenshot. On the first failure it stops and
    /// reports the steps that ran, with a fresh screenshot while the session lasts.
    fn batch(
        &self,
        epoch: u64,
        latest: &mut Option<Snapshot>,
        steps: Vec<(&'static str, Call)>,
        intent: Option<&str>,
    ) -> Result<Content, Failed> {
        let total = steps.len();
        let mut done: Vec<String> = Vec::new();
        let mut settle_ms = 0;
        for (i, (name, step)) in steps.into_iter().enumerate() {
            if i > 0 {
                // An app that is opening needs its full wait before anything targets it.
                self.clock.sleep_ms(if settle_ms == OPEN_APP_SETTLE_MS { settle_ms } else { STEP_PAUSE_MS });
            }
            // The batch's intent applies to every step, on top of the step's own.
            let intents: Vec<&str> = [intent, step.intent.as_deref()].into_iter().flatten().collect();
            let intents = (!intents.is_empty()).then(|| intents.join("; "));
            let outcome =
                self.pace(epoch).and_then(|()| self.perform(epoch, latest, step.tool, intents.as_deref()));
            match outcome {
                Ok((message, step_settle_ms)) => {
                    done.push(format!("{}. {message}", i + 1));
                    settle_ms = step_settle_ms;
                }
                Err(error) => {
                    let ran = done.len();
                    let at = i + 1;
                    let mut message = format!("Stopped at step {at} of {total} ({name}): {error}\nRan {ran} of {total} steps");
                    message.push_str(if ran == 0 { "." } else { ":\n" });
                    message.push_str(&done.join("\n"));
                    if self.still_running(epoch).is_err() {
                        return Err(Failed(vec![text(message)]));
                    }
                    return Err(Failed(self.after(latest, message, settle_ms.max(SETTLE_MS))?));
                }
            }
        }
        let summary = format!("Ran {total} of {total} steps:\n{}", done.join("\n"));
        Ok(self.after(latest, summary, settle_ms)?)
    }

    /// Counts one batch step against the rate limit, waiting for room instead of refusing.
    fn pace(&self, epoch: u64) -> Result<(), String> {
        loop {
            self.still_running(epoch)?;
            let wait_ms = {
                let mut limiter = lock(&self.limiter);
                let now = self.clock.now_ms();
                if limiter.try_acquire(now) {
                    return Ok(());
                }
                limiter.wait_ms(now)
            };
            self.clock.sleep_ms(wait_ms.clamp(1, WAIT_SLICE_MS));
        }
    }

    /// One action through every guard, then posted: what was done and how long the screen
    /// needs to settle before a screenshot. A single call and a batch step both come here.
    fn perform(
        &self,
        epoch: u64,
        latest: &Option<Snapshot>,
        tool: Tool,
        intent: Option<&str>,
    ) -> Result<(String, u64), String> {
        let map = |latest: &Option<Snapshot>, (x, y): (f64, f64)| -> Result<Point, String> {
            latest.as_ref().ok_or(NEEDS_SCREENSHOT)?.geometry.to_point(x, y).map_err(|e| e.to_string())
        };
        match tool {
            Tool::Screenshot | Tool::ListApps | Tool::Batch { .. } => Err("Not an action.".into()),
            Tool::Click { x, y, button, count } => {
                let at = map(latest, (x, y))?;
                let target = self.pointer_target(at)?;
                let chain = self.desktop.element_at(at);
                let action = match (button, count) {
                    (MouseButton::Right, _) => format!("Right-click at ({x}, {y})"),
                    (_, 2) => format!("Double-click at ({x}, {y})"),
                    (_, 3) => format!("Triple-click at ({x}, {y})"),
                    _ => format!("Click at ({x}, {y})"),
                };
                self.confirm_if_risky(assess(Act::Click(&chain), intent), &action, &target)?;
                self.post(epoch, InputEvent::Click { at, button, count })?;
                (self.glow)(Mark::Click(at));
                Ok((self.global_claim(format!("{action} in {target}: done.")), SETTLE_MS))
            }
            Tool::Move { x, y } => {
                let at = map(latest, (x, y))?;
                let target = self.pointer_target(at)?;
                let action = format!("Move the pointer to ({x}, {y})");
                self.confirm_if_risky(assess(Act::Other, intent), &action, &target)?;
                self.post(epoch, InputEvent::Move(at))?;
                (self.glow)(Mark::Move(at));
                Ok((self.global_claim(format!("{action}: done.")), SETTLE_MS))
            }
            Tool::Drag { from, to } => {
                let (start, end) = (map(latest, from)?, map(latest, to)?);
                let source = self.pointer_target(start)?;
                let destination = self.pointer_target(end)?;
                let action = format!("Drag from ({}, {}) to ({}, {})", from.0, from.1, to.0, to.1);
                let target = if source == destination { source } else { format!("{source} and {destination}") };
                let (from_chain, to_chain) = (self.desktop.element_at(start), self.desktop.element_at(end));
                self.confirm_if_risky(assess(Act::Drag(&from_chain, &to_chain), intent), &action, &target)?;
                self.post(epoch, InputEvent::Drag { from: start, to: end })?;
                (self.glow)(Mark::Drag { from: start, to: end });
                Ok((self.global_claim(format!("{action}: done.")), SETTLE_MS))
            }
            Tool::Scroll { x, y, dx, dy } => {
                let at = map(latest, (x, y))?;
                let target = self.pointer_target(at)?;
                let action = format!("Scroll by ({dx}, {dy}) at ({x}, {y})");
                self.confirm_if_risky(assess(Act::Other, intent), &action, &target)?;
                self.post(epoch, InputEvent::Scroll { at, dx, dy })?;
                (self.glow)(Mark::Scroll(at));
                Ok((self.global_claim(format!("{action}: done.")), SETTLE_MS))
            }
            Tool::Type { text: typed } => {
                let target = self.keyboard_target()?;
                let focus = self.keyboard_focus(latest)?;
                let typed = typed.replace("\r\n", "\n").replace('\r', "\n");
                let element = self.desktop.focused_element();
                let action = format!("Type {} characters", typed.chars().count());
                // Refuse before prompting when the focus already left the screenshot's target.
                self.check_target_before_post(focus.as_ref(), &target, 0)?;
                self.confirm_if_risky(assess(Act::Type(&typed, element.as_ref()), intent), &action, &target)?;
                let return_key = parse_combo("return")?;
                // Every synthesized Return and every text chunk is re-checked against the
                // SAME screenshot-bound window immediately before it is posted, so a focus that
                // moves mid-typing stops the rest instead of sending it to the wrong window.
                let mut sent = 0usize;
                for (i, line) in typed.split('\n').enumerate() {
                    if i > 0 {
                        self.check_target_before_post(focus.as_ref(), &target, sent)?;
                        self.post(epoch, InputEvent::Key(return_key))?;
                        sent += 1;
                    }
                    for chunk in chunks(line) {
                        self.check_target_before_post(focus.as_ref(), &target, sent)?;
                        self.post(epoch, InputEvent::Text(chunk))?;
                        sent += 1;
                    }
                }
                // The glow marks posted input only; an empty text posts none.
                if !typed.is_empty() {
                    (self.glow)(Mark::Key);
                }
                Ok((self.global_claim(format!("{action} in {target}: done.")), SETTLE_MS))
            }
            Tool::Key { combo } => {
                let target = self.keyboard_target()?;
                let focus = self.keyboard_focus(latest)?;
                let element = self.desktop.focused_element();
                let act = if combo.is_return() {
                    Act::Return(element.as_ref())
                } else if combo.is_space() {
                    Act::Space(element.as_ref())
                } else {
                    Act::Other
                };
                let action = format!("Press {}", combo.spelling());
                self.check_target_before_post(focus.as_ref(), &target, 0)?;
                self.confirm_if_risky(assess(act, intent), &action, &target)?;
                self.check_target_before_post(focus.as_ref(), &target, 0)?;
                self.post(epoch, InputEvent::Key(combo))?;
                (self.glow)(Mark::Key);
                Ok((self.global_claim(format!("{action} in {target}: done.")), SETTLE_MS))
            }
            Tool::OpenApp { name } => {
                // No blocklist exists to check against in global mode (T2, S5); the grant,
                // the confirmation below, and Stop still apply.
                if self.policy == BackendPolicy::Targeted {
                    if let Some(label) = blocked_name(&name) {
                        return Err(format!("Gentle Dot does not control {label}. The app was not opened."));
                    }
                }
                let action = format!("Open {name}");
                let target = match self.policy {
                    BackendPolicy::Targeted => "macOS",
                    BackendPolicy::DesktopGlobal => GLOBAL_TARGET,
                };
                self.confirm_if_risky(assess(Act::Other, intent), &action, target)?;
                self.still_running(epoch)?;
                self.desktop.open_app(&name)?;
                // On Linux the launcher only accepts the request; it never confirms a window or
                // focus, so the acknowledgement must not read like a verified open (S7).
                let done = match self.policy {
                    BackendPolicy::Targeted => format!("{action}: done."),
                    BackendPolicy::DesktopGlobal => format!(
                        "{action}: the launcher accepted the request; no window or focus was verified."
                    ),
                };
                Ok((done, OPEN_APP_SETTLE_MS))
            }
            Tool::Wait { ms } => {
                let mut left = ms;
                while left > 0 {
                    let slice = left.min(WAIT_SLICE_MS);
                    self.clock.sleep_ms(slice);
                    left -= slice;
                    self.still_running(epoch)?;
                }
                Ok((format!("Waited {ms} ms."), 0))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::blocklist::AppIdentity;
    use super::super::coords::Point;
    use super::super::fake::{app, FakeClock, FakeDesktop, FakeDialogs};
    use super::super::glow::Mark;
    use super::super::keys::parse_combo;
    use super::super::risk::{AxElement, Focus};
    use super::super::session::{Reason, StateEvent, SESSION_MS};
    use super::super::{InputEvent, MouseButton};
    use super::super::FocusTarget;
    use super::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;

    const TOKEN: &str = "secret-token";
    const OWN_PID: i32 = 4242;
    const NOW: u64 = 1_700_000_000_000;

    struct Rig {
        helper: Helper,
        desktop: Arc<FakeDesktop>,
        dialogs: Arc<FakeDialogs>,
        clock: Arc<FakeClock>,
        control: Arc<Control>,
        states: Arc<Mutex<Vec<StateEvent>>>,
        /// Each glow mark (S28), with how many input events were posted when it came.
        marks: Arc<Mutex<Vec<(Mark, usize)>>>,
        working: Arc<FakeWorking>,
    }

    /// What a step of the working rings saw: screenshots taken and input events posted so far.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Step {
        Begin { captures: usize, events: usize },
        Finish { captures: usize, events: usize },
    }

    /// Records each preparation (S1, S5); can fail it, or run something while it is under way.
    struct FakeWorking {
        desktop: Arc<FakeDesktop>,
        steps: Mutex<Vec<Step>>,
        fails: Mutex<Option<String>>,
        during: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    impl FakeWorking {
        fn seen(&self) -> (usize, usize) {
            (self.desktop.captures.load(Ordering::SeqCst), self.desktop.events().len())
        }
    }

    impl Preparation for FakeWorking {
        fn begin(&self) -> Result<u64, String> {
            let (captures, events) = self.seen();
            self.steps.lock().unwrap().push(Step::Begin { captures, events });
            if let Some(during) = self.during.lock().unwrap().as_ref() {
                during();
            }
            match self.fails.lock().unwrap().clone() {
                Some(error) => Err(error),
                None => Ok(7),
            }
        }

        fn finish(&self, operation: u64) {
            assert_eq!(operation, 7);
            let (captures, events) = self.seen();
            self.steps.lock().unwrap().push(Step::Finish { captures, events });
        }
    }

    fn rig_with(allow: bool, confirm: bool) -> Rig {
        rig_with_policy(allow, confirm, BackendPolicy::Targeted)
    }

    fn rig_with_policy(allow: bool, confirm: bool, policy: BackendPolicy) -> Rig {
        let desktop = Arc::new(FakeDesktop::default());
        let dialogs = Arc::new(FakeDialogs::new(allow, confirm));
        let clock = Arc::new(FakeClock::new(NOW));
        let states = Arc::new(Mutex::new(Vec::new()));
        let sink = states.clone();
        let control = Arc::new(Control::new(move |event| sink.lock().unwrap().push(event.clone())));
        let marks = Arc::new(Mutex::new(Vec::new()));
        let (seen, posted) = (marks.clone(), desktop.clone());
        let working = Arc::new(FakeWorking {
            desktop: desktop.clone(),
            steps: Mutex::new(Vec::new()),
            fails: Mutex::new(None),
            during: Mutex::new(None),
        });
        let helper =
            Helper::new(desktop.clone(), dialogs.clone(), clock.clone(), control.clone(), TOKEN.into(), OWN_PID)
                .with_glow(move |mark| seen.lock().unwrap().push((mark, posted.events().len())))
                .with_working(working.clone())
                .with_policy(policy);
        Rig { helper, desktop, dialogs, clock, control, states, marks, working }
    }

    /// A rig whose helper has no glow sink and no working rings, as before S28.
    fn rig_without_glow(allow: bool, confirm: bool) -> Rig {
        let rig = rig_with(allow, confirm);
        let helper = Helper::new(
            rig.desktop.clone(),
            rig.dialogs.clone(),
            rig.clock.clone(),
            rig.control.clone(),
            TOKEN.into(),
            OWN_PID,
        );
        Rig { helper, ..rig }
    }

    fn rig() -> Rig {
        rig_with(true, true)
    }

    fn post(rig: &Rig, authorization: Option<&str>, body: &str) -> HttpReply {
        rig.helper.handle(&HttpRequest { method: "POST", path: "/mcp", authorization, body })
    }

    impl Rig {
        fn rpc(&self, method: &str, params: Value) -> Value {
            let body = json!({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}).to_string();
            let reply = post(self, Some(&format!("Bearer {TOKEN}")), &body);
            assert_eq!(reply.status, 200, "{reply:?}");
            let body = reply.body.expect("a JSON-RPC reply");
            assert_eq!((body["jsonrpc"].as_str(), body["id"].as_i64()), (Some("2.0"), Some(7)));
            body
        }

        fn call(&self, name: &str, arguments: Value) -> Value {
            let body = self.rpc("tools/call", json!({"name": name, "arguments": arguments}));
            body["result"].clone()
        }

        /// Grants a session and takes the screenshot that coordinates refer to.
        fn ready(&self) {
            assert!(!is_error(&self.call("screenshot", json!({}))));
        }
    }

    fn is_error(result: &Value) -> bool {
        result["isError"] == json!(true)
    }

    fn first_text(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    fn safari() -> AppIdentity {
        app(200, "com.apple.Safari", "Safari")
    }

    // --- HTTP and JSON-RPC ---

    #[test]
    fn requests_without_the_bearer_token_get_401() {
        let rig = rig();
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
        for authorization in [None, Some("Bearer wrong"), Some(TOKEN), Some("Basic secret-token")] {
            let reply = post(&rig, authorization, &body);
            assert_eq!(reply.status, 401, "{authorization:?}");
        }
        assert_eq!(post(&rig, Some("Bearer secret-token"), &body).status, 200);
    }

    #[test]
    fn only_post_to_mcp_is_served() {
        let rig = rig();
        let auth = Some("Bearer secret-token");
        let get = rig.helper.handle(&HttpRequest { method: "GET", path: "/mcp", authorization: auth, body: "" });
        assert_eq!(get.status, 405);
        let other = rig.helper.handle(&HttpRequest { method: "POST", path: "/other", authorization: auth, body: "{}" });
        assert_eq!(other.status, 404);
    }

    #[test]
    fn initialize_reports_the_server_and_tools_capability() {
        let rig = rig();
        let body = rig.rpc("initialize", json!({"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}));
        let result = &body["result"];
        assert_eq!(result["protocolVersion"], "2025-03-26");
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["serverInfo"]["name"], "gentle-dot-computer");
    }

    #[test]
    fn initialize_answers_an_unknown_protocol_version_with_its_own() {
        let rig = rig();
        let body = rig.rpc("initialize", json!({"protocolVersion": "1999-01-01"}));
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn notifications_are_accepted_without_a_body() {
        let rig = rig();
        let body = json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string();
        assert_eq!(post(&rig, Some("Bearer secret-token"), &body), HttpReply { status: 202, body: None });
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let reply = post(&rig(), Some("Bearer secret-token"), "{not json");
        assert_eq!(reply.status, 400);
        assert_eq!(reply.body.unwrap()["error"]["code"], -32700);
    }

    #[test]
    fn unknown_methods_are_rejected() {
        let body = rig().rpc("resources/list", json!({}));
        assert_eq!(body["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_describes_every_tool_with_an_input_schema() {
        let body = rig().rpc("tools/list", json!({}));
        let tools = body["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["screenshot", "click", "move", "drag", "scroll", "type", "key", "open_app", "list_apps", "wait", "batch"]
        );
        for tool in tools {
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object", "{tool}");
            assert_eq!(schema["properties"]["intent"]["type"], "string", "{tool}");
            assert!(tool["description"].as_str().is_some_and(|d| !d.is_empty()));
        }
        let click = tools.iter().find(|t| t["name"] == "click").unwrap();
        assert_eq!(click["inputSchema"]["required"], json!(["x", "y"]));
        assert_eq!(click["inputSchema"]["properties"]["button"]["enum"], json!(["left", "right"]));
        // The shared catalog keeps the macOS wording, unchanged by the Linux focus work.
        assert_eq!(
            tools.iter().find(|t| t["name"] == "type").unwrap()["description"],
            "Type text into the frontmost app. A newline presses Return."
        );
        assert_eq!(
            tools.iter().find(|t| t["name"] == "key").unwrap()["description"],
            "Press a key combo in the frontmost app, for example `cmd+shift+t`, `return`, or `esc`."
        );
        let wait = tools.iter().find(|t| t["name"] == "wait").unwrap();
        assert_eq!(wait["inputSchema"]["properties"]["ms"]["maximum"], 5000);
    }

    #[test]
    fn scroll_schema_requires_only_dy_and_names_the_linux_tick_cap() {
        // A purely vertical scroll must not need `dx`: it stays out of `required` and
        // defaults to 0. The macOS catalog keeps its wording; the desktop-global one names
        // the Linux per-operation cap so the agent can split a longer gesture itself.
        let mac = rig().rpc("tools/list", json!({}));
        let mac = mac["result"]["tools"].as_array().unwrap();
        let scroll = mac.iter().find(|t| t["name"] == "scroll").unwrap();
        assert_eq!(scroll["inputSchema"]["required"], json!(["x", "y", "dy"]));
        let description = scroll["description"].as_str().unwrap();
        assert!(description.contains("`dy` is required"), "{description}");
        assert!(description.contains("optional"), "{description}");
        let properties = &scroll["inputSchema"]["properties"];
        assert!(properties["dx"]["description"].as_str().unwrap().to_lowercase().contains("optional"));
        assert!(properties["dx"]["description"].as_str().unwrap().contains("0"));
        assert!(properties["dy"]["description"].as_str().unwrap().to_lowercase().contains("required"));
        // macOS wording for the launch and inventory tools stays exactly as it was.
        assert_eq!(
            mac.iter().find(|t| t["name"] == "open_app").unwrap()["description"],
            "Open or bring forward an app by name or bundle id."
        );
        assert_eq!(
            mac.iter().find(|t| t["name"] == "list_apps").unwrap()["description"],
            "List the running apps."
        );

        let global = global_rig_with(true, true).rpc("tools/list", json!({}));
        let global = global["result"]["tools"].as_array().unwrap();
        let scroll = global.iter().find(|t| t["name"] == "scroll").unwrap();
        assert_eq!(scroll["inputSchema"]["required"], json!(["x", "y", "dy"]));
        let description = scroll["description"].as_str().unwrap();
        assert!(description.contains("120"), "{description}");
        assert!(description.contains("split"), "{description}");
    }

    /// The catalog advertises the same cap the Linux backend enforces; if either moves alone
    /// the agent would plan around a number that is not real.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_catalog_tick_cap_matches_the_linux_backend() {
        assert_eq!(LINUX_MAX_SCROLL_TICKS, super::super::linux::pointer::MAX_SCROLL_TICKS);
    }

    #[test]
    fn a_scroll_without_dx_defaults_to_zero_and_stays_vertical() {
        assert!(
            matches!(
                parse_call("scroll", &json!({"x": 1, "y": 2, "dy": 10})),
                Some(Ok(Call { tool: Tool::Scroll { dx: 0, dy: 10, .. }, .. }))
            ),
            "a missing dx must default to 0 instead of refusing the call"
        );
        let rig = rig();
        rig.ready();
        assert!(!is_error(&rig.call("scroll", json!({"x": 5, "y": 6, "dy": 10}))));
        // The fake desktop sees one vertical scroll: dx is 0, so no horizontal axis is touched.
        assert_eq!(
            rig.desktop.events(),
            vec![InputEvent::Scroll { at: Point { x: 10.0, y: 12.0 }, dx: 0, dy: 10 }]
        );
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error() {
        let rig = rig();
        let body = rig.rpc("tools/call", json!({"name": "format_disk", "arguments": {}}));
        assert_eq!(body["error"]["code"], -32602);
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 0);
    }

    // --- Session grant (S24.3) ---

    #[test]
    fn deny_returns_a_tool_error_and_starts_nothing() {
        let rig = rig_with(false, true);
        let result = rig.call("screenshot", json!({}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("not allowed"), "{result}");
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 0);
        assert!(rig.states.lock().unwrap().is_empty());
        assert!(!rig.control.is_active(NOW));
    }

    #[test]
    fn allow_starts_a_session_once_and_reports_it() {
        let rig = rig();
        rig.ready();
        rig.ready();
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
        assert_eq!(
            *rig.states.lock().unwrap(),
            vec![StateEvent {
                active: true,
                ends_at: Some(NOW + SESSION_MS),
                reason: Some(Reason::Granted),
                ..StateEvent::default()
            }]
        );
    }

    #[test]
    fn after_the_timeout_the_next_call_asks_again() {
        let rig = rig();
        rig.ready();
        rig.clock.advance(SESSION_MS);
        rig.ready();
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn after_a_stop_the_next_call_asks_again() {
        let rig = rig();
        rig.ready();
        rig.control.end(Reason::Panic);
        rig.ready();
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn an_action_queued_before_a_stop_is_dropped() {
        let rig = rig();
        rig.ready();
        let queued_at = rig.control.epoch();
        rig.control.end(Reason::Stopped);
        let result = rig.helper.call_tool_from(queued_at, "click", &json!({"x": 10, "y": 10})).unwrap();
        assert!(is_error(&result));
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert!(rig.desktop.events().is_empty());
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_stop_during_wait_ends_it_early() {
        let rig = rig();
        rig.ready();
        let control = rig.control.clone();
        *rig.clock.on_sleep.lock().unwrap() = Some(Box::new(move || control.end(Reason::Panic)));
        let result = rig.call("wait", json!({"ms": 3000}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert!(rig.clock.now_ms() - NOW < 3000);
    }

    // --- Screenshots and coordinates (S24.2) ---

    #[test]
    fn a_screenshot_is_an_image_block_plus_its_geometry() {
        let rig = rig();
        let result = rig.call("screenshot", json!({}));
        let content = result["content"].as_array().unwrap();
        let image = content.iter().find(|c| c["type"] == "image").unwrap();
        assert_eq!(image["mimeType"], "image/jpeg");
        assert_eq!(image["data"], "anBlZw==");
        let meta = content.iter().rfind(|c| c["type"] == "text").unwrap();
        let meta: Value = serde_json::from_str(meta["text"].as_str().unwrap()).unwrap();
        assert_eq!(meta, json!({"imageWidth": 1280, "imageHeight": 800, "scale": 0.5, "frontApp": "Safari"}));
    }

    #[test]
    fn coordinates_need_a_screenshot_first() {
        let rig = rig();
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_new_session_needs_a_new_screenshot() {
        for end in ["stop", "timeout"] {
            let rig = rig();
            rig.ready();
            match end {
                "stop" => rig.control.end(Reason::Stopped),
                _ => rig.clock.advance(SESSION_MS),
            }
            let result = rig.call("click", json!({"x": 10, "y": 10}));
            assert!(is_error(&result), "{end}");
            assert!(first_text(&result).contains("screenshot"), "{result}");
            // The grant comes first; only then is the missing screenshot reported.
            assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 2, "{end}");
            assert!(rig.desktop.events().is_empty());
            rig.ready();
            assert!(!is_error(&rig.call("click", json!({"x": 10, "y": 10}))));
        }
    }

    #[test]
    fn click_maps_pixels_to_points_and_returns_a_fresh_screenshot() {
        let rig = rig();
        rig.ready();
        let result = rig.call("click", json!({"x": 100, "y": 50, "button": "right", "count": 2}));
        assert!(!is_error(&result), "{result}");
        let at = Point { x: 200.0, y: 100.0 };
        assert_eq!(rig.desktop.events(), vec![InputEvent::Click { at, button: MouseButton::Right, count: 2 }]);
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 2);
        assert!(result["content"].as_array().unwrap().iter().any(|c| c["type"] == "image"));
    }

    #[test]
    fn move_drag_and_scroll_map_their_points() {
        let rig = rig();
        rig.ready();
        rig.call("move", json!({"x": 1, "y": 2}));
        rig.call("drag", json!({"fromX": 10, "fromY": 20, "toX": 30, "toY": 40}));
        rig.call("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 120}));
        let p = |x, y| Point { x, y };
        assert_eq!(
            rig.desktop.events(),
            vec![
                InputEvent::Move(p(2.0, 4.0)),
                InputEvent::Drag { from: p(20.0, 40.0), to: p(60.0, 80.0) },
                InputEvent::Scroll { at: p(10.0, 12.0), dx: 0, dy: 120 },
            ]
        );
    }

    #[test]
    fn invalid_arguments_are_tool_errors() {
        let rig = rig();
        rig.ready();
        for (name, args) in [
            ("click", json!({"x": 1})),
            ("click", json!({"x": 1, "y": 1, "count": 4})),
            ("click", json!({"x": 1, "y": 1, "button": "middle"})),
            ("click", json!({"x": 5000, "y": 1})),
            ("wait", json!({"ms": 5001})),
            ("key", json!({"combo": "cmd+nope"})),
            ("type", json!({})),
        ] {
            let result = rig.call(name, args.clone());
            assert!(is_error(&result), "{name} {args}");
        }
        assert!(rig.desktop.events().is_empty());
    }

    // --- Permissions ---

    #[test]
    fn missing_permissions_are_explained_before_asking_for_a_session() {
        let rig = rig();
        rig.desktop.permissions.lock().unwrap().screen_recording = false;
        let result = rig.call("screenshot", json!({}));
        assert!(first_text(&result).contains("Screen Recording"), "{result}");
        rig.desktop.permissions.lock().unwrap().screen_recording = true;
        rig.desktop.permissions.lock().unwrap().accessibility = false;
        let result = rig.call("key", json!({"combo": "tab"}));
        assert!(first_text(&result).contains("Accessibility"), "{result}");
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn screenshots_before_macos_14_are_a_clear_error() {
        let rig = rig();
        rig.desktop.permissions.lock().unwrap().screenshots_supported = false;
        let result = rig.call("screenshot", json!({}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("macOS 14"), "{result}");
    }

    // --- Blocklist and rate limit (S24.4) ---

    #[test]
    fn pointer_actions_on_a_blocked_window_are_refused() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() =
            Box::new(|_| Some(app(300, "com.apple.systempreferences", "System Settings")));
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("System Settings"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_drag_onto_a_blocked_window_is_refused() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|at: Point| {
            if at.x > 100.0 {
                Some(app(301, "com.1password.1password", "1Password"))
            } else {
                Some(safari())
            }
        });
        let result = rig.call("drag", json!({"fromX": 10, "fromY": 10, "toX": 200, "toY": 10}));
        assert!(is_error(&result));
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn gentle_dot_own_windows_are_refused() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() =
            Box::new(|_| Some(AppIdentity { pid: OWN_PID, bundle_id: None, name: "gentle-dot".into() }));
        assert!(is_error(&rig.call("click", json!({"x": 10, "y": 10}))));
    }

    #[test]
    fn keyboard_actions_check_the_frontmost_app() {
        let rig = rig();
        rig.ready();
        *rig.desktop.frontmost.lock().unwrap() = Some(app(302, "com.apple.keychainaccess", "Keychain Access"));
        assert!(is_error(&rig.call("type", json!({"text": "hello"}))));
        assert!(is_error(&rig.call("key", json!({"combo": "cmd+a"}))));
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn keyboard_actions_check_the_focused_app_too() {
        let rig = rig();
        rig.ready();
        // A non-activating panel takes the keys while Safari stays frontmost.
        *rig.desktop.focused_app.lock().unwrap() = Some(app(303, "com.1password.1password", "1Password"));
        let result = rig.call("type", json!({"text": "hello"}));
        assert!(first_text(&result).contains("1Password"), "{result}");
        assert!(is_error(&rig.call("key", json!({"combo": "return"}))));
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn pointer_actions_where_no_app_owns_the_point_are_refused() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        for (name, args) in [
            ("click", json!({"x": 10, "y": 10})),
            ("move", json!({"x": 10, "y": 10})),
            ("scroll", json!({"x": 10, "y": 10, "dx": 0, "dy": 10})),
            ("drag", json!({"fromX": 10, "fromY": 10, "toX": 20, "toY": 20})),
        ] {
            let result = rig.call(name, args);
            assert!(is_error(&result), "{name}");
            assert!(first_text(&result).contains("which app"), "{result}");
        }
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn opening_a_blocked_app_is_refused() {
        let rig = rig();
        rig.ready();
        assert!(is_error(&rig.call("open_app", json!({"name": "Keychain Access"}))));
        assert!(!is_error(&rig.call("open_app", json!({"name": "com.apple.mail"}))));
        assert_eq!(*rig.desktop.opened.lock().unwrap(), vec!["com.apple.mail".to_string()]);
    }

    #[test]
    fn more_than_ten_calls_per_second_are_refused() {
        let rig = rig();
        for _ in 0..10 {
            assert!(!is_error(&rig.call("list_apps", json!({}))));
        }
        let result = rig.call("list_apps", json!({}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("10"), "{result}");
        rig.clock.advance(1000);
        assert!(!is_error(&rig.call("list_apps", json!({}))));
    }

    // --- Risky actions (S24.4) ---

    fn send_button() -> Vec<AxElement> {
        vec![AxElement { role: "AXButton".into(), title: Some("Send".into()), ..AxElement::default() }]
    }

    #[test]
    fn a_risky_click_needs_a_confirmation_showing_action_and_target() {
        let rig = rig();
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(!is_error(&result), "{result}");
        let asked = rig.dialogs.confirmations.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("Send") && asked[0].contains("Safari"), "{asked:?}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn a_declined_confirmation_is_a_tool_error_and_nothing_happens() {
        let rig = rig_with(true, false);
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("declined"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn harmless_actions_are_not_confirmed() {
        let rig = rig();
        rig.ready();
        rig.call("click", json!({"x": 10, "y": 10}));
        rig.call("key", json!({"combo": "cmd+t"}));
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        assert_eq!(rig.desktop.events().len(), 2);
    }

    #[test]
    fn a_drag_over_a_risky_button_is_confirmed() {
        let rig = rig_with(true, false);
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call("drag", json!({"fromX": 10, "fromY": 10, "toX": 10, "toY": 10}));
        assert!(first_text(&result).contains("declined"), "{result}");
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 1);
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn space_on_a_focused_send_button_is_confirmed() {
        let rig = rig_with(true, false);
        rig.ready();
        *rig.desktop.focus.lock().unwrap() = Some(Focus { element: send_button().remove(0), ..Focus::default() });
        assert!(is_error(&rig.call("key", json!({"combo": "space"}))));
        assert!(is_error(&rig.call("type", json!({"text": " "}))));
        assert!(rig.desktop.events().is_empty());
        assert!(!is_error(&rig.call("type", json!({"text": "ok"}))));
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 2);
    }

    #[test]
    fn return_in_a_send_like_field_is_confirmed() {
        let rig = rig_with(true, false);
        rig.ready();
        let composer = AxElement { role: "AXTextArea".into(), description: Some("Message".into()), ..AxElement::default() };
        *rig.desktop.focus.lock().unwrap() = Some(Focus { element: composer, ..Focus::default() });
        assert!(is_error(&rig.call("key", json!({"combo": "cmd+return"}))));
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_risky_intent_adds_a_confirmation() {
        let rig = rig();
        rig.ready();
        rig.call("scroll", json!({"x": 1, "y": 1, "dx": 0, "dy": 10, "intent": "buy the ticket"}));
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_previous_app_is_brought_back_after_a_dialog() {
        let rig = rig();
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        let frontmost = rig.desktop.clone();
        *rig.dialogs.during.lock().unwrap() = Some(Box::new(move || {
            *frontmost.frontmost.lock().unwrap() = Some(app(OWN_PID, "dev.gentleman.gentle-dot", "Gentle Dot"));
        }));
        rig.call("click", json!({"x": 10, "y": 10}));
        assert_eq!(*rig.desktop.activated.lock().unwrap(), vec![200]);
    }

    // --- Typing ---

    #[test]
    fn typing_sends_newlines_as_return_and_checks_them() {
        let rig = rig();
        rig.ready();
        let result = rig.call("type", json!({"text": "hi\nthere"}));
        assert!(!is_error(&result), "{result}");
        assert_eq!(
            rig.desktop.events(),
            vec![
                InputEvent::Text("hi".into()),
                InputEvent::Key(parse_combo("return").unwrap()),
                InputEvent::Text("there".into()),
            ]
        );
        // In a send-like field the newline needs a confirmation.
        let rig = rig_with(true, false);
        rig.ready();
        let composer = AxElement { role: "AXTextField".into(), title: Some("Reply".into()), ..AxElement::default() };
        *rig.desktop.focus.lock().unwrap() = Some(Focus { element: composer, ..Focus::default() });
        assert!(is_error(&rig.call("type", json!({"text": "ok\n"}))));
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn typing_control_characters_is_refused() {
        let rig = rig();
        rig.ready();
        for text in ["\u{1b}[A", "a\u{0}b", "\u{7f}", "\u{8}\u{8}"] {
            let result = rig.call("type", json!({"text": text}));
            assert!(is_error(&result), "{text:?}");
            assert!(first_text(&result).contains("control character"), "{result}");
        }
        assert!(rig.desktop.events().is_empty());
        assert!(!is_error(&rig.call("type", json!({"text": "a\tb"}))));
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("a\tb".into())]);
    }

    #[test]
    fn typing_unicode_line_breaks_is_refused() {
        let rig = rig();
        rig.ready();
        for text in ["a\u{2028}b", "a\u{2029}b", "a\u{85}b"] {
            let result = rig.call("type", json!({"text": text}));
            assert!(is_error(&result), "{text:?}");
            assert!(first_text(&result).contains("control character"), "{result}");
        }
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn typing_space_or_return_after_a_tab_is_refused() {
        // The tab may move the focus onto a send button the risk check never saw.
        let rig = rig();
        rig.ready();
        for text in ["hello\t ", "hello\t\n", "a\tb c"] {
            let result = rig.call("type", json!({"text": text}));
            assert!(is_error(&result), "{text:?}");
            assert!(first_text(&result).contains("after a tab"), "{result}");
        }
        assert!(rig.desktop.events().is_empty());
        assert!(!is_error(&rig.call("type", json!({"text": "a b\tc"}))));
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("a b\tc".into())]);
    }

    #[test]
    fn long_text_is_sent_in_chunks_of_twenty_utf16_units() {
        let rig = rig();
        rig.ready();
        let text = "ñ".repeat(25) + "😀";
        rig.call("type", json!({"text": text}));
        let chunks: Vec<String> = rig
            .desktop
            .events()
            .into_iter()
            .map(|e| match e {
                InputEvent::Text(t) => t,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|c| c.encode_utf16().count() <= 20), "{chunks:?}");
    }


    // --- Speed (S24.8) ---

    #[test]
    fn an_action_settles_150_ms_and_open_app_still_1500() {
        let rig = rig();
        rig.ready();
        let before = rig.clock.now_ms();
        rig.call("click", json!({"x": 10, "y": 10}));
        assert_eq!(rig.clock.now_ms() - before, 150);
        let before = rig.clock.now_ms();
        rig.call("open_app", json!({"name": "Mail"}));
        assert_eq!(rig.clock.now_ms() - before, 1500);
    }

    #[test]
    fn a_short_message_with_an_emoji_is_two_events_and_one_settle() {
        // L66: an 18 s `type` of this text. The helper's own share is two chunks (four
        // keyboard events, 15 ms apart on the Mac) plus one settle; no confirmation is asked.
        let rig = rig();
        rig.ready();
        let message = "¡Hola, Panda! Te quiero mucho ❤️";
        let before = rig.clock.now_ms();
        assert!(!is_error(&rig.call("type", json!({"text": message}))));
        assert_eq!(rig.clock.now_ms() - before, 150);
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        let events = rig.desktop.events();
        assert_eq!(events.len(), 2, "{events:?}");
        let typed: String = events
            .into_iter()
            .map(|e| match e {
                InputEvent::Text(t) => t,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(typed, message);
    }

    fn batch(steps: Value) -> Value {
        json!({"steps": steps})
    }

    fn image_count(result: &Value) -> usize {
        result["content"].as_array().map_or(0, |c| c.iter().filter(|b| b["type"] == "image").count())
    }

    #[test]
    fn tools_list_offers_batch_for_predictable_sequences() {
        let rig = rig();
        let body = rig.rpc("tools/list", json!({}));
        let tools = body["result"]["tools"].as_array().unwrap();
        let batch = tools.iter().find(|t| t["name"] == "batch").unwrap();
        let steps = &batch["inputSchema"]["properties"]["steps"];
        assert_eq!((steps["minItems"].as_u64(), steps["maxItems"].as_u64()), (Some(1), Some(20)));
        assert_eq!(
            steps["items"]["properties"]["tool"]["enum"],
            json!(["click", "move", "drag", "scroll", "type", "key", "open_app", "wait"])
        );
        assert!(batch["description"].as_str().unwrap().contains("screenshot"));
        let instructions = rig.rpc("initialize", json!({}))["result"]["instructions"].as_str().unwrap().to_string();
        assert!(instructions.contains("batch"), "{instructions}");
    }

    #[test]
    fn a_batch_runs_its_steps_in_order_and_returns_one_screenshot() {
        let rig = rig();
        rig.ready();
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "click", "x": 100, "y": 50},
                {"tool": "type", "text": "Ana"},
                {"tool": "key", "combo": "tab"},
                {"tool": "type", "text": "Hi there"},
                {"tool": "scroll", "x": 5, "y": 6, "dx": 0, "dy": 120},
            ])),
        );
        assert!(!is_error(&result), "{result}");
        let p = |x, y| Point { x, y };
        assert_eq!(
            rig.desktop.events(),
            vec![
                // Mapped with the screenshot taken before the batch (scale 0.5).
                InputEvent::Click { at: p(200.0, 100.0), button: MouseButton::Left, count: 1 },
                InputEvent::Text("Ana".into()),
                InputEvent::Key(parse_combo("tab").unwrap()),
                InputEvent::Text("Hi there".into()),
                InputEvent::Scroll { at: p(10.0, 12.0), dx: 0, dy: 120 },
            ]
        );
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 2);
        assert_eq!(image_count(&result), 1);
        let summary = first_text(&result);
        assert!(summary.contains("5 of 5") && summary.contains("Type 3 characters"), "{summary}");
    }

    #[test]
    fn a_risky_step_asks_once_and_a_decline_stops_the_batch_after_the_earlier_steps() {
        let rig = rig_with(true, false);
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "type", "text": "hi"},
                {"tool": "click", "x": 10, "y": 10},
                {"tool": "type", "text": "never"},
            ])),
        );
        assert!(is_error(&result));
        let message = first_text(&result);
        assert!(message.contains("declined") && message.contains("step 2"), "{message}");
        assert!(message.contains("1 of 3"), "{message}");
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 1);
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("hi".into())]);
        // A fresh screenshot shows where the batch stopped.
        assert_eq!(image_count(&result), 1);
    }

    #[test]
    fn a_blocklisted_step_stops_the_batch() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|at: Point| {
            if at.x > 100.0 {
                Some(app(300, "com.apple.systempreferences", "System Settings"))
            } else {
                Some(safari())
            }
        });
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "click", "x": 10, "y": 10},
                {"tool": "click", "x": 200, "y": 10},
                {"tool": "click", "x": 20, "y": 20},
            ])),
        );
        assert!(is_error(&result));
        assert!(first_text(&result).contains("System Settings"), "{result}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn a_panic_during_a_batch_drops_the_remaining_steps() {
        let rig = rig();
        rig.ready();
        let control = rig.control.clone();
        *rig.clock.on_sleep.lock().unwrap() = Some(Box::new(move || control.end(Reason::Panic)));
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "click", "x": 10, "y": 10},
                {"tool": "click", "x": 20, "y": 20},
                {"tool": "click", "x": 30, "y": 30},
            ])),
        );
        assert!(is_error(&result));
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert_eq!(rig.desktop.events().len(), 1);
        // No screenshot once the session ended.
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 1);
        assert_eq!(image_count(&result), 0);
    }

    #[test]
    fn malformed_batches_are_refused_before_anything_runs() {
        let rig = rig();
        let wait = json!({"tool": "wait", "ms": 0});
        let too_many = Value::Array(vec![wait.clone(); 21]);
        for args in [
            json!({}),
            batch(json!("click")),
            batch(json!([])),
            batch(too_many),
            batch(json!(["click"])),
            batch(json!([{"tool": "batch", "steps": [wait]}])),
            batch(json!([{"tool": "format_disk"}])),
            batch(json!([{"tool": "screenshot"}])),
            batch(json!([{"x": 1, "y": 1}])),
            batch(json!([{"tool": "wait", "ms": 0}, {"tool": "click", "x": 1}])),
        ] {
            let result = rig.call("batch", args.clone());
            assert!(is_error(&result), "{args}");
        }
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 0);
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn an_intent_in_a_batch_only_adds_checks() {
        // A harmless step intent cannot hide a risky batch intent or a risky target.
        let rig = rig_with(true, false);
        rig.ready();
        let result = rig.call(
            "batch",
            json!({"intent": "buy the ticket", "steps": [{"tool": "scroll", "x": 1, "y": 1, "dx": 0, "dy": 10, "intent": "just scrolling"}]}),
        );
        assert!(first_text(&result).contains("declined"), "{result}");
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call(
            "batch",
            json!({"intent": "look around", "steps": [{"tool": "click", "x": 1, "y": 1, "intent": "harmless"}]}),
        );
        assert!(first_text(&result).contains("declined"), "{result}");
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 2);
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_batch_waits_for_the_rate_limit_instead_of_failing() {
        // Each step counts as one action; a full window delays the batch, it does not refuse it.
        let rig = rig();
        rig.ready();
        for _ in 0..9 {
            assert!(!is_error(&rig.call("list_apps", json!({}))));
        }
        let steps: Vec<Value> = (0..3).map(|i| json!({"tool": "move", "x": i, "y": i})).collect();
        let result = rig.call("batch", batch(Value::Array(steps)));
        assert!(!is_error(&result), "{result}");
        assert_eq!(rig.desktop.events().len(), 3);
        assert!(rig.clock.now_ms() >= NOW + 1000);
    }

    #[test]
    fn a_batch_asks_for_the_session_once() {
        let rig = rig_with(false, true);
        let result = rig.call("batch", batch(json!([{"tool": "key", "combo": "tab"}, {"tool": "key", "combo": "tab"}])));
        assert!(first_text(&result).contains("not allowed"), "{result}");
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
        assert!(rig.desktop.events().is_empty());
    }

    // --- Yolo mode (S24.9) ---

    fn yolo_on(rig: &Rig) {
        rig.control.set_yolo(true, rig.clock.now_ms(), rig.dialogs.as_ref());
    }

    #[test]
    fn yolo_skips_the_risky_confirmation() {
        let rig = rig_with(true, false);
        rig.ready();
        yolo_on(&rig);
        *rig.desktop.elements.lock().unwrap() = send_button();
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(!is_error(&result), "{result}");
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn yolo_keeps_the_grant_the_blocklist_and_the_panic() {
        let rig = rig_with(false, false);
        yolo_on(&rig);
        assert!(first_text(&rig.call("screenshot", json!({}))).contains("not allowed"));
        *rig.dialogs.allow.lock().unwrap() = true;
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() =
            Box::new(|_| Some(app(300, "com.apple.systempreferences", "System Settings")));
        assert!(first_text(&rig.call("click", json!({"x": 10, "y": 10}))).contains("System Settings"));
        let queued_at = rig.control.epoch();
        rig.control.end(Reason::Panic);
        let result = rig.helper.call_tool_from(queued_at, "key", &json!({"combo": "tab"})).unwrap();
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn risky_actions_ask_again_once_yolo_expires() {
        let rig = rig_with(true, false);
        rig.ready();
        yolo_on(&rig);
        rig.clock.advance(super::super::session::YOLO_MS);
        rig.ready();
        *rig.desktop.elements.lock().unwrap() = send_button();
        assert!(first_text(&rig.call("click", json!({"x": 10, "y": 10}))).contains("declined"));
    }

    #[test]
    fn list_apps_returns_names_and_bundle_ids() {
        let rig = rig();
        let result = rig.call("list_apps", json!({}));
        let apps: Value = serde_json::from_str(&first_text(&result)).unwrap();
        assert_eq!(apps[0], json!({"name": "Safari", "bundleId": "com.apple.Safari", "active": true}));
    }

    // --- The pink glow (S28) ---

    fn marks(rig: &Rig) -> Vec<(Mark, usize)> {
        rig.marks.lock().unwrap().clone()
    }

    #[test]
    fn each_action_that_went_through_marks_where_it_acted_after_posting() {
        let rig = rig();
        rig.ready();
        let p = |x, y| Point { x, y };
        rig.call("click", json!({"x": 100, "y": 50}));
        rig.call("move", json!({"x": 1, "y": 2}));
        rig.call("drag", json!({"fromX": 10, "fromY": 20, "toX": 30, "toY": 40}));
        rig.call("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 120}));
        rig.call("key", json!({"combo": "tab"}));
        // A text with a newline is three input events and one mark, after the last of them.
        rig.call("type", json!({"text": "hi\nthere"}));
        assert_eq!(
            marks(&rig),
            vec![
                (Mark::Click(p(200.0, 100.0)), 1),
                (Mark::Move(p(2.0, 4.0)), 2),
                (Mark::Drag { from: p(20.0, 40.0), to: p(60.0, 80.0) }, 3),
                (Mark::Scroll(p(10.0, 12.0)), 4),
                (Mark::Key, 5),
                (Mark::Key, 8),
            ]
        );
    }

    #[test]
    fn typing_nothing_marks_nothing() {
        let rig = rig();
        rig.ready();
        assert!(!is_error(&rig.call("type", json!({"text": ""}))));
        assert!(rig.desktop.events().is_empty());
        assert_eq!(marks(&rig), vec![]);
    }

    #[test]
    fn refused_declined_and_stopped_actions_mark_nothing() {
        // Declined: a risky click the user says no to.
        let declined = rig_with(true, false);
        declined.ready();
        *declined.desktop.elements.lock().unwrap() = send_button();
        assert!(first_text(&declined.call("click", json!({"x": 10, "y": 10}))).contains("declined"));
        assert!(is_error(&declined.call("type", json!({"text": "hello\t "}))));
        // Refused: a blocked window, a point no app owns, a blocked app in front, invalid arguments.
        let rig_blocked = rig();
        rig_blocked.ready();
        *rig_blocked.desktop.owner_at.lock().unwrap() =
            Box::new(|_| Some(app(300, "com.apple.systempreferences", "System Settings")));
        assert!(is_error(&rig_blocked.call("click", json!({"x": 10, "y": 10}))));
        assert!(is_error(&rig_blocked.call("drag", json!({"fromX": 1, "fromY": 1, "toX": 2, "toY": 2}))));
        *rig_blocked.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        assert!(is_error(&rig_blocked.call("scroll", json!({"x": 1, "y": 1, "dx": 0, "dy": 1}))));
        *rig_blocked.desktop.frontmost.lock().unwrap() = Some(app(302, "com.apple.keychainaccess", "Keychain Access"));
        assert!(is_error(&rig_blocked.call("key", json!({"combo": "cmd+a"}))));
        assert!(is_error(&rig_blocked.call("click", json!({"x": 1}))));
        // Stopped: queued before a panic, no session (denied), no screenshot yet.
        let rig_stopped = rig();
        rig_stopped.ready();
        let queued_at = rig_stopped.control.epoch();
        rig_stopped.control.end(Reason::Panic);
        assert!(is_error(&rig_stopped.helper.call_tool_from(queued_at, "move", &json!({"x": 1, "y": 1})).unwrap()));
        let rig_denied = rig_with(false, true);
        assert!(is_error(&rig_denied.call("key", json!({"combo": "tab"}))));
        let rig_fresh = rig();
        assert!(is_error(&rig_fresh.call("click", json!({"x": 1, "y": 1}))));
        for r in [&declined, &rig_blocked, &rig_stopped, &rig_denied, &rig_fresh] {
            assert!(r.desktop.events().is_empty());
            assert!(marks(r).is_empty(), "{:?}", marks(r));
        }
    }

    #[test]
    fn screenshots_lists_open_app_and_wait_mark_nothing() {
        let rig = rig();
        rig.ready();
        rig.call("list_apps", json!({}));
        rig.call("open_app", json!({"name": "Mail"}));
        rig.call("wait", json!({"ms": 200}));
        assert!(marks(&rig).is_empty());
    }

    #[test]
    fn a_batch_marks_each_step_that_ran_and_none_after_it_stopped() {
        let rig = rig();
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|at: Point| {
            if at.x > 100.0 {
                Some(app(300, "com.apple.systempreferences", "System Settings"))
            } else {
                Some(safari())
            }
        });
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "click", "x": 10, "y": 10},
                {"tool": "wait", "ms": 0},
                {"tool": "type", "text": "Ana"},
                {"tool": "click", "x": 200, "y": 10},
                {"tool": "click", "x": 20, "y": 20},
            ])),
        );
        assert!(is_error(&result));
        assert_eq!(marks(&rig), vec![(Mark::Click(Point { x: 20.0, y: 20.0 }), 1), (Mark::Key, 2)]);
    }

    #[test]
    fn the_glow_changes_no_check_order_or_result() {
        // The same calls, with and without the glow, give the same results, dialogs, and events.
        let script = |rig: &Rig| -> Vec<Value> {
            *rig.desktop.elements.lock().unwrap() = send_button();
            let mut results = vec![rig.call("screenshot", json!({}))];
            for (name, args) in [
                ("click", json!({"x": 10, "y": 10})),
                ("move", json!({"x": 3, "y": 3})),
                ("type", json!({"text": "a\nb"})),
                (
                    "batch",
                    batch(json!([
                        {"tool": "scroll", "x": 1, "y": 1, "dx": 0, "dy": 5},
                        {"tool": "click", "x": 9, "y": 9},
                    ])),
                ),
                ("click", json!({"x": 5000, "y": 1})),
            ] {
                results.push(rig.call(name, args));
            }
            results
        };
        for confirm in [true, false] {
            let (with, without) = (rig_with(true, confirm), rig_without_glow(true, confirm));
            assert_eq!(script(&with), script(&without), "confirm {confirm}");
            assert_eq!(with.desktop.events(), without.desktop.events());
            assert_eq!(*with.dialogs.confirmations.lock().unwrap(), *without.dialogs.confirmations.lock().unwrap());
            assert_eq!(with.clock.now_ms(), without.clock.now_ms());
            assert!(without.marks.lock().unwrap().is_empty());
            // The rig with the glow also prepares every call; the rig without prepares none.
            assert!(!with.working.steps.lock().unwrap().is_empty());
        }
    }

    // --- The working rings (S1, S5) ---

    fn steps(rig: &Rig) -> Vec<Step> {
        std::mem::take(&mut *rig.working.steps.lock().unwrap())
    }

    #[test]
    fn a_screenshot_is_taken_while_prepared() {
        let rig = rig();
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        assert_eq!(steps(&rig), [Step::Begin { captures: 0, events: 0 }, Step::Finish { captures: 1, events: 0 }]);
    }

    #[test]
    fn an_action_and_the_screenshot_after_it_run_while_prepared() {
        let rig = rig();
        rig.ready();
        steps(&rig);
        assert!(!is_error(&rig.call("click", json!({"x": 10, "y": 10}))));
        assert_eq!(steps(&rig), [Step::Begin { captures: 1, events: 0 }, Step::Finish { captures: 2, events: 1 }]);
        for (name, args) in [("open_app", json!({"name": "Mail"})), ("wait", json!({"ms": 200}))] {
            assert!(!is_error(&rig.call(name, args)), "{name}");
            assert_eq!(steps(&rig).len(), 2, "{name}");
        }
    }

    #[test]
    fn a_batch_is_prepared_once_for_all_its_steps() {
        let rig = rig();
        rig.ready();
        steps(&rig);
        let steps_json = json!([
            {"tool": "click", "x": 10, "y": 10},
            {"tool": "type", "text": "Ana"},
            {"tool": "key", "combo": "tab"},
        ]);
        assert!(!is_error(&rig.call("batch", batch(steps_json))));
        assert_eq!(steps(&rig), [Step::Begin { captures: 1, events: 0 }, Step::Finish { captures: 2, events: 3 }]);
    }

    #[test]
    fn list_apps_and_calls_refused_before_the_session_are_never_prepared() {
        let rig = rig();
        assert!(!is_error(&rig.call("list_apps", json!({}))));
        assert!(is_error(&rig.call("click", json!({"x": 1}))));
        rig.rpc("tools/call", json!({"name": "format_disk", "arguments": {}}));
        rig.desktop.permissions.lock().unwrap().screen_recording = false;
        assert!(is_error(&rig.call("screenshot", json!({}))));
        assert!(steps(&rig).is_empty());
        // A denied session grant prepares nothing.
        let denied = rig_with(false, true);
        assert!(is_error(&denied.call("screenshot", json!({}))));
        assert!(is_error(&denied.call("batch", batch(json!([{"tool": "key", "combo": "tab"}])))));
        assert!(steps(&denied).is_empty());
    }

    #[test]
    fn a_failed_preparation_sends_nothing() {
        let rig = rig();
        rig.ready();
        steps(&rig);
        *rig.working.fails.lock().unwrap() = Some(super::super::working::UNAVAILABLE.to_string());
        for (name, args) in [
            ("screenshot", json!({})),
            ("click", json!({"x": 10, "y": 10})),
            ("batch", batch(json!([{"tool": "type", "text": "hi"}]))),
        ] {
            let result = rig.call(name, args);
            assert!(is_error(&result), "{name}");
            assert_eq!(first_text(&result), super::super::working::UNAVAILABLE, "{name}");
            assert_eq!(image_count(&result), 0, "{name}");
        }
        assert!(rig.desktop.events().is_empty());
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 1);
        // A failed begin left nothing to finish.
        assert!(steps(&rig).iter().all(|step| matches!(step, Step::Begin { .. })));
    }

    #[test]
    fn a_stop_while_preparing_drops_the_call() {
        let rig = rig();
        rig.ready();
        steps(&rig);
        let control = rig.control.clone();
        *rig.working.during.lock().unwrap() = Some(Box::new(move || control.end(Reason::Stopped)));
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(is_error(&result));
        assert_eq!(first_text(&result), STOPPED);
        assert!(rig.desktop.events().is_empty());
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 1);
        assert_eq!(steps(&rig), [Step::Begin { captures: 1, events: 0 }, Step::Finish { captures: 1, events: 0 }]);
        // A preparation that failed because of the Stop says the call was stopped.
        *rig.working.during.lock().unwrap() = None;
        rig.ready();
        steps(&rig);
        let control = rig.control.clone();
        *rig.working.during.lock().unwrap() = Some(Box::new(move || control.end(Reason::Panic)));
        *rig.working.fails.lock().unwrap() = Some(super::super::working::UNAVAILABLE.to_string());
        assert_eq!(first_text(&rig.call("key", json!({"combo": "tab"}))), STOPPED);
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn every_prepared_call_is_finished_once_however_it_ends() {
        let one_each = |rig: &Rig, why: &str| {
            let seen = steps(rig);
            assert_eq!(seen.len(), 2, "{why}: {seen:?}");
            assert!(matches!(seen[0], Step::Begin { .. }) && matches!(seen[1], Step::Finish { .. }), "{why}: {seen:?}");
        };
        // Refused by the blocklist, and with no screenshot yet.
        let rig_refused = rig();
        assert!(is_error(&rig_refused.call("click", json!({"x": 1, "y": 1}))));
        one_each(&rig_refused, "no screenshot");
        rig_refused.ready();
        steps(&rig_refused);
        *rig_refused.desktop.owner_at.lock().unwrap() =
            Box::new(|_| Some(app(300, "com.apple.systempreferences", "System Settings")));
        assert!(is_error(&rig_refused.call("click", json!({"x": 10, "y": 10}))));
        one_each(&rig_refused, "blocked");
        // Declined by the user.
        let rig_declined = rig_with(true, false);
        rig_declined.ready();
        steps(&rig_declined);
        *rig_declined.desktop.elements.lock().unwrap() = send_button();
        assert!(is_error(&rig_declined.call("click", json!({"x": 10, "y": 10}))));
        one_each(&rig_declined, "declined");
        // Stopped in the middle of a batch.
        let rig_stopped = rig();
        rig_stopped.ready();
        steps(&rig_stopped);
        let control = rig_stopped.control.clone();
        *rig_stopped.clock.on_sleep.lock().unwrap() = Some(Box::new(move || control.end(Reason::Panic)));
        let steps_json = json!([{"tool": "click", "x": 10, "y": 10}, {"tool": "click", "x": 20, "y": 20}]);
        assert!(is_error(&rig_stopped.call("batch", batch(steps_json))));
        one_each(&rig_stopped, "stopped");
        assert_eq!(rig_stopped.desktop.events().len(), 1);
    }

    /// Races between preparation, Stop, and late acknowledgements, with the real `Working` coordinator.
    mod preparation_races {
        use super::*;
        use super::super::super::working::{self as w, MainThread, Part, Rings, Task, Visibility, Windows, Working};
        use std::sync::atomic::{AtomicBool, AtomicU64};
        use std::time::{Duration, Instant};

        #[derive(Default)]
        struct Wins { vis: Mutex<Visibility>, log: Mutex<Vec<String>> }
        impl Windows for Wins {
            fn is_visible(&self, p: Part) -> bool { self.vis.lock().unwrap().get(p) }
            fn hide(&self, p: Part) -> Result<(), String> {
                let mut v = self.vis.lock().unwrap();
                match p { Part::Dot => v.dot = false, Part::Panel => v.panel = false }
                self.log.lock().unwrap().push(format!("hide {p:?}")); Ok(())
            }
            fn show(&self, p: Part) {
                let mut v = self.vis.lock().unwrap();
                match p { Part::Dot => v.dot = true, Part::Panel => v.panel = true }
                self.log.lock().unwrap().push(format!("show {p:?}"));
            }
            fn rose_hidden(&self) -> bool { false }
        }
        /// Overlay: acks with `ack_offset` added (None = never acks), after `delay`.
        struct Ring { w: Mutex<Option<std::sync::Weak<Working>>>, ack: Mutex<Option<i64>>, log: Mutex<Vec<String>>, last: AtomicU64 }
        impl Rings for Ring {
            fn show(&self, op: u64) -> Result<(), String> {
                self.log.lock().unwrap().push(format!("on {op}"));
                self.last.store(op, Ordering::SeqCst);
                if let (Some(off), Some(w)) = (*self.ack.lock().unwrap(), self.w.lock().unwrap().as_ref().and_then(|w| w.upgrade())) {
                    w.acknowledge("glow", (op as i64 + off) as u64).ok();
                }
                Ok(())
            }
            fn end(&self, op: u64) { self.log.lock().unwrap().push(format!("off {op}")); }
        }
        /// Main thread: inline, or a real separate thread with a queue.
        struct Main { deferred: AtomicBool, q: Mutex<Vec<Task>> }
        impl MainThread for Main {
            fn run(&self, t: Task) -> Result<(), String> {
                if self.deferred.load(Ordering::SeqCst) { self.q.lock().unwrap().push(t); } else { t(); }
                Ok(())
            }
        }
        impl Main { fn drain(&self) { let ts: Vec<Task> = std::mem::take(&mut *self.q.lock().unwrap()); for t in ts { t(); } } }

        struct P { rig: Rig, wins: Arc<Wins>, ring: Arc<Ring>, main: Arc<Main>, working: Arc<Working> }
        fn probe(allow: bool, confirm: bool, timeout: Duration) -> P {
            let base = rig_with(allow, confirm);
            let wins = Arc::new(Wins::default());
            *wins.vis.lock().unwrap() = Visibility { dot: true, panel: true };
            let ring = Arc::new(Ring { w: Mutex::new(None), ack: Mutex::new(Some(0)), log: Mutex::new(vec![]), last: AtomicU64::new(0) });
            let main = Arc::new(Main { deferred: AtomicBool::new(false), q: Mutex::new(vec![]) });
            let working = Arc::new(Working::new(wins.clone(), ring.clone(), main.clone(), timeout));
            *ring.w.lock().unwrap() = Some(Arc::downgrade(&working));
            let helper = Helper::new(base.desktop.clone(), base.dialogs.clone(), base.clock.clone(), base.control.clone(), TOKEN.into(), OWN_PID)
                .with_working(working.clone());
            P { rig: Rig { helper, ..base }, wins, ring, main, working }
        }
        const BOTH: Visibility = Visibility { dot: true, panel: true };

        #[test]
        fn a_stop_while_waiting_for_the_rings_posts_nothing_and_restores_the_windows() {
            let p = probe(true, true, Duration::from_secs(3));
            p.rig.ready();
            let caps = p.rig.desktop.captures.load(Ordering::SeqCst);
            *p.ring.ack.lock().unwrap() = None; // overlay never acks
            let control = p.rig.control.clone();
            let t = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(100)); control.end(Reason::Stopped); });
            // The real app wires Control's notify to session_ended; emulate that wiring here.
            let working = p.working.clone();
            let ring = p.ring.clone();
            let watcher = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(150)); working.session_ended(); let _ = ring; });
            let started = Instant::now();
            let result = p.rig.call("click", json!({"x": 10, "y": 10}));
            t.join().unwrap(); watcher.join().unwrap();
            assert!(is_error(&result));
            assert_eq!(first_text(&result), STOPPED);
            assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
            assert!(p.rig.desktop.events().is_empty());
            assert_eq!(p.rig.desktop.captures.load(Ordering::SeqCst), caps);
            assert_eq!(*p.wins.vis.lock().unwrap(), BOTH);
            // A late acknowledgement for the stopped operation is ignored.
            assert_eq!(p.working.acknowledge("glow", 2), Ok(false));
            assert_eq!(*p.wins.vis.lock().unwrap(), BOTH);
        }


        #[test]
        fn an_acknowledgement_for_an_older_operation_is_ignored() {
            let p = probe(true, true, Duration::from_millis(150));
            p.rig.ready(); // op 1 completes
            *p.ring.ack.lock().unwrap() = Some(-1); // overlay acks op N-1
            let result = p.rig.call("click", json!({"x": 10, "y": 10}));
            assert!(is_error(&result));
            assert_eq!(first_text(&result), w::UNAVAILABLE);
            assert!(p.rig.desktop.events().is_empty());
            assert_eq!(*p.wins.vis.lock().unwrap(), BOTH);
            assert_eq!(*p.wins.log.lock().unwrap(), ["hide Dot", "hide Panel", "show Dot", "show Panel"]);
            // Only the glow window may acknowledge.
            assert!(p.working.acknowledge("panel", 3).is_err());
            assert!(p.working.acknowledge("dot", 3).is_err());
        }


        #[test]
        fn a_hide_that_runs_after_its_timeout_hides_nothing() {
            let p = probe(true, true, Duration::from_millis(120));
            p.rig.ready();
            p.main.deferred.store(true, Ordering::SeqCst);
            let result = p.rig.call("key", json!({"combo": "tab"}));
            assert!(is_error(&result));
            assert_eq!(first_text(&result), w::NOT_HIDDEN);
            assert!(p.rig.desktop.events().is_empty());
            p.main.drain();
            assert_eq!(*p.wins.vis.lock().unwrap(), BOTH);
            assert_eq!(p.wins.log.lock().unwrap().len(), 4, "{:?}", p.wins.log.lock().unwrap());
        }


        #[test]
        fn a_concurrent_stop_always_restores_the_windows_and_never_acts_after_failing() {
            // A separate "main" thread drains the queue; Stop arrives concurrently. Repeat to shake races.
            for i in 0..50u64 {
                let p = probe(true, true, Duration::from_millis(500));
                p.rig.ready();
                p.main.deferred.store(true, Ordering::SeqCst);
                let stop = Arc::new(AtomicBool::new(false));
                let (m, s) = (p.main.clone(), stop.clone());
                let mainthr = std::thread::spawn(move || { while !s.load(Ordering::SeqCst) { m.drain(); std::thread::yield_now(); } m.drain(); });
                let (c, wk) = (p.rig.control.clone(), p.working.clone());
                let stopper = std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_micros(i * 5));
                    c.end(Reason::Stopped);
                    wk.session_ended();
                });
                let r = p.rig.call("click", json!({"x": 10, "y": 10}));
                stopper.join().unwrap();
                std::thread::sleep(Duration::from_millis(2));
                stop.store(true, Ordering::SeqCst);
                mainthr.join().unwrap();
                assert_eq!(*p.wins.vis.lock().unwrap(), BOTH, "iter {i}: {:?} {r}", p.wins.log.lock().unwrap());
                assert!(p.rig.desktop.events().len() <= 1);
                if is_error(&r) { assert!(p.rig.desktop.events().is_empty(), "iter {i}"); }
                assert!(!p.working.is_current(p.ring.last.load(Ordering::SeqCst)));
            }
        }


    }

    // --- Desktop-global policy (T2, S3-S5): fake-backend checks through the Helper MCP
    // interface. The default stays application-targeted; only an explicit global helper
    // drives the desktop as a whole, with grant, approval, Stop, and expiry intact.

    fn global_rig_with(allow: bool, confirm: bool) -> Rig {
        rig_with_policy(allow, confirm, BackendPolicy::DesktopGlobal)
    }

    fn global_ready(rig: &Rig) {
        // No app owns any point and none is frontmost: there is no per-app target to find.
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        // The external editor window is the keyboard target global input is
        // pinned to; without it global keyboard input must refuse (fail closed).
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        assert!(!is_error(&rig.call("screenshot", json!({}))));
    }

    #[test]
    fn the_default_policy_is_targeted_and_still_refuses_unknown_targets() {
        let rig = rig();
        assert_eq!(rig.helper.policy(), BackendPolicy::Targeted);
        rig.ready();
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("which app"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn global_input_names_the_desktop_not_a_fabricated_app() {
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        // A declared risky intent is what asks now (S9); the confirmation still names the
        // desktop, never an app the global path cannot attribute.
        let result = rig.call("click", json!({"x": 10, "y": 10, "intent": "buy the ticket"}));
        assert!(!is_error(&result), "{result}");
        assert!(first_text(&result).contains(super::super::GLOBAL_TARGET), "{result}");
        let asked = rig.dialogs.confirmations.lock().unwrap().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains(super::super::GLOBAL_TARGET), "{asked:?}");
        assert!(!asked[0].contains("Safari"), "{asked:?}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn global_input_after_a_grant_does_not_ask_again() {
        // S9 option 1: the 30-minute grant authorizes ordinary desktop input. Linux cannot
        // classify the target, so an unknown target is no longer turned into a confirmation;
        // only a detected risk asks (the tests below).
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        for (name, args) in [
            ("click", json!({"x": 10, "y": 10})),
            ("move", json!({"x": 10, "y": 10})),
            ("drag", json!({"fromX": 10, "fromY": 20, "toX": 30, "toY": 40})),
            ("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 120})),
            ("type", json!({"text": "ok"})),
            ("key", json!({"combo": "tab"})),
        ] {
            assert!(!is_error(&rig.call(name, args)), "{name}");
        }
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        assert_eq!(rig.desktop.events().len(), 6);
    }

    #[test]
    fn a_declared_risky_intent_still_asks_in_global_mode() {
        // The declared intent is a real signal the global path can use (S9): it asks.
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        let result = rig.call("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 10, "intent": "buy the ticket"}));
        assert!(!is_error(&result), "{result}");
        let asked = rig.dialogs.confirmations.lock().unwrap().clone();
        assert_eq!(asked.len(), 1, "{asked:?}");
        assert!(asked[0].contains("buy the ticket"), "{asked:?}");
        assert!(asked[0].contains(super::super::GLOBAL_TARGET), "{asked:?}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn global_input_without_a_session_still_refuses() {
        // The grant, not the removed blanket, is what gates input: no session means no input
        // and no confirmation (S9 removes the repeated prompt, not the consent). Every mutating
        // tool goes through the same gate, so none of them may post or launch without it.
        let rig = global_rig_with(false, true);
        for (name, args) in [
            ("click", json!({"x": 10, "y": 10})),
            ("move", json!({"x": 10, "y": 10})),
            ("drag", json!({"fromX": 10, "fromY": 10, "toX": 20, "toY": 20})),
            ("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 10})),
            ("type", json!({"text": "ok"})),
            ("key", json!({"combo": "tab"})),
            ("open_app", json!({"name": "Mail"})),
        ] {
            let result = rig.call(name, args);
            assert!(is_error(&result), "{name}");
            assert!(first_text(&result).contains("not allowed"), "{name}: {result}");
        }
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        assert!(rig.desktop.events().is_empty());
        assert!(rig.desktop.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn a_declined_global_action_sends_zero_input() {
        let rig = global_rig_with(true, false);
        global_ready(&rig);
        let result = rig.call("click", json!({"x": 10, "y": 10, "intent": "buy the ticket"}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("declined"), "{result}");
        assert!(rig.desktop.events().is_empty());
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn global_yolo_skips_only_the_action_confirmation() {
        // The grant still applies first.
        let rig = global_rig_with(false, false);
        assert_eq!(rig.helper.policy(), BackendPolicy::DesktopGlobal);
        assert!(first_text(&rig.call("screenshot", json!({}))).contains("not allowed"));
        *rig.dialogs.allow.lock().unwrap() = true;
        yolo_on(&rig);
        global_ready(&rig);
        let confirmations = rig.dialogs.confirmations.lock().unwrap().len();
        assert!(!is_error(&rig.call("click", json!({"x": 10, "y": 10, "intent": "buy the ticket"}))));
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), confirmations);
        // Stop still guards: nothing is posted, and the next call re-asks the grant.
        rig.control.end(Reason::Stopped);
        let events = rig.desktop.events().len();
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert_eq!(rig.desktop.events().len(), events);
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 3);
        // Expiry still re-asks as well.
        rig.clock.advance(SESSION_MS);
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert_eq!(rig.desktop.events().len(), events);
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn global_yolo_skips_the_risk_confirmation_and_expiry_restores_it() {
        // Yolo removes only the risk step (S24.9): with it on a declared risky intent does not
        // ask; once it expires, the same action asks again (and is declined here).
        let rig = global_rig_with(true, false);
        global_ready(&rig);
        yolo_on(&rig);
        let risky = json!({"x": 10, "y": 10, "intent": "buy the ticket"});
        assert!(!is_error(&rig.call("click", risky.clone())));
        assert!(rig.dialogs.confirmations.lock().unwrap().is_empty());
        assert_eq!(rig.desktop.events().len(), 1);
        rig.clock.advance(super::super::session::YOLO_MS);
        rig.ready();
        let result = rig.call("click", risky);
        assert!(first_text(&result).contains("declined"), "{result}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn global_stopped_and_stale_operations_send_zero_events() {
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        let queued_at = rig.control.epoch();
        rig.control.end(Reason::Panic);
        let result = rig.helper.call_tool_from(queued_at, "click", &json!({"x": 10, "y": 10})).unwrap();
        assert!(is_error(&result));
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert!(rig.desktop.events().is_empty());
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_global_screenshot_names_the_focused_app_id() {
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        // The backend's own "frontmost" app is unverifiable on a desktop global mode cannot
        // attribute, so it is never repeated; the focused window's app id comes from the same
        // observation that decides the keyboard target (T16, S4).
        *rig.desktop.frontmost.lock().unwrap() = Some(app(200, "com.apple.Safari", "Safari"));
        let result = rig.call("screenshot", json!({}));
        let content = result["content"].as_array().unwrap();
        assert!(content.iter().any(|c| c["type"] == "image"));
        let meta = content.iter().rfind(|c| c["type"] == "text").unwrap();
        let meta: Value = serde_json::from_str(meta["text"].as_str().unwrap()).unwrap();
        assert_eq!(meta["frontApp"], "org.gnome.TextEditor", "{meta}");
    }

    #[test]
    fn a_global_screenshot_keeps_front_app_null_without_an_observation() {
        // A failed query and a compositor that reports no focused window both leave nothing to
        // name: the metadata stays null instead of fabricating one (T16, S4).
        for failed in [false, true] {
            let rig = global_rig_with(true, true);
            global_ready(&rig);
            if failed {
                rig.desktop.focus_query_failure.store(true, Ordering::SeqCst);
            } else {
                *rig.desktop.focused_window.lock().unwrap() = None;
            }
            let result = rig.call("screenshot", json!({}));
            let content = result["content"].as_array().unwrap();
            let meta = content.iter().rfind(|c| c["type"] == "text").unwrap();
            let meta: Value = serde_json::from_str(meta["text"].as_str().unwrap()).unwrap();
            assert!(meta["frontApp"].is_null(), "failed {failed}: {meta}");
        }
    }

    #[test]
    fn a_global_screenshot_never_fabricates_an_app_name_from_a_title() {
        // A window that reports a document title but no app id has no app name to give: the
        // metadata stays null rather than presenting the title as an app (T16, S4).
        let rig = global_rig_with(true, true);
        *rig.desktop.focused_window.lock().unwrap() = Some(FocusTarget {
            window_id: 30,
            pid: Some(400),
            title: Some("Confidential notes".into()),
            app_id: None,
        });
        let result = rig.call("screenshot", json!({}));
        let content = result["content"].as_array().unwrap();
        let meta = content.iter().rfind(|c| c["type"] == "text").unwrap();
        let meta: Value = serde_json::from_str(meta["text"].as_str().unwrap()).unwrap();
        assert!(meta["frontApp"].is_null(), "{meta}");
    }

    #[test]
    fn the_linux_grant_copy_says_desktop_global_without_per_app_exclusion() {
        // Integration with a real consent dialog waits for the backend (T5).
        assert!(super::super::GLOBAL_GRANT_TEXT.contains("Linux desktop"));
        assert!(super::super::GLOBAL_GRANT_TEXT.contains("no reliable per-app exclusion"));
        assert!(super::super::GLOBAL_GRANT_TEXT.contains("30 minutes"));
        assert_eq!(
            BackendPolicy::DesktopGlobal.describe(),
            "desktop-global control without reliable per-app exclusion"
        );
        assert_eq!(BackendPolicy::Targeted.describe(), "application-targeted control");
    }

    #[test]
    fn global_drag_scroll_and_open_app_ask_with_a_declared_risk() {
        // After S9 these ask because of the declared risk, not because the target is unknown.
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        let drag = json!({"fromX": 10, "fromY": 20, "toX": 30, "toY": 40, "intent": "delete the file"});
        let scroll = json!({"x": 5, "y": 6, "dx": 0, "dy": 120, "intent": "buy the ticket"});
        let open = json!({"name": "Mail", "intent": "send the message"});
        assert!(!is_error(&rig.call("drag", drag)));
        assert!(!is_error(&rig.call("scroll", scroll)));
        assert!(!is_error(&rig.call("open_app", open)));
        let asked = rig.dialogs.confirmations.lock().unwrap().clone();
        assert_eq!(asked.len(), 3, "{asked:?}");
        assert!(asked.iter().all(|m| m.contains(super::super::GLOBAL_TARGET)), "{asked:?}");
        assert_eq!(rig.desktop.events().len(), 2);
        assert_eq!(*rig.desktop.opened.lock().unwrap(), vec!["Mail".to_string()]);
    }

    #[test]
    fn the_global_catalog_describes_linux_launch_and_inventory_truthfully() {
        let body = global_rig_with(true, true).rpc("tools/list", json!({}));
        let tools = body["result"]["tools"].as_array().unwrap();
        let open = tools.iter().find(|t| t["name"] == "open_app").unwrap()["description"]
            .as_str()
            .unwrap();
        // Launch by desktop id or display name, acknowledged by the launcher only.
        assert!(open.contains("desktop id"), "{open}");
        assert!(open.contains("display name"), "{open}");
        assert!(open.contains("launcher accepted the request"), "{open}");
        assert!(open.contains("window") && open.contains("focus"), "{open}");
        let list = tools.iter().find(|t| t["name"] == "list_apps").unwrap()["description"]
            .as_str()
            .unwrap();
        // The inventory is Niri's managed windows, not background apps and not bundle ids.
        assert!(list.contains("managed window"), "{list}");
        assert!(list.contains("not background apps"), "{list}");
        assert!(list.contains("not bundle ids"), "{list}");
    }

    #[test]
    fn a_global_open_app_ack_means_the_launcher_accepted_not_that_it_opened() {
        let global = global_rig_with(true, true);
        global_ready(&global);
        let result = global.call("open_app", json!({"name": "Mail"}));
        assert!(!is_error(&result), "{result}");
        let text = first_text(&result);
        assert!(text.contains("launcher accepted the request"), "{text}");
        assert!(!text.contains(": done."), "a bare done would claim more than the launcher gave: {text}");
        // The macOS acknowledgement is unchanged.
        let mac = rig();
        mac.ready();
        assert!(
            first_text(&mac.call("open_app", json!({"name": "Mail"}))).contains("Open Mail: done.")
        );
    }

    #[test]
    fn declined_global_mutations_post_nothing() {
        let rig = global_rig_with(true, false);
        global_ready(&rig);
        let captures = rig.desktop.captures.load(Ordering::SeqCst);
        for (name, args) in [
            ("drag", json!({"fromX": 10, "fromY": 10, "toX": 20, "toY": 20, "intent": "delete the file"})),
            ("scroll", json!({"x": 5, "y": 6, "dx": 0, "dy": 10, "intent": "buy the ticket"})),
            ("type", json!({"text": "hello", "intent": "send the message"})),
            ("key", json!({"combo": "tab", "intent": "send the message"})),
            ("open_app", json!({"name": "Mail", "intent": "pagar la cuenta"})),
        ] {
            let result = rig.call(name, args);
            assert!(is_error(&result), "{name}");
            assert!(first_text(&result).contains("declined"), "{name}: {result}");
        }
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 5);
        assert!(rig.desktop.events().is_empty());
        assert!(rig.desktop.opened.lock().unwrap().is_empty());
        assert_eq!(rig.desktop.captures.load(Ordering::SeqCst), captures);
    }

    #[test]
    fn global_initialize_names_the_linux_desktop() {
        let rig = global_rig_with(true, true);
        let body = rig.rpc("initialize", json!({"protocolVersion": "2025-03-26"}));
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
        let instructions = body["result"]["instructions"].as_str().unwrap().to_string();
        assert!(instructions.contains("Linux desktop"), "{instructions}");
        assert!(instructions.contains("no reliable per-app exclusion"), "{instructions}");
        // The keyboard target is the one observed with the latest screenshot, not whatever is
        // focused at call time.
        assert!(instructions.contains("latest screenshot"), "{instructions}");
        assert!(!instructions.contains("this Mac"), "{instructions}");
        assert!(!instructions.contains("off limits"), "{instructions}");
    }

    #[test]
    fn targeted_initialize_still_names_this_mac() {
        let rig = rig();
        let body = rig.rpc("initialize", json!({}));
        let instructions = body["result"]["instructions"].as_str().unwrap().to_string();
        assert!(instructions.contains("Controls this Mac"), "{instructions}");
        assert!(instructions.contains("off limits"), "{instructions}");
    }

    #[test]
    fn global_permission_errors_claim_no_mac_permission() {
        let rig = global_rig_with(true, true);
        rig.desktop.permissions.lock().unwrap().screenshots_supported = false;
        let message = first_text(&rig.call("screenshot", json!({})));
        assert!(message.contains("Linux"), "{message}");
        assert!(!message.contains("macOS"), "{message}");
        // Screen Recording and Accessibility are not Linux concepts: denied
        // flags never block the global path and never name Mac permissions.
        rig.desktop.permissions.lock().unwrap().screenshots_supported = true;
        rig.desktop.permissions.lock().unwrap().screen_recording = false;
        // A valid external keyboard target is focused at capture, so only the flag is under test.
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        let result = rig.call("screenshot", json!({}));
        assert!(!is_error(&result), "Screen Recording must not gate global seeing: {result}");
        assert!(!first_text(&result).contains("Screen Recording"), "{result:?}");
        rig.desktop.permissions.lock().unwrap().screen_recording = true;
        rig.desktop.permissions.lock().unwrap().accessibility = false;
        let result = rig.call("key", json!({"combo": "tab"}));
        assert!(!is_error(&result), "Accessibility must not gate global input: {result}");
        assert!(!first_text(&result).contains("Accessibility"), "{result:?}");
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn global_accessibility_denied_does_not_block_input() {
        // Stock Wayland has no Accessibility equivalent (S3-S5): a denied
        // flag must never block the DesktopGlobal path.
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        rig.desktop.permissions.lock().unwrap().accessibility = false;
        let result = rig.call("click", json!({"x": 10, "y": 10}));
        assert!(!is_error(&result), "global input must not be blocked by Accessibility: {result}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn global_screen_recording_denied_does_not_block_seeing() {
        // Screencopy needs no portal permission: the Screen Recording flag
        // is not a Linux concept and must never gate the global path.
        let rig = global_rig_with(true, true);
        global_ready(&rig);
        rig.desktop.permissions.lock().unwrap().screen_recording = false;
        let result = rig.call("screenshot", json!({}));
        assert!(!is_error(&result), "global seeing must not be blocked by Screen Recording: {result}");
    }

    // --- Focus safety (T4, S4/S5): the keyboard target is a window, not an app pid.

    fn editor_window() -> FocusTarget {
        FocusTarget {
            window_id: 10,
            pid: Some(200),
            title: Some("Text Editor".into()),
            app_id: Some("org.gnome.TextEditor".into()),
        }
    }

    fn other_window_of_the_same_process() -> FocusTarget {
        FocusTarget { window_id: 11, pid: Some(200), title: Some("Editor Help".into()), app_id: None }
    }

    fn own_chat_window() -> FocusTarget {
        FocusTarget { window_id: 99, pid: Some(OWN_PID), title: Some("Gentle Dot".into()), app_id: Some("gentle-dot".into()) }
    }

    fn terminal_window() -> FocusTarget {
        FocusTarget { window_id: 12, pid: Some(300), title: Some("Terminal".into()), app_id: Some("foot".into()) }
    }

    /// A global rig with the external editor window focused.
    fn focus_rig(allow: bool, confirm: bool) -> Rig {
        let rig = global_rig_with(allow, confirm);
        global_ready(&rig);
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        rig
    }

    /// Every dialog moves the keyboard focus to `target`, as a real one does.
    fn dialogs_move_focus_to(rig: &Rig, target: FocusTarget) {
        let desktop = rig.desktop.clone();
        *rig.dialogs.during.lock().unwrap() = Some(Box::new(move || {
            *desktop.focused_window.lock().unwrap() = Some(target.clone());
        }));
    }

    #[test]
    fn a_confirm_dialog_steals_focus_and_the_same_window_is_restored_before_typing() {
        let rig = focus_rig(true, true);
        dialogs_move_focus_to(&rig, own_chat_window());
        // A declared risk is what opens the confirmation; ordinary typing no longer asks (S9).
        let result = rig.call("type", json!({"text": "PRUEBA-NATIVA-OK", "intent": "send the message"}));
        assert!(!is_error(&result), "{result}");
        // Input is posted only after the exact original window (id 10) is focused again,
        // never the chat and never merely "some window of the same pid".
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("PRUEBA-NATIVA-OK".into())]);
        assert_eq!(*rig.desktop.focus_restores.lock().unwrap(), vec![10]);
        assert_eq!(rig.desktop.focused_window.lock().unwrap().as_ref().unwrap().window_id, 10);
    }

    #[test]
    fn typing_targets_the_screenshot_window_not_the_one_focused_later() {
        // The screenshot bound the editor as the keyboard target; the human then focuses a
        // terminal before asking to type. The terminal must NEVER become the intended target.
        let rig = focus_rig(true, true);
        *rig.desktop.focused_window.lock().unwrap() = Some(terminal_window());
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        assert!(rig.desktop.events().is_empty(), "{:?}", rig.desktop.events());
    }

    #[test]
    fn no_screenshot_refuses_and_names_the_missing_snapshot() {
        // The keyboard target comes from the latest screenshot, so no screenshot is no target; the
        // refusal names that cause instead of one generic sentence (T16, S4).
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        assert!(first_text(&result).contains("No screenshot has been taken yet"), "{result}");
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_screenshot_without_a_usable_keyboard_window_still_shows() {
        // An own/unknown focus at capture keeps the screenshot truthful and only leaves the
        // keyboard target unavailable; typing must then fail closed.
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(own_chat_window());
        let shot = rig.call("screenshot", json!({}));
        assert!(!is_error(&shot), "{shot}");
        assert!(shot["content"].as_array().unwrap().iter().any(|c| c["type"] == "image"));
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_screenshot_query_failure_still_shows_without_a_keyboard_target() {
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        rig.desktop.focus_query_failure.store(true, Ordering::SeqCst);
        let shot = rig.call("screenshot", json!({}));
        assert!(!is_error(&shot), "{shot}");
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_pointer_action_refreshes_the_keyboard_target_from_its_new_screenshot() {
        let rig = focus_rig(true, true); // bound to the editor
        *rig.desktop.focused_window.lock().unwrap() = Some(terminal_window());
        // A click is not keyboard input; it posts and takes a fresh screenshot, which
        // re-observes the focus, so the editor binding is replaced by the terminal.
        assert!(!is_error(&rig.call("click", json!({"x": 10, "y": 10}))));
        let result = rig.call("type", json!({"text": "ok"}));
        assert!(!is_error(&result), "{result}");
        let events = rig.desktop.events();
        assert_eq!(events.len(), 2, "{events:?}");
        assert!(matches!(events[1], InputEvent::Text(_)));
    }

    #[test]
    fn targeted_keyboard_input_still_works_without_a_screenshot() {
        // macOS keeps its own path: no screenshot is needed for type or key.
        let rig = rig();
        assert!(!is_error(&rig.call("type", json!({"text": "hi"}))));
        assert!(!is_error(&rig.call("key", json!({"combo": "tab"}))));
        assert_eq!(rig.desktop.events().len(), 2);
    }

    #[test]
    fn the_grant_dialog_restores_focus_before_the_screenshot_binds_the_target() {
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        dialogs_move_focus_to(&rig, own_chat_window());
        // The first call asks the grant; while it is open the focus moves to Own. The restore
        // must put Editor back BEFORE the screenshot binds the keyboard target.
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        assert_eq!(rig.dialogs.grants.load(Ordering::SeqCst), 1);
        assert_eq!(*rig.desktop.focus_restores.lock().unwrap(), vec![10]);
        // The type call's own confirmation steals focus again; the restore lets it reach Editor.
        let result = rig.call("type", json!({"text": "hi", "intent": "send the message"}));
        assert!(!is_error(&result), "{result}");
        assert_eq!(rig.dialogs.confirmations.lock().unwrap().len(), 1);
        assert_eq!(*rig.desktop.focus_restores.lock().unwrap(), vec![10, 10]);
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("hi".into())]);
    }

    #[test]
    fn a_failed_focus_restore_sends_zero_input() {
        let rig = focus_rig(true, true);
        dialogs_move_focus_to(&rig, own_chat_window());
        *rig.desktop.focus_failure.lock().unwrap() = Some("niri: no such window".into());
        let result = rig.call("type", json!({"text": "nope", "intent": "send the message"}));
        assert!(is_error(&result));
        assert!(!first_text(&result).contains("done"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_stop_during_a_dialog_sends_zero_input() {
        let rig = focus_rig(true, true);
        let control = rig.control.clone();
        *rig.dialogs.during.lock().unwrap() = Some(Box::new(move || control.end(Reason::Stopped)));
        let result = rig.call("type", json!({"text": "nope", "intent": "send the message"}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("stopped"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn an_own_window_at_capture_is_never_a_keyboard_target() {
        // The screenshot is taken while Gentle Dot's own window is focused: the capture must
        // bind no keyboard target and the later type must fail closed.
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(own_chat_window());
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result));
        assert!(!first_text(&result).contains("done"), "{result}");
        assert!(first_text(&result).to_lowercase().contains("focus"), "{result}");
        assert!(first_text(&result).contains("own window"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn moving_to_another_window_before_the_post_sends_zero_input() {
        // The restore is accepted but ignored by the compositor: the pre-post check
        // must still see the wrong window and refuse instead of typing blind.
        let rig = focus_rig(true, true);
        rig.desktop.focus_ignores.store(true, Ordering::SeqCst);
        dialogs_move_focus_to(&rig, other_window_of_the_same_process());
        let result = rig.call("type", json!({"text": "nope", "intent": "send the message"}));
        assert!(is_error(&result));
        assert!(!first_text(&result).contains("done"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    // --- T22 (S4): the refusal names both windows, the instructions name the pointer rule, and
    // the key acknowledgement echoes the modifiers.

    #[test]
    fn a_focus_refusal_names_the_bound_window_and_the_window_focused_now() {
        // The live failure read as bad luck ("the focus moved") instead of a cause: the refusal
        // must name the window the last screenshot bound and the one focused now (T22, S4).
        let rig = focus_rig(true, true);
        *rig.desktop.focused_window.lock().unwrap() = Some(terminal_window());
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        let message = first_text(&result);
        assert!(message.contains("window 10"), "{message}");
        assert!(message.contains("org.gnome.TextEditor"), "{message}");
        assert!(message.contains("window 12"), "{message}");
        assert!(message.contains("foot"), "{message}");
        assert!(message.contains("Nothing was sent"), "{message}");
        assert!(!message.contains("done"), "{message}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_partial_delivery_refusal_keeps_the_delivery_claim_and_names_both_windows() {
        // Some events were already delivered: the truthful partial wording stays, and both
        // windows are named so the cause is unambiguous (T22, S4).
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                *desktop.focused_window.lock().unwrap() = Some(terminal_window());
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        assert_eq!(rig.desktop.events().len(), 1, "the second chunk must not be posted");
        let message = first_text(&result);
        assert!(message.contains("were sent"), "{message}");
        assert!(message.contains("window 10"), "{message}");
        assert!(message.contains("org.gnome.TextEditor"), "{message}");
        assert!(message.contains("window 12"), "{message}");
        assert!(message.contains("foot"), "{message}");
        assert!(!message.contains("done"), "{message}");
    }

    #[test]
    fn a_focus_refusal_stays_truthful_when_no_window_is_focused_now() {
        // No window holds the focus at the pre-post check: the bound window is still named and
        // the refusal says the current one is unknown instead of inventing one (T22, S4).
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                *desktop.focused_window.lock().unwrap() = None;
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        let message = first_text(&result);
        assert!(message.contains("were sent"), "{message}");
        assert!(message.contains("window 10"), "{message}");
        assert!(message.contains("org.gnome.TextEditor"), "{message}");
        assert!(message.contains("no window is focused now"), "{message}");
        assert!(!message.contains("done"), "{message}");
    }

    #[test]
    fn the_global_instructions_name_the_pointer_change_of_keyboard_focus() {
        // Niri can focus the window under the pointer, so a move changes which window receives
        // the keyboard: the instructions must ask for a fresh screenshot after moving, without
        // ever claiming the pointer and the focus are the same fact (T22, S4).
        let instructions = global_rig_with(true, true).rpc("initialize", json!({}))["result"]
            ["instructions"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(instructions.contains("moves the keyboard focus"), "{instructions}");
        assert!(instructions.contains("screenshot after moving"), "{instructions}");
    }

    #[test]
    fn the_key_acknowledgement_echoes_the_modifiers() {
        // `Press f` for ctrl+alt+shift+f cannot be audited against the call: the ack must name
        // the combination the call really pressed, in the tool's own spelling (T22, S4).
        let global = focus_rig(true, true);
        let result = global.call("key", json!({"combo": "ctrl+alt+shift+f"}));
        assert!(!is_error(&result), "{result}");
        assert!(first_text(&result).contains("Press ctrl+alt+shift+f in"), "{result}");
        assert_eq!(
            global.desktop.events(),
            vec![InputEvent::Key(parse_combo("ctrl+alt+shift+f").unwrap())]
        );
        // The macOS path shares the acknowledgement wording.
        let mac = rig();
        mac.ready();
        let result = mac.call("key", json!({"combo": "cmd+shift+t"}));
        assert!(first_text(&result).contains("Press cmd+shift+t in Safari"), "{result}");
    }

    #[test]
    fn the_global_key_tool_names_its_function_key_range() {
        // Decision (T22, S4): the range stays f1-f12. The Linux keymap could cover F13-F24
        // cheaply (X11 keysyms 0xffca-0xffd5), but the shared grammar also carries a macOS
        // virtual key code and this tree verifies only f1-f12, so extending is not a table-only
        // change. The desktop-global catalog names the real limit instead.
        let body = global_rig_with(true, true).rpc("tools/list", json!({}));
        let tools = body["result"]["tools"].as_array().unwrap();
        let description = tools.iter().find(|t| t["name"] == "key").unwrap()["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(description.contains("`f1`"), "{description}");
        assert!(description.contains("`f12`"), "{description}");
        assert!(description.contains("`f13`"), "{description}");
        // The documented limit is the real behavior of both sides of the mismatch.
        assert!(parse_combo("f13").is_err(), "the key tool stops at f12");
        assert_eq!(crate::shortcut::normalize("f13"), Ok("F13".to_string()));
    }

    #[test]
    fn two_windows_of_one_process_are_not_interchangeable() {
        let rig = focus_rig(true, true);
        // The dialog moves focus to a second window of the same process; a pid-only
        // restore would consider the job done and type into the wrong window.
        dialogs_move_focus_to(&rig, other_window_of_the_same_process());
        let result = rig.call("key", json!({"combo": "tab", "intent": "send the message"}));
        assert!(!is_error(&result), "{result}");
        assert_eq!(*rig.desktop.focus_restores.lock().unwrap(), vec![10]);
        assert_eq!(rig.desktop.focused_window.lock().unwrap().as_ref().unwrap().window_id, 10);
        assert_eq!(rig.desktop.events(), vec![InputEvent::Key(parse_combo("tab").unwrap())]);
    }

    #[test]
    fn key_and_drag_never_report_an_unverified_success() {
        // A refused keyboard route is a truthful error, never a "done".
        let rig = focus_rig(true, true);
        *rig.desktop.focused_window.lock().unwrap() = Some(own_chat_window());
        let key = rig.call("key", json!({"combo": "tab"}));
        assert!(is_error(&key));
        assert!(!first_text(&key).contains("done"), "{key}");
        assert!(rig.desktop.events().is_empty());
        // A delivered drag claims delivery only; the visible effect is not verified.
        let rig = focus_rig(true, true);
        let result = rig.call("drag", json!({"fromX": 10, "fromY": 10, "toX": 20, "toY": 20}));
        assert!(!is_error(&result), "{result}");
        let text = first_text(&result);
        assert!(text.contains("delivered"), "{text}");
        assert!(text.contains("not verified"), "{text}");
        assert_eq!(rig.desktop.events().len(), 1);
    }

    #[test]
    fn global_keyboard_input_without_a_focus_window_refuses() {
        // No window focus can be named at capture: keyboard input fails closed instead of
        // typing into whatever happens to be focused.
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = None;
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result));
        assert!(!first_text(&result).contains("done"), "{result}");
        assert!(first_text(&result).contains("screenshot"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_window_without_an_owner_pid_is_not_a_keyboard_target() {
        // Niri can report a window with no pid (for example a portal window): the owner
        // cannot be ruled out, so the capture binds no target and typing fails closed.
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(FocusTarget {
            window_id: 21,
            pid: None,
            title: Some("Portal".into()),
            app_id: None,
        });
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result));
        assert!(first_text(&result).contains("does not report its process"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_title_repaint_during_the_capture_keeps_the_keyboard_binding() {
        // Niri can repaint a window's title between the two FocusedWindow reads around one
        // capture (a terminal or editor title updates). The window and its owner are the same,
        // so the binding must hold and the text must reach the editor (T16, S4).
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_capture.lock().unwrap() = Some(Box::new(move || {
            let mut focus = desktop.focused_window.lock().unwrap();
            if let Some(window) = focus.as_mut() {
                window.title = Some("notes.txt*".into());
            }
        }));
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("type", json!({"text": "PRUEBA-NATIVA-OK"}));
        assert!(!is_error(&result), "{result}");
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("PRUEBA-NATIVA-OK".into())]);
    }

    #[test]
    fn a_window_change_during_the_capture_refuses_with_the_moved_cause() {
        // The focus lands on another window while the image is taken: the capture binds nothing
        // and the refusal names the moved focus instead of a generic sentence (T16, S4).
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_capture.lock().unwrap() = Some(Box::new(move || {
            *desktop.focused_window.lock().unwrap() = Some(other_window_of_the_same_process());
        }));
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("type", json!({"text": "nope"}));
        assert!(is_error(&result), "{result}");
        assert!(first_text(&result).contains("moved"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn an_owner_change_during_the_capture_refuses_with_the_moved_cause() {
        // The same window id now belongs to another process: identity and owner must both still
        // hold, so the capture binds nothing and no input is sent (T16, S4).
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_capture.lock().unwrap() = Some(Box::new(move || {
            *desktop.focused_window.lock().unwrap() = Some(FocusTarget {
                window_id: 10,
                pid: Some(777),
                title: Some("Text Editor".into()),
                app_id: Some("org.gnome.TextEditor".into()),
            });
        }));
        assert!(!is_error(&rig.call("screenshot", json!({}))));
        let result = rig.call("key", json!({"combo": "tab"}));
        assert!(is_error(&result), "{result}");
        assert!(first_text(&result).contains("moved"), "{result}");
        assert!(rig.desktop.events().is_empty());
    }

    #[test]
    fn a_batch_keyboard_step_refuses_when_the_target_is_own() {
        // Batch steps take the same path as single calls: the pointer step runs, the
        // keyboard step that follows it never posts.
        let rig = focus_rig(true, true);
        *rig.desktop.focused_window.lock().unwrap() = Some(own_chat_window());
        let result = rig.call(
            "batch",
            batch(json!([
                {"tool": "move", "x": 10, "y": 10},
                {"tool": "type", "text": "nope"},
            ])),
        );
        assert!(is_error(&result));
        assert!(first_text(&result).contains("step 2"), "{result}");
        assert_eq!(rig.desktop.events(), vec![InputEvent::Move(Point { x: 20.0, y: 20.0 })]);
    }

    #[test]
    fn typing_stops_before_the_synthesized_return_when_the_focus_moves_mid_typing() {
        // The first line's text is delivered, then the focus moves: the Return that
        // would follow (and the next line) must never be posted.
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                *desktop.focused_window.lock().unwrap() = Some(other_window_of_the_same_process());
            }
        }));
        let result = rig.call("type", json!({"text": "aaaa\nbbbb"}));
        assert!(is_error(&result), "{result}");
        assert_eq!(rig.desktop.events(), vec![InputEvent::Text("aaaa".into())]);
        let message = first_text(&result);
        assert!(message.contains("was sent") || message.contains("were sent"), "{message}");
        assert!(!message.contains("done"), "{message}");
    }

    #[test]
    fn typing_stops_before_the_next_chunk_when_the_focus_moves_mid_typing() {
        // 25 characters are two chunks of at most 20; only the first may be posted.
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                *desktop.focused_window.lock().unwrap() = Some(own_chat_window());
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        let events = rig.desktop.events();
        assert_eq!(events.len(), 1, "only the first chunk may be posted: {events:?}");
        assert!(matches!(events[0], InputEvent::Text(_)));
        assert!(!first_text(&result).contains("done"), "{result}");
    }

    #[test]
    fn a_zero_or_negative_owner_pid_is_not_a_keyboard_target() {
        for pid in [0, -1, i32::MIN] {
            let rig = global_rig_with(true, true);
            *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
            *rig.desktop.frontmost.lock().unwrap() = None;
            *rig.desktop.focused_window.lock().unwrap() = Some(FocusTarget {
                window_id: 21,
                pid: Some(pid),
                title: Some("Bad owner".into()),
                app_id: None,
            });
            // The capture observes the bad owner and binds no keyboard target.
            assert!(!is_error(&rig.call("screenshot", json!({}))), "pid {pid}");
            let result = rig.call("type", json!({"text": "nope"}));
            assert!(is_error(&result), "pid {pid}: {result}");
            assert!(!first_text(&result).contains("done"), "pid {pid}: {result}");
            assert!(first_text(&result).contains("invalid owner process"), "pid {pid}: {result}");
            assert!(rig.desktop.events().is_empty(), "pid {pid} must send zero input");
        }
    }

    #[test]
    fn a_same_window_id_with_a_changed_owner_is_refused_mid_typing() {
        // The compositor reuses the id for a window of another process: the captured
        // owner must not silently pass on the id alone.
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                *desktop.focused_window.lock().unwrap() = Some(FocusTarget {
                    window_id: 10,
                    pid: Some(777),
                    title: Some("Reused id".into()),
                    app_id: None,
                });
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        assert_eq!(rig.desktop.events().len(), 1, "the second chunk must not be posted");
        assert!(first_text(&result).contains("process this action captured"), "{result}");
    }

    #[test]
    fn a_focus_query_failure_after_the_first_chunk_reports_partial_delivery() {        // The focus query the guard needs fails after the first chunk: exactly one event was
        // delivered, and the error says so instead of claiming nothing happened.
        let rig = focus_rig(true, true);
        let desktop = rig.desktop.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                desktop.focus_query_failure.store(true, Ordering::SeqCst);
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        let events = rig.desktop.events();
        assert_eq!(events.len(), 1, "exactly one event may be delivered: {events:?}");
        let message = first_text(&result);
        assert!(message.contains("were sent"), "{message}");
        assert!(!message.contains("done"), "{message}");
        // The unreadable query must not fabricate the window focused now; the bound one is
        // still named so the refusal has a cause (T22, S4).
        assert!(message.contains("window 10"), "{message}");
        assert!(message.contains("org.gnome.TextEditor"), "{message}");
        assert!(message.contains("unknown"), "{message}");
    }

    #[test]
    fn a_stop_after_the_first_chunk_sends_no_later_event() {
        // Stop mid-typing stops the remaining chunks and synthesized Returns, and reports the
        // stop rather than a fake success.
        let rig = focus_rig(true, true);
        let control = rig.control.clone();
        *rig.desktop.on_post.lock().unwrap() = Some(Box::new(move |count| {
            if count == 1 {
                control.end(Reason::Stopped);
            }
        }));
        let result = rig.call("type", json!({"text": "a".repeat(25)}));
        assert!(is_error(&result), "{result}");
        assert_eq!(rig.desktop.events().len(), 1, "no later chunk or Return may be posted");
        let message = first_text(&result);
        assert!(message.contains("stopped"), "{message}");
        assert!(!message.contains("done"), "{message}");
    }

    #[test]
    fn a_stop_during_the_grant_dialog_does_not_regrant_the_session() {
        let rig = global_rig_with(true, true);
        *rig.desktop.owner_at.lock().unwrap() = Box::new(|_| None);
        *rig.desktop.frontmost.lock().unwrap() = None;
        *rig.desktop.focused_window.lock().unwrap() = Some(editor_window());
        let control = rig.control.clone();
        *rig.dialogs.during.lock().unwrap() = Some(Box::new(move || control.end(Reason::Stopped)));
        // The grant dialog is accepted, but the Stop during it must win: no session reopened.
        let result = rig.call("screenshot", json!({}));
        assert!(is_error(&result), "a grant after Stop must not act: {result}");
        assert!(!rig.control.is_active(rig.clock.now_ms()), "Stop must leave the session inactive");
    }
}
