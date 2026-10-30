//! The private channel to the daemon this app launched (S25.1–S25.3). When the app spawns the
//! daemon it creates a connected pair of Unix sockets and hands one end to the daemon as fd 3
//! (`daemon::spawn_daemon`); it keeps the other. On Windows, where there is no fd 3, it creates a
//! single-instance named pipe before it spawns the daemon and hands the daemon the pipe's name in
//! `GENTLE_DOT_CHANNEL_PIPE`; the accepted connection's PID, matched against the child the app
//! spawned, is the credential. That name is not a secret, and the pipe does listen; the retained
//! handle and the PID check are what authenticate (W7c documents the trust model). The frame,
//! pending and secret logic below is one rule both platforms share; only the transport differs
//! (`windows`). A daemon the app only attached to gets no channel.
//! Frames are line-delimited JSON in both directions; each side numbers its own requests:
//!   {"kind":"request","id":1,"method":"command","params":{"clientId":"…","message":{…}}}
//!   {"kind":"response","id":1,"result":{}}  or  {"kind":"response","id":1,"error":"…"}
//! The app sends `command` (a privileged message from the panel, on behalf of its window),
//! `computer_register`, and `computer_unregister`. The daemon sends `approve` with an
//! [`ApprovalRequest`]; the app shows the native dialog on a worker thread (never the main thread)
//! and answers `{"approved": bool}`. A failed dialog, malformed request, or closed channel refuses.
//!
//! The daemon also keeps connector secrets in the app's secure store (S25.5), on worker threads too:
//! `secret_get {id}` answers `{"secret": …}` or `null`, `secret_put {id, secret}` answers `{}`,
//! `secret_delete {id}` answers `{"deleted": bool}`, and `secret_list` answers `{"ids": […]}`.
//! Ids are checked with [`check_id`]; a refusal names what failed and never the secret, and nothing
//! about a secret request is logged. The answer goes back over this channel only.

use crate::approvals::ApprovalRequest;
use crate::secure_store::{check_id, Secret, SecretStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::Duration;

#[cfg(windows)]
pub(crate) mod windows;

/// Where the daemon finds its end of the channel.
pub const APP_FD: i32 = 3;
/// A command may wait for a native confirmation (120 s) before the daemon answers.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(150);
/// Registering the computer helper waits for the daemon to start reading the channel.
pub const REGISTER_TIMEOUT: Duration = Duration::from_secs(60);
/// A frame longer than this closes the channel. The daemon has the same rule, and a closed channel
/// stops the daemon (S35.2), so neither side ever sends a longer one: an oversized request fails
/// here without being written, and an oversized answer goes out as an error instead.
const MAX_FRAME: u64 = 1024 * 1024;
/// Why a frame was not sent.
const TOO_LARGE: &str = "too large to send to the assistant";

/// What the panel may ask the daemon through the app (S25.2): connector changes, approving a draft
/// (declining one any window may), and importing. The computer helper is registered by the app.
pub const PANEL_COMMANDS: &[&str] = &[
    "connector_connect",
    "connector_signin",
    "connector_setup",
    "connector_disconnect",
    "connector_remove",
    "connector_mode",
    "connector_draft_reply",
    "connector_import",
];

/// Why the panel cannot change connectors: the daemon was not started by this app.
pub const NO_CHANNEL: &str = "Gentle Dot did not start this assistant, so its connectors cannot be changed from here. \
Quit the assistant that is running and open Gentle Dot again.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// True for a panel message the app forwards: one of [`PANEL_COMMANDS`] with an object shape.
pub fn is_panel_command(message: &Value) -> bool {
    message.get("type").and_then(Value::as_str).is_some_and(|kind| PANEL_COMMANDS.contains(&kind))
}

/// What the app does for the daemon: native approvals, and setup once the channel is open.
pub trait Handler: Send + Sync {
    /// Shows the native dialog and blocks until the answer; true only when the user allowed it.
    fn approve(&self, request: &ApprovalRequest) -> bool;
    /// The channel to a freshly spawned daemon is open (for example, register the computer helper).
    fn opened(&self, _channel: &Arc<AppChannel>) {}
    /// Where connector secrets live (the Keychain on macOS); `None` refuses secret requests.
    fn secrets(&self) -> Option<&dyn SecretStore> {
        None
    }
}

/// The id (and, for `secret_put`, the secret) of a secret request. Shows the id only.
pub(crate) struct SecretParams {
    id: String,
    secret: Option<Secret>,
}

impl std::fmt::Debug for SecretParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretParams").field("id", &self.id).field("secret", &self.secret).finish()
    }
}

impl SecretParams {
    /// Reads `{id, secret?}` by hand, so a refusal never repeats a value the daemon sent.
    pub(crate) fn parse(params: &Value) -> Result<Self, String> {
        let id = params.get("id").and_then(Value::as_str).ok_or("A secret request needs an id.")?;
        check_id(id).map_err(|error| error.to_string())?;
        let secret = match params.get("secret") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(Secret::new(text.as_str())),
            Some(_) => return Err("A secret must be text.".into()),
        };
        Ok(SecretParams { id: id.to_owned(), secret })
    }
}

