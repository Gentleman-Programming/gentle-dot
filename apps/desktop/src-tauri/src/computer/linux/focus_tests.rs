//! Focus-targeting contract checks (T4, S4/S5): the stock-Niri
//! `FocusedWindow` / `FocusWindow` wire shapes through the existing
//! `niri` client path, the truthful reply parser, and the roundtrip over a
//! fake socket pair. Deterministic, no live compositor, no input.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use super::focus::{
    action_focus_window, parse_focused_window, FocusedWindow, FOCUSED_WINDOW_REQUEST,
};

/// Answer one request line on `peer` with `reply_line`, then close.
fn respond_once(peer: UnixStream, reply_line: &str) -> std::thread::JoinHandle<Vec<u8>> {
    let reply = reply_line.to_owned();
    std::thread::spawn(move || {
        let mut peer = peer;
        peer.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match peer.read(&mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    request.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        peer.write_all(reply.as_bytes()).expect("test peer writes the reply");
        request
    })
}

#[test]
fn focused_window_request_names_the_niri_wire() {
    // `Request::FocusedWindow` serializes to this JSON string (niri-ipc):
    // the existing Client path, not a new IPC dialect.
    assert_eq!(FOCUSED_WINDOW_REQUEST, "\"FocusedWindow\"");
}

#[test]
fn action_focus_window_emits_the_exact_wire_json() {
    // `Action::FocusWindow { id }` (niri-ipc): numeric id only, never a
    // focused-window fallback.
    assert_eq!(action_focus_window(42), r#"{"Action":{"FocusWindow":{"id":42}}}"#);
}

#[test]
fn focused_window_replies_parse_truthfully() {
    let reply = serde_json::json!({
        "FocusedWindow": {
            "id": 17,
            "title": "Text Editor",
            "app_id": "org.gnome.TextEditor",
            "pid": 991,
            "workspace_id": 1,
            "is_focused": true,
            "is_floating": false,
        }
    });
    assert_eq!(
        parse_focused_window(&reply).unwrap(),
        Some(FocusedWindow {
            id: 17,
            pid: Some(991),
            title: Some("Text Editor".into()),
            app_id: Some("org.gnome.TextEditor".into()),
        })
    );

    // Niri reports no focused window (for example a layer-shell surface).
    assert_eq!(parse_focused_window(&serde_json::json!({"FocusedWindow": null})).unwrap(), None);

    // A window whose owner Niri does not report stays usable as an id but
    // with no pid; the caller must fail closed for keyboard input.
    let no_pid = parse_focused_window(&serde_json::json!({"FocusedWindow": {"id": 3}})).unwrap();
    assert_eq!(no_pid, Some(FocusedWindow { id: 3, pid: None, title: None, app_id: None }));
}

#[test]
fn focused_window_replies_without_an_id_are_refused() {
    // Missing field, missing id, wrong types, and out-of-range pids all
    // fail; none of them fabricates a window.
    for reply in [
        serde_json::json!({"Windows": []}),
        serde_json::json!({}),
        serde_json::json!({"FocusedWindow": {}}),
        serde_json::json!({"FocusedWindow": {"title": "no id"}}),
        serde_json::json!({"FocusedWindow": {"id": "17"}}),
        serde_json::json!({"FocusedWindow": {"id": -1}}),
        serde_json::json!({"FocusedWindow": {"id": 17, "pid": "991"}}),
        serde_json::json!({"FocusedWindow": {"id": 17, "pid": 8_000_000_000i64}}),
        // A non-positive pid is not a real owner process: refused at parse.
        serde_json::json!({"FocusedWindow": {"id": 17, "pid": 0}}),
        serde_json::json!({"FocusedWindow": {"id": 17, "pid": -1}}),
        serde_json::json!({"FocusedWindow": {"id": 17, "pid": i32::MIN}}),
        serde_json::json!({"FocusedWindow": 42}),
        serde_json::json!({"FocusedWindow": "17"}),
    ] {
        assert!(parse_focused_window(&reply).is_err(), "reply {reply} must be refused, never guessed");
    }
}

#[test]
fn focused_window_query_roundtrips_through_the_existing_client_path() {
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(
        peer_end,
        r#"{"Ok":{"FocusedWindow":{"id":17,"pid":991,"title":"Text Editor","app_id":"org.gnome.TextEditor"}}}
"#,
    );
    let reply = crate::niri::request_on(client_end, FOCUSED_WINDOW_REQUEST, Duration::from_secs(5))
        .expect("fake focused-window roundtrip succeeds");
    let request = responder.join().expect("responder ends");
    assert_eq!(request, b"\"FocusedWindow\"\n");
    assert_eq!(parse_focused_window(&reply).unwrap().unwrap().id, 17);
}

#[test]
fn focus_action_roundtrips_and_requires_handled() {
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(peer_end, "{\"Ok\":\"Handled\"}\n");
    let reply = crate::niri::request_on(client_end, &action_focus_window(17), Duration::from_secs(5))
        .expect("fake focus roundtrip succeeds");
    let request = responder.join().expect("responder ends");
    assert_eq!(request, b"{\"Action\":{\"FocusWindow\":{\"id\":17}}}\n");
    assert!(crate::niri::is_handled(&reply));

    // A non-Handled reply is not success.
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(peer_end, "{\"Ok\":\"Unhandled\"}\n");
    let reply = crate::niri::request_on(client_end, &action_focus_window(17), Duration::from_secs(5))
        .expect("roundtrip succeeds");
    responder.join().expect("responder ends");
    assert!(!crate::niri::is_handled(&reply));

    // A wire error surfaces instead of being read as success.
    let (client_end, peer_end) = UnixStream::pair().expect("test socketpair");
    let responder = respond_once(peer_end, "{\"Err\":\"no such window\"}\n");
    let err = crate::niri::request_on(client_end, &action_focus_window(17), Duration::from_secs(5))
        .unwrap_err();
    responder.join().expect("responder ends");
    assert!(err.to_string().contains("no such window"), "wire errors surface: {err}");
}
