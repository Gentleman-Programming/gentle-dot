//! The MCP endpoint (S24.1): JSON-RPC 2.0 over streamable HTTP with `initialize`,
//! `tools/list`, and `tools/call`, behind a per-launch bearer token. Each call passes the
//! guards in order: rate limit, permissions, session grant, blocklist, risky-action
//! confirmation; then it acts and returns a fresh screenshot (S24.2–S24.4).
//!
//! `batch` (S24.8) runs up to 20 actions in one call. Each step takes the single tool's path
//! (`perform`) and counts as one action for the rate limit; a full window delays the step
//! instead of refusing it. Coordinates refer to the screenshot taken before the batch, and one
//! screenshot follows it. The first refused, declined, or failed step stops the batch.
//!
//! The glow (S28): once an action's input is posted, `perform` reports where it acted to the
//! glow sink, so a refused, declined, stopped, or failed action (or batch step) reports
//! nothing. The sink only queues the mark; it never changes a check, the order, or a result.

use super::blocklist::{blocked_name, blocked_reason, AppIdentity};
use super::control::Control;
use super::coords::{Point, ScreenshotGeometry};
use super::glow::Mark;
use super::keys::{parse_combo, KeyCombo};
use super::rate::{RateLimiter, MAX_ACTIONS_PER_SECOND};
use super::risk::{assess, Act};
use super::{Clock, Desktop, Dialogs, InputEvent, MouseButton};
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

const STOPPED: &str = "Computer control was stopped; this action was dropped.";
const NOT_ALLOWED: &str = "Computer control was not allowed by the user. Nothing was done.";
const NEEDS_PERMISSION: &str = "Gentle Dot needs the";
const GRANT_IT: &str = "Ask the user to grant it in Connectors → Computer.";
const NEEDS_SCREENSHOT: &str = "Take a screenshot first: coordinates are pixels of the latest screenshot.";
const UNKNOWN_TARGET: &str = "Cannot tell which app is under that point, so the action was refused. \
Take a new screenshot and try again.";

const INSTRUCTIONS: &str = "Controls this Mac. Take a screenshot first; x and y are pixels of the latest \
screenshot. Every action returns a fresh screenshot. Use `batch` for a predictable sequence (click a field, \
type, press tab, type, press return) so it runs in one call; end the batch whenever you must see the screen \
before deciding the next step. The user must allow a session, risky actions ask the user to confirm, and \
some apps (System Settings, password managers) are off limits.";

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