/// Answers one secret request from `store`. Errors name what failed, never a secret.
pub(crate) fn serve_secret(store: &dyn SecretStore, method: &str, params: &Value) -> Result<Value, String> {
    if method == "secret_list" {
        return store.list_ids().map(|ids| json!({ "ids": ids })).map_err(|error| error.to_string());
    }
    let request = SecretParams::parse(params)?;
    let failed = |error: crate::secure_store::StoreError| error.to_string();
    match method {
        "secret_get" => Ok(match store.get(&request.id).map_err(failed)? {
            Some(secret) => json!({ "secret": secret.expose() }),
            None => Value::Null,
        }),
        "secret_put" => {
            let secret = request.secret.as_ref().ok_or("A secret to store is needed.")?;
            store.put(&request.id, secret).map_err(failed)?;
            Ok(json!({}))
        }
        "secret_delete" => Ok(json!({ "deleted": store.delete(&request.id).map_err(failed)? })),
        other => Err(format!("Unknown request: {other}")),
    }
}

type Reply = mpsc::Sender<Result<Value, String>>;

/// The app's end of the channel, over either transport. The frame, pending and secret rules are
/// shared; only the transport (`start`) and the way `close` unblocks in-flight I/O differ.
pub struct AppChannel {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    open: AtomicBool,
    /// Unblocks a read or write that is already in progress when `close` runs: a Unix socket
    /// shutdown, or a Windows `CancelIoEx` per direction.
    shutdown: Box<dyn Fn() + Send + Sync>,
}

