//! The private channel to the daemon this app launched (S25.1–S25.3). When the app spawns the
//! daemon it creates a connected pair of Unix sockets and hands one end to the daemon as fd 3
//! (`daemon::spawn_daemon`); it keeps the other. That connection is the authentication: nothing is
//! written to a file or an environment variable and nothing listens, so another process (the agent
//! included) cannot reach it. A daemon the app only attached to gets no channel.
//!
//! Frames are line-delimited JSON in both directions; each side numbers its own requests:
//!   {"kind":"request","id":1,"method":"command","params":{"clientId":"…","message":{…}}}
//!   {"kind":"response","id":1,"result":{}}  or  {"kind":"response","id":1,"error":"…"}
//! The app sends `command` (a privileged message from the panel, on behalf of its window),
//! `computer_register`, and `computer_unregister`. The daemon sends `approve` with an
//! [`ApprovalRequest`]; the app shows the native dialog on a worker thread (never the main thread)
//! and answers `{"approved": bool}`. A failed dialog, malformed request, or closed channel refuses.

use crate::approvals::ApprovalRequest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::Duration;

/// Where the daemon finds its end of the channel.
pub const APP_FD: i32 = 3;
/// A command may wait for a native confirmation (120 s) before the daemon answers.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(150);
/// Registering the computer helper waits for the daemon to start reading the channel.
pub const REGISTER_TIMEOUT: Duration = Duration::from_secs(60);
/// A frame longer than this closes the channel.
const MAX_FRAME: u64 = 1024 * 1024;

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
}

type Reply = mpsc::Sender<Result<Value, String>>;

pub struct AppChannel {
    writer: Mutex<UnixStream>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    open: AtomicBool,
}

impl AppChannel {
    /// Reads `stream` on a thread of its own; each daemon request runs on a worker thread.
    pub fn start(stream: UnixStream, handler: Arc<dyn Handler>) -> io::Result<Arc<Self>> {
        let reader = stream.try_clone()?;
        let channel = Arc::new(AppChannel {
            writer: Mutex::new(stream),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            open: AtomicBool::new(true),
        });
        let reading = channel.clone();
        std::thread::Builder::new()
            .name("app-channel".into())
            .spawn(move || reading.read(BufReader::new(reader), handler))?;
        Ok(channel)
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
        let _ = self.writer.lock().unwrap_or_else(PoisonError::into_inner).shutdown(Shutdown::Both);
        // Dropping the senders wakes every waiting request.
        self.pending().clear();
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Reply>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self, frame: &Frame) -> io::Result<()> {
        let mut line = serde_json::to_vec(frame).map_err(io::Error::other)?;
        line.push(b'\n');
        self.writer.lock().unwrap_or_else(PoisonError::into_inner).write_all(&line)
    }

    fn read(self: Arc<Self>, mut reader: BufReader<UnixStream>, handler: Arc<dyn Handler>) {
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
            other => Frame::Response { id, result: None, error: Some(format!("Unknown request: {other}")) },
        };
        let _ = self.write(&frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::fake::{Answer, FakePrompt};
    use crate::approvals::{Approvals, Decision};
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
    fn closing_the_channel_ends_the_daemons_side() {
        let (channel, mut daemon) = pair(Arc::new(Recorder::default()));
        channel.close();
        let mut line = String::new();
        assert_eq!(daemon.reader.read_line(&mut line).unwrap(), 0);
        assert!(!channel.is_open());
    }
}