/// The tool catalog (S24.2).
fn tools() -> Value {
    let x = coordinate("Pixels from the left edge of the latest screenshot.");
    let y = coordinate("Pixels from the top edge of the latest screenshot.");
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
        {"name": "scroll", "description": "Scroll at a point. dy > 0 scrolls down and dx > 0 scrolls right, in pixels.",
         "inputSchema": schema(json!({"x": x, "y": y, "dx": {"type": "integer"}, "dy": {"type": "integer"}}), &["x", "y", "dx", "dy"])},
        {"name": "type", "description": "Type text into the frontmost app. A newline presses Return.",
         "inputSchema": schema(json!({"text": {"type": "string"}}), &["text"])},
        {"name": "key", "description": "Press a key combo in the frontmost app, for example `cmd+shift+t`, `return`, or `esc`.",
         "inputSchema": schema(json!({"combo": {"type": "string"}}), &["combo"])},
        {"name": "open_app", "description": "Open or bring forward an app by name or bundle id.",
         "inputSchema": schema(json!({"name": {"type": "string"}}), &["name"])},
        {"name": "list_apps", "description": "List the running apps.",
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
                Tool::Scroll { x, y, dx: delta("dx")?, dy: delta("dy")? }
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

pub struct Helper {
    desktop: Arc<dyn Desktop>,
    dialogs: Arc<dyn Dialogs>,
    clock: Arc<dyn Clock>,
    control: Arc<Control>,
    token: String,
    own_pid: i32,
    limiter: Mutex<RateLimiter>,
    /// Serializes actions and holds the geometry of the latest screenshot.
    actions: Mutex<Option<ScreenshotGeometry>>,
    /// Where an action that went through acted (S28); must return at once.
    glow: Box<dyn Fn(Mark) + Send + Sync>,
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
        }
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
            "tools/list" => Ok(json!({"tools": tools()})),
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
            "instructions": INSTRUCTIONS,
        })
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
            if !self.with_dialog(|| self.dialogs.ask_grant()) {
                return Err(NOT_ALLOWED.into());
            }
            self.control.grant(self.clock.now_ms());
        }
        self.act(epoch, &mut latest, call)
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
            return Err("Screenshots need macOS 14 or later, so computer control is unavailable on this Mac.".into());
        }
        if sees && !permissions.screen_recording {
            return Err(format!("{NEEDS_PERMISSION} Screen Recording permission. {GRANT_IT}"));
        }
        if acts && !permissions.accessibility {
            return Err(format!("{NEEDS_PERMISSION} Accessibility permission. {GRANT_IT}"));
        }
        Ok(())
    }

    /// Runs a dialog, then brings back the app that was in front (a dialog activates Gentle Dot).
    fn with_dialog(&self, dialog: impl FnOnce() -> bool) -> bool {
        let before = self.desktop.frontmost_app();
        let answer = dialog();
        if let Some(before) = before {
            if self.desktop.frontmost_app().map(|app| app.pid) != Some(before.pid) {
                self.desktop.activate(before.pid);
            }
        }
        answer
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
    fn pointer_target(&self, at: Point) -> Result<String, String> {
        let app = self.desktop.window_owner_at(at).ok_or(UNKNOWN_TARGET)?;
        self.refuse_blocked(&app).map(|()| app.name)
    }

    /// The frontmost app and the app owning the focused element (they differ for a
    /// non-activating panel), each refused when blocked. The one receiving the keys, for messages.
    fn keyboard_target(&self) -> Result<String, String> {
        let front = self.desktop.frontmost_app().ok_or("Cannot tell which app is in front.")?;
        self.refuse_blocked(&front)?;
        match self.desktop.focused_app().filter(|focused| focused.pid != front.pid) {
            Some(focused) => self.refuse_blocked(&focused).map(|()| focused.name),
            None => Ok(front.name),
        }
    }

    fn confirm_if_risky(&self, risk: Option<String>, action: &str, target: &str) -> Result<(), String> {
        let Some(reason) = risk else {
            return Ok(());
        };
        // Yolo mode (S24.9), switched on by the user in the app, skips only this confirmation.
        if self.control.yolo(self.clock.now_ms()) {
            return Ok(());
        }
        let message = format!("{action} in {target}.\n\nThis needs your OK because of {reason}.");
        if self.with_dialog(|| self.dialogs.confirm(&message)) {
            Ok(())
        } else {
            Err(format!("The user declined: {action} in {target}. Nothing was done."))
        }
    }

    fn screenshot(&self, latest: &mut Option<ScreenshotGeometry>) -> Result<Content, String> {
        let capture = self.desktop.capture()?;
        let geometry = capture.geometry;
        *latest = Some(geometry);
        let front = self.desktop.frontmost_app().map(|app| app.name);
        let meta = json!({
            "imageWidth": geometry.image_width,
            "imageHeight": geometry.image_height,
            "scale": geometry.scale,
            "frontApp": front,
        });
        let data = base64::engine::general_purpose::STANDARD.encode(&capture.data);
        Ok(vec![json!({"type": "image", "data": data, "mimeType": capture.mime_type}), text(meta.to_string())])
    }

    /// What was done, then a fresh screenshot once the screen settled.
    fn after(&self, latest: &mut Option<ScreenshotGeometry>, done: String, settle_ms: u64) -> Result<Content, String> {
        self.clock.sleep_ms(settle_ms);
        let mut content = vec![text(done)];
        match self.screenshot(latest) {
            Ok(blocks) => content.extend(blocks),
            Err(error) => content.push(text(format!("No screenshot: {error}"))),
        }
        Ok(content)
    }

    fn act(&self, epoch: u64, latest: &mut Option<ScreenshotGeometry>, call: Call) -> Result<Content, Failed> {
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
        latest: &mut Option<ScreenshotGeometry>,
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
        latest: &Option<ScreenshotGeometry>,
        tool: Tool,
        intent: Option<&str>,
    ) -> Result<(String, u64), String> {
        let map = |latest: &Option<ScreenshotGeometry>, (x, y): (f64, f64)| -> Result<Point, String> {
            latest.ok_or(NEEDS_SCREENSHOT)?.to_point(x, y).map_err(|e| e.to_string())
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
                Ok((format!("{action} in {target}: done."), SETTLE_MS))
            }
            Tool::Move { x, y } => {
                let at = map(latest, (x, y))?;
                let target = self.pointer_target(at)?;
                let action = format!("Move the pointer to ({x}, {y})");
                self.confirm_if_risky(assess(Act::Other, intent), &action, &target)?;
                self.post(epoch, InputEvent::Move(at))?;
                (self.glow)(Mark::Move(at));
                Ok((format!("{action}: done."), SETTLE_MS))
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
                Ok((format!("{action}: done."), SETTLE_MS))
            }
            Tool::Scroll { x, y, dx, dy } => {
                let at = map(latest, (x, y))?;
                let target = self.pointer_target(at)?;
                let action = format!("Scroll by ({dx}, {dy}) at ({x}, {y})");
                self.confirm_if_risky(assess(Act::Other, intent), &action, &target)?;
                self.post(epoch, InputEvent::Scroll { at, dx, dy })?;
                (self.glow)(Mark::Scroll(at));
                Ok((format!("{action}: done."), SETTLE_MS))
            }
            Tool::Type { text: typed } => {
                let target = self.keyboard_target()?;
                let typed = typed.replace("\r\n", "\n").replace('\r', "\n");
                let focus = self.desktop.focused_element();
                let action = format!("Type {} characters", typed.chars().count());
                self.confirm_if_risky(assess(Act::Type(&typed, focus.as_ref()), intent), &action, &target)?;
                let return_key = parse_combo("return")?;
                for (i, line) in typed.split('\n').enumerate() {
                    if i > 0 {
                        self.post(epoch, InputEvent::Key(return_key))?;
                    }
                    for chunk in chunks(line) {
                        self.post(epoch, InputEvent::Text(chunk))?;
                    }
                }
                // The glow marks posted input only; an empty text posts none.
                if !typed.is_empty() {
                    (self.glow)(Mark::Key);
                }
                Ok((format!("{action} in {target}: done."), SETTLE_MS))
            }
            Tool::Key { combo } => {
                let target = self.keyboard_target()?;
                let focus = self.desktop.focused_element();
                let act = if combo.is_return() {
                    Act::Return(focus.as_ref())
                } else if combo.is_space() {
                    Act::Space(focus.as_ref())
                } else {
                    Act::Other
                };
                let action = format!("Press {}", combo.key);
                self.confirm_if_risky(assess(act, intent), &action, &target)?;
                self.post(epoch, InputEvent::Key(combo))?;
                (self.glow)(Mark::Key);
                Ok((format!("{action} in {target}: done."), SETTLE_MS))
            }
            Tool::OpenApp { name } => {
                if let Some(label) = blocked_name(&name) {
                    return Err(format!("Gentle Dot does not control {label}. The app was not opened."));
                }
                let action = format!("Open {name}");
                self.confirm_if_risky(assess(Act::Other, intent), &action, "macOS")?;
                self.still_running(epoch)?;
                self.desktop.open_app(&name)?;
                Ok((format!("{action}: done."), OPEN_APP_SETTLE_MS))
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
    }

    fn rig_with(allow: bool, confirm: bool) -> Rig {
        let desktop = Arc::new(FakeDesktop::default());
        let dialogs = Arc::new(FakeDialogs::new(allow, confirm));
        let clock = Arc::new(FakeClock::new(NOW));
        let states = Arc::new(Mutex::new(Vec::new()));
        let sink = states.clone();
        let control = Arc::new(Control::new(move |event| sink.lock().unwrap().push(event.clone())));
        let marks = Arc::new(Mutex::new(Vec::new()));
        let (seen, posted) = (marks.clone(), desktop.clone());
        let helper =
            Helper::new(desktop.clone(), dialogs.clone(), clock.clone(), control.clone(), TOKEN.into(), OWN_PID)
                .with_glow(move |mark| seen.lock().unwrap().push((mark, posted.events().len())));
        Rig { helper, desktop, dialogs, clock, control, states, marks }
    }

    /// A rig whose helper has no glow sink, as before S28.
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
        let wait = tools.iter().find(|t| t["name"] == "wait").unwrap();
        assert_eq!(wait["inputSchema"]["properties"]["ms"]["maximum"], 5000);
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
        }
    }
}