impl AppChannel {
    /// Spawns the read loop over `reader` and shares it with the returned channel.
    fn spawn<R: Read + Send + 'static>(
        reader: R,
        writer: Box<dyn Write + Send>,
        shutdown: Box<dyn Fn() + Send + Sync>,
        handler: Arc<dyn Handler>,
    ) -> io::Result<Arc<Self>> {
        let channel = Arc::new(AppChannel {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            open: AtomicBool::new(true),
            shutdown,
        });
        let reading = channel.clone();
        std::thread::Builder::new()
            .name("app-channel".into())
            .spawn(move || reading.read(reader, handler))?;
        Ok(channel)
    }

    /// The app's end of the fd-3 Unix socketpair. Reads `stream` on a thread of its own.
    #[cfg(unix)]
    pub fn start(stream: UnixStream, handler: Arc<dyn Handler>) -> io::Result<Arc<Self>> {
        let reader = stream.try_clone()?;
        let shutdown = stream.try_clone()?;
        Self::spawn(
            reader,
            Box::new(stream),
            Box::new(move || {
                let _ = shutdown.shutdown(Shutdown::Both);
            }),
            handler,
        )
    }

    /// The app's end of the Windows named pipe accepted from the daemon this app spawned.
    #[cfg(windows)]
    pub fn start(connected: windows::Connected, handler: Arc<dyn Handler>) -> io::Result<Arc<Self>> {
        let windows::Connected { reader, writer, read_cancel, write_cancel } = connected;
        Self::spawn(
            reader,
            Box::new(writer),
            Box::new(move || {
                let _ = read_cancel.cancel();
                let _ = write_cancel.cancel();
            }),
            handler,
        )
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Sends a request and waits for its answer, the timeout, or the channel closing.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_open() {
            return Err("The assistant's channel is closed.".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, answer) = mpsc::channel();
        self.pending().insert(id, reply);
        if let Err(error) = self.write(&Frame::Request { id, method: method.into(), params }) {
            self.pending().remove(&id);
            if error.kind() == io::ErrorKind::InvalidInput {
                return Err(format!("This request is {TOO_LARGE}."));
            }
            return Err(format!("The assistant could not be reached: {error}"));
        }
        let result = answer.recv_timeout(timeout);
        self.pending().remove(&id);
        match result {
            Ok(answer) => answer,
            Err(mpsc::RecvTimeoutError::Timeout) => Err("The assistant did not answer in time.".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("The assistant's channel is closed.".into()),
        }
    }

    /// A panel message on behalf of the window `client_id`; anything but [`PANEL_COMMANDS`] is refused here.
    pub fn command(&self, client_id: &str, message: Value) -> Result<(), String> {
        if !is_panel_command(&message) {
            return Err("Only connector changes go through the app.".into());
        }
        self.request("command", json!({"clientId": client_id, "message": message}), COMMAND_TIMEOUT).map(|_| ())
    }

    pub fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
        (self.shutdown)();
        // Dropping the senders wakes every waiting request.
        self.pending().clear();
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Reply>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes one frame; one longer than [`MAX_FRAME`] is refused (`InvalidInput`) and nothing is written.
    fn write(&self, frame: &Frame) -> io::Result<()> {
        let mut line = serde_json::to_vec(frame).map_err(io::Error::other)?;
        if line.len() as u64 > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, TOO_LARGE));
        }
        line.push(b'\n');
        self.writer.lock().unwrap_or_else(PoisonError::into_inner).write_all(&line)
    }

    fn read<R: Read + Send + 'static>(self: Arc<Self>, reader: R, handler: Arc<dyn Handler>) {
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader).take(MAX_FRAME + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.last() != Some(&b'\n') => {
                    eprintln!("gentle-dot: the assistant's channel sent a frame that is too long; closing it");
                    break;
                }
                Ok(_) => {}
            }
            match serde_json::from_slice::<Frame>(&line) {
                Ok(Frame::Response { id, result, error }) => {
                    if let Some(reply) = self.pending().remove(&id) {
                        let _ = reply.send(match error {
                            Some(error) => Err(error),
                            None => Ok(result.unwrap_or(Value::Null)),
                        });
                    }
                }
                Ok(Frame::Request { id, method, params }) => {
                    let (channel, handler) = (self.clone(), handler.clone());
                    // A dialog blocks until the user answers: never on this thread or the main one.
                    let spawned = std::thread::Builder::new()
                        .name("app-channel-request".into())
                        .spawn(move || channel.answer(id, &method, params, handler.as_ref()));
                    if spawned.is_err() {
                        let _ = self.write(&Frame::Response { id, result: None, error: Some("busy".into()) });
                    }
                }
                Err(_) => eprintln!("gentle-dot: the assistant's channel sent a frame that is not understood"),
            }
        }
        self.close();
    }

    fn answer(&self, id: u64, method: &str, params: Value, handler: &dyn Handler) {
        let frame = match method {
            "approve" => {
                let approved = serde_json::from_value::<ApprovalRequest>(params).is_ok_and(|r| handler.approve(&r));
                Frame::Response { id, result: Some(json!({"approved": approved})), error: None }
            }
            "secret_get" | "secret_put" | "secret_delete" | "secret_list" => {
                let answer = match handler.secrets() {
                    Some(store) => serve_secret(store, method, &params),
                    None => Err("This app has no secure store for connector secrets.".into()),
                };
                match answer {
                    Ok(result) => Frame::Response { id, result: Some(result), error: None },
                    Err(error) => Frame::Response { id, result: None, error: Some(error) },
                }
            }
            other => Frame::Response { id, result: None, error: Some(format!("Unknown request: {other}")) },
        };
        if self.write(&frame).is_err_and(|error| error.kind() == io::ErrorKind::InvalidInput) {
            let refused = Frame::Response { id, result: None, error: Some(format!("The answer is {TOO_LARGE}.")) };
            let _ = self.write(&refused);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::approvals::fake::{Answer, FakePrompt};
    use crate::approvals::{Approvals, Decision};
    use crate::secure_store::{MemoryStore, MAX_ID_LEN};
    use std::time::Instant;

    /// The daemon's side of the pair, read and written frame by frame.
    struct FakeDaemon {
        reader: BufReader<UnixStream>,
        writer: UnixStream,
    }

    impl FakeDaemon {
        fn next(&mut self) -> Frame {
            let mut line = String::new();
            self.reader.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line:?}"))
        }

        fn send(&mut self, frame: &Frame) {
            writeln!(self.writer, "{}", serde_json::to_string(frame).unwrap()).unwrap();
        }
    }

    #[derive(Default)]
    struct Recorder {
        asked: Mutex<Vec<ApprovalRequest>>,
        answer: AtomicBool,
        main_thread: AtomicBool,
    }

    impl Handler for Recorder {
        fn approve(&self, request: &ApprovalRequest) -> bool {
            if std::thread::current().name() == Some("main") {
                self.main_thread.store(true, Ordering::SeqCst);
            }
            self.asked.lock().unwrap().push(request.clone());
            self.answer.load(Ordering::SeqCst)
        }
    }

    fn pair(handler: Arc<dyn Handler>) -> (Arc<AppChannel>, FakeDaemon) {
        let (app, daemon) = UnixStream::pair().unwrap();
        let channel = AppChannel::start(app, handler).unwrap();
        let reader = BufReader::new(daemon.try_clone().unwrap());
        (channel, FakeDaemon { reader, writer: daemon })
    }

    #[test]
    fn frames_are_tagged_json_lines() {
        let request = Frame::Request { id: 1, method: "command".into(), params: json!({"clientId": "w"}) };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({"kind": "request", "id": 1, "method": "command", "params": {"clientId": "w"}})
        );
        let ok: Frame = serde_json::from_str(r#"{"kind":"response","id":2,"result":{}}"#).unwrap();
        assert_eq!(ok, Frame::Response { id: 2, result: Some(json!({})), error: None });
        let failed: Frame = serde_json::from_str(r#"{"kind":"response","id":3,"error":"no"}"#).unwrap();
        assert_eq!(failed, Frame::Response { id: 3, result: None, error: Some("no".into()) });
    }

    #[test]
    fn only_connector_changes_are_panel_commands() {
        for kind in PANEL_COMMANDS {
            assert!(is_panel_command(&json!({"type": kind})), "{kind}");
        }
        for kind in ["send", "ui_response", "computer_register", "computer_unregister", "connectors_list", "auth_reply"] {
            assert!(!is_panel_command(&json!({"type": kind})), "{kind}");
        }
        assert!(!is_panel_command(&json!("connector_mode")));
        assert!(!is_panel_command(&json!({"type": 1})));
    }

    #[test]
    fn a_command_goes_to_the_daemon_for_its_window_and_waits_for_the_answer() {
        let (channel, mut daemon) = pair(Arc::new(Recorder::default()));
        let message = json!({"type": "connector_mode", "connectorId": "notion", "mode": "read_write"});
        let sender = {
            let channel = channel.clone();
            let message = message.clone();
            std::thread::spawn(move || channel.command("window-1", message))
        };
        let Frame::Request { id, method, params } = daemon.next() else { panic!("not a request") };
        assert_eq!(method, "command");
        assert_eq!(params, json!({"clientId": "window-1", "message": message}));
        daemon.send(&Frame::Response { id, result: Some(json!({})), error: None });
        assert_eq!(sender.join().unwrap(), Ok(()));

        let refused = std::thread::spawn({
            let channel = channel.clone();
            move || channel.command("window-1", json!({"type": "connector_remove", "connectorId": "x"}))
        });
        let Frame::Request { id, .. } = daemon.next() else { panic!("not a request") };
        daemon.send(&Frame::Response { id, result: None, error: Some("That window is gone.".into()) });
        assert_eq!(refused.join().unwrap(), Err("That window is gone.".into()));
    }

    #[test]
    fn a_message_that_is_not_a_connector_change_never_leaves_the_app() {
        let (channel, daemon) = pair(Arc::new(Recorder::default()));
        let sent = channel.command("w", json!({"type": "computer_register", "url": "http://127.0.0.1:1/mcp", "token": "t"}));
        assert!(sent.is_err());
        assert!(channel.command("w", json!({"type": "send", "text": "hi"})).is_err());
        daemon.writer.set_nonblocking(true).unwrap();
        let mut buf = [0u8; 1];
        assert!(matches!((&daemon.writer).read(&mut buf), Err(e) if e.kind() == io::ErrorKind::WouldBlock));
    }

    #[test]
    fn the_daemon_asks_for_approvals_answered_off_the_main_thread() {
        let recorder = Arc::new(Recorder::default());
        let (_channel, mut daemon) = pair(recorder.clone());
        let request = json!({"connector": "Notion", "action": "create pages", "preview": [{"name": "title", "value": "Plan"}]});
        recorder.answer.store(true, Ordering::SeqCst);
        daemon.send(&Frame::Request { id: 7, method: "approve".into(), params: request.clone() });
        assert_eq!(daemon.next(), Frame::Response { id: 7, result: Some(json!({"approved": true})), error: None });
        recorder.answer.store(false, Ordering::SeqCst);
        daemon.send(&Frame::Request { id: 8, method: "approve".into(), params: request });
        assert_eq!(daemon.next(), Frame::Response { id: 8, result: Some(json!({"approved": false})), error: None });
        assert_eq!(recorder.asked.lock().unwrap()[0].connector, "Notion");
        assert!(!recorder.main_thread.load(Ordering::SeqCst));
    }

    #[test]
    fn a_malformed_approval_or_an_unknown_request_is_refused_without_asking() {
        let recorder = Arc::new(Recorder::default());
        recorder.answer.store(true, Ordering::SeqCst);
        let (_channel, mut daemon) = pair(recorder.clone());
        daemon.send(&Frame::Request { id: 1, method: "approve".into(), params: json!({"connector": 5}) });
        assert_eq!(daemon.next(), Frame::Response { id: 1, result: Some(json!({"approved": false})), error: None });
        daemon.send(&Frame::Request { id: 2, method: "open_everything".into(), params: json!({}) });
        assert!(matches!(daemon.next(), Frame::Response { id: 2, result: None, error: Some(_) }));
        assert!(recorder.asked.lock().unwrap().is_empty());
    }

    /// The approvals module behind the channel: one native dialog with the request's preview.
    struct Native(Approvals);

    impl Handler for Native {
        fn approve(&self, request: &ApprovalRequest) -> bool {
            self.0.confirm(request) == Decision::Approved
        }
    }

    #[test]
    fn approvals_reach_the_native_dialog_and_its_answer_goes_back() {
        let prompt = Arc::new(FakePrompt::new([Answer::After(Duration::ZERO, true), Answer::After(Duration::ZERO, false)]));
        let native = Native(Approvals::new(prompt.clone(), Duration::from_secs(5)));
        let (_channel, mut daemon) = pair(Arc::new(native));
        let request = json!({"connector": "Slack", "action": "send message", "preview": [{"name": "channel", "value": "#general"}]});
        daemon.send(&Frame::Request { id: 1, method: "approve".into(), params: request.clone() });
        assert_eq!(daemon.next(), Frame::Response { id: 1, result: Some(json!({"approved": true})), error: None });
        daemon.send(&Frame::Request { id: 2, method: "approve".into(), params: request });
        assert_eq!(daemon.next(), Frame::Response { id: 2, result: Some(json!({"approved": false})), error: None });
        assert_eq!(prompt.shown_titles(), ["Allow Slack to send message?", "Allow Slack to send message?"]);
        assert!(prompt.shown.lock().unwrap()[0].message.contains("channel: #general"));
    }

    /// A handler with the in-memory secure store, as the app has the Keychain.
    #[derive(Default)]
    struct WithStore {
        store: MemoryStore,
    }

    impl Handler for WithStore {
        fn approve(&self, _: &ApprovalRequest) -> bool {
            false
        }

        fn secrets(&self) -> Option<&dyn SecretStore> {
            Some(&self.store)
        }
    }

    fn ask(daemon: &mut FakeDaemon, id: u64, method: &str, params: Value) -> Frame {
        daemon.send(&Frame::Request { id, method: method.into(), params });
        daemon.next()
    }

    #[test]
    fn the_daemon_stores_reads_lists_and_deletes_secrets_in_the_apps_store() {
        let handler = Arc::new(WithStore::default());
        let (_channel, mut daemon) = pair(handler.clone());
        let id = "connector/discord/value/token";
        let ok = |id, result| Frame::Response { id, result: Some(result), error: None };
        assert_eq!(ask(&mut daemon, 1, "secret_put", json!({"id": id, "secret": "xoxb-123"})), ok(1, json!({})));
        assert_eq!(handler.store.get(id).unwrap().unwrap().expose(), "xoxb-123");
        assert_eq!(ask(&mut daemon, 2, "secret_get", json!({"id": id})), ok(2, json!({"secret": "xoxb-123"})));
        assert_eq!(ask(&mut daemon, 3, "secret_list", json!({})), ok(3, json!({"ids": [id]})));
        assert_eq!(ask(&mut daemon, 4, "secret_delete", json!({"id": id})), ok(4, json!({"deleted": true})));
        assert_eq!(ask(&mut daemon, 5, "secret_delete", json!({"id": id})), ok(5, json!({"deleted": false})));
        // A missing secret is `"result": null` on the wire (which reads back as no result), not an error.
        assert_eq!(ask(&mut daemon, 6, "secret_get", json!({"id": id})), Frame::Response { id: 6, result: None, error: None });
        let line = serde_json::to_string(&Frame::Response { id: 6, result: Some(Value::Null), error: None }).unwrap();
        assert_eq!(line, r#"{"kind":"response","id":6,"result":null}"#);
    }

    #[test]
    fn secret_ids_are_checked_and_malformed_requests_refused_without_echoing_the_secret() {
        let handler = Arc::new(WithStore::default());
        let (_channel, mut daemon) = pair(handler.clone());
        let refused = |frame: Frame| match frame {
            Frame::Response { result: None, error: Some(error), .. } => error,
            other => panic!("not refused: {other:?}"),
        };
        for (n, params) in [
            json!({"id": "has space", "secret": "hunter2-secret"}),
            json!({"id": "../x\n", "secret": "hunter2-secret"}),
            json!({"id": "x".repeat(MAX_ID_LEN + 1), "secret": "hunter2-secret"}),
            json!({"id": "ok/id", "secret": 7_123_456}),
            json!({"id": "ok/id"}),
            json!({"secret": "hunter2-secret"}),
            json!("hunter2-secret"),
        ]
        .into_iter()
        .enumerate()
        {
            let error = refused(ask(&mut daemon, n as u64 + 1, "secret_put", params));
            assert!(!error.contains("hunter2") && !error.contains("7123456"), "{error}");
        }
        assert_eq!(refused(ask(&mut daemon, 20, "secret_get", json!({"id": "a b"}))), "invalid secret id");
        assert!(handler.store.list_ids().unwrap().is_empty());

        // An app without a secure store refuses every secret request.
        let (_channel, mut bare) = pair(Arc::new(Recorder::default()));
        assert!(refused(ask(&mut bare, 1, "secret_get", json!({"id": "ok/id"}))).contains("secure store"));
    }

    #[test]
    fn secret_requests_and_their_answers_never_show_the_secret_in_debug_output() {
        let params = SecretParams::parse(&json!({"id": "slack/bot", "secret": "xoxb-very-secret"})).unwrap();
        let shown = format!("{params:?}");
        assert!(shown.contains("slack/bot") && !shown.contains("xoxb"), "{shown}");
        let store = MemoryStore::new();
        serve_secret(&store, "secret_put", &json!({"id": "slack/bot", "secret": "xoxb-very-secret"})).unwrap();
        assert!(!format!("{store:?}").contains("xoxb"));
    }

    #[test]
    fn a_request_without_an_answer_times_out() {
        let (channel, mut daemon) = pair(Arc::new(Recorder::default()));
        let started = Instant::now();
        let result = channel.request("computer_register", json!({}), Duration::from_millis(200));
        assert!(result.is_err());
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(matches!(daemon.next(), Frame::Request { .. }));
    }

    #[test]
    fn when_the_daemon_goes_away_waiting_requests_fail_and_the_channel_is_closed() {
        let (channel, daemon) = pair(Arc::new(Recorder::default()));
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("computer_register", json!({}), Duration::from_secs(10))
        });
        std::thread::sleep(Duration::from_millis(100));
        drop(daemon);
        assert!(waiting.join().unwrap().is_err());
        let deadline = Instant::now() + Duration::from_secs(2);
        while channel.is_open() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!channel.is_open());
        assert!(channel.command("w", json!({"type": "connector_disconnect", "connectorId": "notion"})).is_err());
    }

    #[test]
    fn a_frame_the_daemon_would_refuse_is_never_sent_and_the_channel_stays_open() {
        // The daemon closes the channel on a frame over 1 MiB, and then stops (S35.2).
        let (channel, mut daemon) = pair(Arc::new(Recorder::default()));
        let huge = json!({"type": "connector_setup", "connectorId": "slack", "pad": "x".repeat(1024 * 1024)});
        let refused = channel.command("w", huge).unwrap_err();
        assert!(refused.contains("too large"), "{refused}");
        assert!(channel.is_open());
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("computer_unregister", json!({}), Duration::from_secs(5))
        });
        // The first frame the daemon reads is the small request, not a piece of the large one.
        let Frame::Request { id, method, .. } = daemon.next() else { panic!("expected a request") };
        assert_eq!(method, "computer_unregister");
        daemon.send(&Frame::Response { id, result: Some(json!({})), error: None });
        assert_eq!(waiting.join().unwrap(), Ok(json!({})));
    }

    #[test]
    fn an_answer_too_large_for_the_daemon_becomes_an_error() {
        let handler = Arc::new(WithStore::default());
        let id = "connector/big/value/token";
        handler.store.put(id, &Secret::new("x".repeat(1024 * 1024).as_str())).unwrap();
        let (channel, mut daemon) = pair(handler);
        let Frame::Response { id: answered, result, error } = ask(&mut daemon, 7, "secret_get", json!({"id": id})) else {
            panic!("expected a response")
        };
        assert_eq!(answered, 7);
        assert_eq!(result, None);
        assert!(error.as_deref().is_some_and(|e| e.contains("too large")), "{error:?}");
        assert!(channel.is_open());
    }

    #[test]
    fn closing_the_channel_ends_the_daemons_side() {
        let (channel, mut daemon) = pair(Arc::new(Recorder::default()));
        channel.close();
        let mut line = String::new();
        assert_eq!(daemon.reader.read_line(&mut line).unwrap(), 0);
        assert!(!channel.is_open());
    }
}

/// The Windows transport's own tests (W7b): the named pipe is created before the spawn, only the
/// child's PID is accepted, and `close` settles in-flight I/O. These compile and run on Windows
/// only; the Unix fd-3 arm is covered by the module above.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::approvals::ApprovalRequest;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    /// Records every approval the daemon asks for; always allows.
    #[derive(Default)]
    struct Recording {
        asked: Mutex<Vec<ApprovalRequest>>,
    }

    impl Handler for Recording {
        fn approve(&self, request: &ApprovalRequest) -> bool {
            self.asked.lock().unwrap().push(request.clone());
            true
        }
    }

    fn read_frame<R: BufRead>(reader: &mut R) -> Frame {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
    }

    fn write_frame<W: Write>(writer: &mut W, frame: &Frame) {
        writeln!(writer, "{}", serde_json::to_string(frame).unwrap()).unwrap();
    }

    /// A connected endpoint and the other process's end, both in this test process, so the PID
    /// check accepts it. The client half is returned so a test can read and write as the daemon.
    fn same_process_connected() -> (windows::Connected, std::fs::File) {
        let server = windows::ServerEndpoint::create().unwrap();
        let name = server.name().to_string();
        let client = std::thread::spawn(move ||{
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match std::fs::OpenOptions::new().read(true).write(true).open(&name) {
                    Ok(file) => return file,
                    Err(error) => {
                        assert!(Instant::now() < deadline, "client could not connect: {error}");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });
        let connected =
            server.accept(std::process::id(), || true, Instant::now() + Duration::from_secs(10)).unwrap();
        let client = client.join().unwrap();
        (connected, client)
    }

    /// Connects to a pipe by name, retrying while the app creates it.
    fn connect_client(name: &str) -> std::fs::File {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(name) {
                Ok(file) => return file,
                Err(error) => {
                    assert!(Instant::now() < deadline, "could not connect to the channel: {error}");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }

    #[test]
    fn a_named_pipe_channel_round_trips_requests_and_responses() {
        let (connected, client) = same_process_connected();
        let handler = Arc::new(Recording::default());
        let channel = AppChannel::start(connected, handler.clone()).unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut writer = client;

        // App to daemon: a request, answered by the fake daemon.
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("ping", json!({}), Duration::from_secs(5))
        });
        let Frame::Request { id, method, .. } = read_frame(&mut reader) else { panic!("expected a request") };
        assert_eq!(method, "ping");
        write_frame(&mut writer, &Frame::Response { id, result: Some(json!({"ok": true})), error: None });
        assert_eq!(waiting.join().unwrap(), Ok(json!({"ok": true})));

        // Daemon to app: a request, answered by the channel's handler.
        let request = json!({"connector": "Notion", "action": "create pages", "preview": [{"name": "title", "value": "Plan"}]});
        write_frame(&mut writer, &Frame::Request { id: 9, method: "approve".into(), params: request });
        let Frame::Response { id, result, error } = read_frame(&mut reader) else { panic!("expected a response") };
        assert_eq!(id, 9);
        assert_eq!(result, Some(json!({"approved": true})));
        assert_eq!(error, None);
        assert_eq!(handler.asked.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_frame_over_the_cap_is_never_written() {
        let (connected, client) = same_process_connected();
        let channel = AppChannel::start(connected, Arc::new(Recording::default())).unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut writer = client;
        let huge = json!({"type": "connector_setup", "connectorId": "slack", "pad": "x".repeat(MAX_FRAME as usize)});
        let refused = channel.command("w", huge).unwrap_err();
        assert!(refused.contains("too large"), "{refused}");
        assert!(channel.is_open());
        // The first frame the daemon reads is the next small request, not a piece of the large one.
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("ping", json!({}), Duration::from_secs(5))
        });
        let Frame::Request { id, method, .. } = read_frame(&mut reader) else { panic!("expected a request") };
        assert_eq!(method, "ping");
        write_frame(&mut writer, &Frame::Response { id, result: Some(json!({})), error: None });
        assert_eq!(waiting.join().unwrap(), Ok(json!({})));
    }

    #[test]
    fn close_wakes_a_request_blocked_on_a_full_pipe() {
        let (connected, _client) = same_process_connected();
        let channel = AppChannel::start(connected, Arc::new(Recording::default())).unwrap();
        // 200 KiB is under the cap but far past the 4 KiB pipe buffer, and nobody reads it.
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("ping", json!({"pad": "x".repeat(200_000)}), Duration::from_secs(30))
        });
        std::thread::sleep(Duration::from_millis(200));
        channel.close();
        assert!(waiting.join().unwrap().is_err());
    }

    #[test]
    fn a_blocked_read_is_woken_by_its_cancellation() {
        let (connected, _client) = same_process_connected();
        let windows::Connected { mut reader, writer, read_cancel, write_cancel } = connected;
        // Keep the write half and the client alive so the read truly blocks instead of seeing EOF.
        let _keep = (writer, write_cancel, _client);
        let (done, wait) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            let mut buffer = [0u8; 16];
            let _ = done.send(reader.read(&mut buffer));
        });
        std::thread::sleep(Duration::from_millis(100));
        read_cancel.cancel().unwrap();
        let result = wait.recv_timeout(Duration::from_secs(5)).expect("the read was not woken");
        assert!(result.is_err() || result.unwrap() == 0);
        reading.join().unwrap();
    }

    /// The peer-process fixture, dispatched by env var and a no-op in a normal run.
    #[test]
    fn windows_channel_peer_fixture() {
        let Ok(role) = std::env::var("GENTLE_DOT_TEST_CHANNEL_ROLE") else { return };
        let name = std::env::var("GENTLE_DOT_TEST_CHANNEL_PIPE").expect("a pipe name");
        if role != "daemon" {
            return;
        }
        if let Ok(delay) = std::env::var("GENTLE_DOT_TEST_CHANNEL_DELAY_MS") {
            std::thread::sleep(Duration::from_millis(delay.parse().unwrap_or(0)));
        }
        let mut client = connect_client(&name);
        let mut reader = BufReader::new(client.try_clone().unwrap());
        // Answer the app's request, then ask it to approve something and read the answer.
        let Frame::Request { id, .. } = read_frame(&mut reader) else { panic!("expected a request") };
        write_frame(&mut client, &Frame::Response { id, result: Some(json!({"echo": id})), error: None });
        let approve = json!({"connector": "Notion", "action": "create pages", "preview": []});
        write_frame(&mut client, &Frame::Request { id: 4242, method: "approve".into(), params: approve });
        let Frame::Response { id, .. } = read_frame(&mut reader) else { panic!("expected a response") };
        assert_eq!(id, 4242);
    }

    /// The adversarial identity test: this same-user process enumerates `\\.\pipe\`, finds the
    /// endpoint's name, connects, and tries to drive the channel. The endpoint refuses it (its PID
    /// is not the child's) and disconnects it, while the real child is accepted and drives the
    /// channel. The name is not a secret; the retained handle's PID is the credential (L50).
    #[test]
    fn a_same_user_process_that_finds_the_pipe_cannot_drive_the_channel() {
        let server = windows::ServerEndpoint::create().unwrap();
        let name = server.name().to_string();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "app_channel::windows_tests::windows_channel_peer_fixture"])
            .env("GENTLE_DOT_TEST_CHANNEL_ROLE", "daemon")
            .env("GENTLE_DOT_TEST_CHANNEL_PIPE", &name)
            .env("GENTLE_DOT_TEST_CHANNEL_DELAY_MS", "600")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        // The child delays 600 ms, so the adversary's connection is the first the accept sees.
        let accepting = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            server.accept(pid, move || crate::daemon::process_started(pid).is_some(), deadline)
        });
        let wanted = name.clone();
        let adversary = std::thread::spawn(move || {
            let found = std::fs::read_dir(r"\\.\pipe\")
                .unwrap()
                .any(|entry| {
                    entry.map(|entry| format!(r"\\.\pipe\{}", entry.file_name().to_string_lossy()) == wanted).unwrap_or(false)
                });
            assert!(found, r"the pipe name is not discoverable in \\.\pipe\");
            let mut client = std::fs::OpenOptions::new().read(true).write(true).open(&wanted).unwrap();
            let frame = Frame::Request { id: 1, method: "command".into(), params: json!({}) };
            let _ = writeln!(client, "{}", serde_json::to_string(&frame).unwrap());
            let mut buffer = [0u8; 64];
            client.read(&mut buffer)
        });

        let connected = accepting.join().unwrap().unwrap();
        let handler = Arc::new(Recording::default());
        let channel = AppChannel::start(connected, handler.clone()).unwrap();
        // The real child is accepted and still drives the channel.
        let answer = channel.request("ping", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(answer, json!({"echo": 1}));
        assert!(child.wait().unwrap().success(), "the accepted peer failed");
        assert_eq!(handler.asked.lock().unwrap().len(), 1, "the refused peer reached the handler");
        // The refused connection got EOF or an error, never a frame.
        let read = adversary.join().unwrap();
        assert!(read.is_err() || read.unwrap() == 0, "the refused peer read something");
    }

    /// The endpoint is **single-instance**, and that is what stops a same-user process from creating
    /// a *second* instance of the name it found in `\\.\pipe\` and receiving the daemon's
    /// connection instead of the app. `FILE_FLAG_FIRST_PIPE_INSTANCE` alone would only fail *our*
    /// own create when the name already exists; the OS refuses the second instance because the
    /// first asked for one (`nMaxInstances = 1`). Measured on Windows 11: with 1 the second
    /// `CreateNamedPipeW` fails with `ERROR_PIPE_BUSY`, and the same call with 2 succeeds, so this
    /// test fails if the app's single-instance choice is ever relaxed.
    #[test]
    fn a_second_instance_of_the_endpoints_name_cannot_be_created() {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
        };
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
        };
        let server = windows::ServerEndpoint::create().unwrap();
        let name: Vec<u16> = server.name().encode_utf16().chain(Some(0)).collect();
        let second = |flags: u32| unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        // What an attacker would try: the same name, no FIRST_PIPE_INSTANCE. One instance is the
        // endpoint's own limit, so the OS refuses this.
        assert_eq!(
            second(FILE_FLAG_OVERLAPPED),
            INVALID_HANDLE_VALUE,
            "a second instance of the app's pipe name was created"
        );
        // And a duplicate of the app's own create is refused by the flag.
        assert_eq!(
            second(FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED),
            INVALID_HANDLE_VALUE,
            "FILE_FLAG_FIRST_PIPE_INSTANCE did not refuse a duplicate of the name"
        );
    }

    /// The reported Windows defect: the direction's `OVERLAPPED` event is manual-reset and reused
    /// for every transfer without `ResetEvent`, so a read issued after an earlier completion could
    /// see the leftover signal, return `ERROR_IO_INCOMPLETE` immediately, and tear the direction
    /// down after its first frame. This pins the invariant that claim denies, with the second read
    /// *genuinely* pending (nothing is written for a while, so it cannot complete synchronously).
    #[test]
    fn a_second_pending_read_on_one_direction_still_waits_for_its_data() {
        let (connected, client) = same_process_connected();
        let channel = AppChannel::start(connected, Arc::new(Recording::default())).unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut writer = client;

        // Transfer 1: the daemon answers, completing one read and signalling the shared event.
        let waiting = std::thread::spawn({
            let channel = channel.clone();
            move || channel.request("ping", json!({}), Duration::from_secs(10))
        });
        let Frame::Request { id, .. } = read_frame(&mut reader) else { panic!("expected a request") };
        write_frame(&mut writer, &Frame::Response { id, result: Some(json!({"ok": true})), error: None });
        assert_eq!(waiting.join().unwrap(), Ok(json!({"ok": true})));

        // Transfer 2: the next read is submitted with nothing to read, so it is pending while the
        // event still carries the previous completion's signal.
        std::thread::sleep(Duration::from_millis(250));
        write_frame(
            &mut writer,
            &Frame::Request {
                id: 77,
                method: "approve".into(),
                params: json!({"connector": "x", "action": "y", "preview": []}),
            },
        );
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(read_frame(&mut reader));
        });
        let frame = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the direction never answered the second request after its first frame");
        let Frame::Response { id, result, .. } = frame else { panic!("expected a response") };
        assert_eq!(id, 77);
        assert_eq!(result, Some(json!({"approved": true})));
    }
}

