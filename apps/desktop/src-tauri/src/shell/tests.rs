use super::*;
use crate::niri::gate::*;

#[test]
fn tray_hides_new_conversation_in_the_single_chat() {
    assert_eq!(
        tray_menu_ids(false, false),
        vec!["open", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
    );
}

#[test]
fn tray_shows_new_conversation_with_the_conversations_list() {
    assert_eq!(
        tray_menu_ids(true, false),
        vec!["open", "new", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
    );
}

#[test]
fn tray_offers_stop_computer_control_where_it_exists() {
    assert_eq!(
        tray_menu_ids(false, true),
        vec!["open", "browser", "rose", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
    );
}

/// T2/S2: the tray menu follows the helper that actually started (the managed `Computer`
/// endpoint), never a re-derived startup predicate. A Linux host whose Niri is configured
/// but whose helper failed must not advertise control.
#[test]
fn tray_follows_the_started_helper_and_the_platform_menu() {
    // Linux helper actually registered: both items appear.
    assert!(tray_offers_computer_control("linux", true));
    assert_eq!(
        tray_menu_ids(false, tray_offers_computer_control("linux", true)),
        vec!["open", "browser", "rose", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
    );
    // Niri configured but the helper never started (no endpoint): no item is offered.
    assert!(!tray_offers_computer_control("linux", false));
    assert_eq!(
        tray_menu_ids(false, tray_offers_computer_control("linux", false)),
        vec!["open", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
    );
    // macOS keeps its previous menu even when the helper failed.
    assert!(tray_offers_computer_control("macos", false));
    assert_eq!(
        tray_menu_ids(false, tray_offers_computer_control("macos", false)),
        vec!["open", "browser", "rose", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
    );
    // No other platform has a helper: never offer control.
    assert!(!tray_offers_computer_control("other", false));
    assert!(!tray_offers_computer_control("other", true));
    assert_eq!(
        tray_menu_ids(false, tray_offers_computer_control("other", false)),
        vec!["open", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
    );
}

#[test]
fn the_shortcut_and_connector_commands_are_registered_and_granted_to_the_panel_only() {
    let build = include_str!("../../build.rs");
    let capabilities: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
    for command in ["shortcut_get", "shortcut_set", "connector_command"] {
        assert!(build.contains(&format!("\"{command}\",")), "{command} is missing from build.rs");
        let permission = format!("allow-{}", command.replace('_', "-"));
        let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == permission.as_str()))
            .flat_map(|c| c["windows"].as_array().unwrap())
            .collect();
        assert_eq!(windows, ["panel"], "{permission}");
    }
}

#[test]
fn conversations_flag_reads_like_the_daemon() {
    assert!(conversations_on(Some("1")));
    assert!(!conversations_on(None));
    assert!(!conversations_on(Some("0")));
    assert!(!conversations_on(Some("true")));
}

#[test]
fn niri_trace_is_opt_in_and_allowlisted() {
    // Default off: only the exact opt-in enables any trace line.
    assert!(niri_trace_enabled(Some("1")));
    assert!(!niri_trace_enabled(None));
    assert!(!niri_trace_enabled(Some("0")));
    assert!(!niri_trace_enabled(Some("true")));
    // The panel summary carries only allowlisted numerics/flags: no
    // titles, socket paths, window JSON, accounts, or content.
    let line = format_trace_panel(11, true, Some((90.0, 205.0)), (420, 640), Some("DP-1"), Some((10, -5)), Some(true));
    assert!(line.contains("id=11"));
    assert!(line.contains("floating=true"));
    assert!(line.contains("delta=10,-5"));
    assert!(line.contains("handled=true"));
    for banned in ["title", "socket", "NIRI_SOCKET", "token", "account", "prompt"] {
        assert!(!line.contains(banned), "trace leaks {banned}");
    }
}

#[test]
fn only_the_glow_overlay_may_acknowledge_the_working_rings() {
    let build = include_str!("../../build.rs");
    assert!(build.contains("\"computer_working_ready\","), "computer_working_ready is missing from build.rs");
    let capabilities: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
    let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == "allow-computer-working-ready"))
        .flat_map(|c| c["windows"].as_array().unwrap())
        .collect();
    assert_eq!(windows, [computer::GLOW_WINDOW]);
}

#[test]
fn the_windows_listen_for_the_assistant_ready_event() {
    let desktop = include_str!("../../../../../packages/ui/src/desktop.ts");
    let app = include_str!("../../../../../packages/ui/src/App.tsx");
    let quoted = format!("\"{ASSISTANT_READY}\"");
    assert!(desktop.contains(&quoted), "desktop.ts does not accept {quoted}");
    assert!(app.contains(&format!("onDesktopEvent({quoted}")), "App.tsx does not listen for {quoted}");
}

#[test]
fn native_follow_matches_the_mac_drag_settle_quiet() {
    // Native follow reanchors only after the same 300 ms drag-settle
    // quiet the mac snapper waits before re-snapping the Dot: the
    // debounce is defined once in niri.rs and must stay that interval.
    assert_eq!(crate::niri::FOLLOW_DEBOUNCE, DRAG_SETTLE);
    assert_eq!(crate::niri::FOLLOW_DEBOUNCE, Duration::from_millis(300));
}

#[test]
fn panel_capture_needs_mapped_size_and_shown_state_not_origin() {
    // A genuine (0, 0) origin is valid; a never-mapped 0x0 frame is not.
    assert!(panel_capture_valid(true, false, 420, 640, true));
    assert!(panel_capture_valid(true, false, 420, 640, true));
    assert!(!panel_capture_valid(true, false, 0, 0, true));
    assert!(!panel_capture_valid(true, false, 420, 0, true));
    assert!(!panel_capture_valid(true, false, 0, 640, true));
    // Startup bogus rect: never shown, never accepted even with size.
    assert!(!panel_capture_valid(true, false, 420, 640, false));
    // Fullscreen and native Wayland coordinates are not authoritative.
    assert!(!panel_capture_valid(true, true, 420, 640, true));
    assert!(!panel_capture_valid(false, false, 420, 640, true));
}

#[cfg(target_os = "linux")]
#[test]
fn native_capture_runs_only_while_compact_and_visible() {
    assert!(native_capture_gate(false, true));
    // Expanded departures never capture (no expanded geometry overwrite);
    // hidden windows have no authoritative spot either.
    assert!(!native_capture_gate(true, true));
    assert!(!native_capture_gate(false, false));
    assert!(!native_capture_gate(true, false));
}

#[cfg(target_os = "linux")]
#[test]
fn native_compact_spot_survives_expanded_hides_and_failures() {
    use crate::niri::CompactSpot;
    let spot = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let newer = CompactSpot { output: "DP-1".to_owned(), x: 110.0, y: 210.0 };
    // Fresh captures win; None/Err (failures, nulls, expanded hides) keep memory.
    assert_eq!(merge_compact_spot(None, Some(spot.clone())), Some(spot.clone()));
    assert_eq!(merge_compact_spot(Some(spot.clone()), None), Some(spot.clone()));
    assert_eq!(merge_compact_spot(Some(spot.clone()), Some(newer.clone())), Some(newer));
    assert_eq!(merge_compact_spot(None, None), None);
    // Compact -> expanded -> compact: the expanded hide passes nothing, so
    // the compact spot captured before expanding is still the one restored.
    let mut remembered = merge_compact_spot(None, Some(spot.clone()));
    assert!(!native_capture_gate(true, true));
    remembered = merge_compact_spot(remembered, None);
    assert_eq!(remembered, Some(spot));
}

#[cfg(target_os = "linux")]
#[test]
fn restore_epochs_die_on_hide_or_mode_change() {
    // Show queues generation 1; a hide/mode bump to 2 stales it before any action.
    assert!(restore_job_fresh(1, 1));
    assert!(!restore_job_fresh(1, 2));
    assert!(!restore_job_fresh(2, 1));
    // A second show re-queues fresh work under the newest generation.
    assert!(restore_job_fresh(3, 3));
    assert!(!restore_job_fresh(2, 3));
}

#[cfg(target_os = "linux")]
#[test]
fn restore_handoff_coalesces_to_the_latest_wake() {
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    // Three rapid shows while the worker is busy: capacity-1 holds one
    // unit, but the waiter must see the latest generation, not miss one.
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (1, RestoreQueue::Sent));
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (2, RestoreQueue::Coalesced));
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (3, RestoreQueue::Coalesced));
    assert_eq!(restore_take(&rx, &epoch), Some(3));
    // A lone wake passes its own generation through.
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (4, RestoreQueue::Sent));
    assert_eq!(restore_take(&rx, &epoch), Some(4));
    // Disconnect (shutdown) ends the wait: the worker exits, never spins.
    drop(tx);
    assert_eq!(restore_take(&rx, &epoch), None);
    // Job budget fits several bounded passes plus worker-only readiness polls.
    assert!(NATIVE_RESTORE_JOB >= NATIVE_RESTORE_PASS);
    assert!(NATIVE_RESTORE_POLL < NATIVE_RESTORE_PASS);
}

#[cfg(target_os = "linux")]
#[test]
fn native_restore_starts_only_where_state_is_registered() {
    use std::sync::atomic::AtomicU64;
    // The worker exists exactly for unplaced Niri: the setup decision is
    // pure, so this table covers it without a runtime.
    assert!(native_restore_planned(false, true));
    assert!(!native_restore_planned(true, true));
    assert!(!native_restore_planned(false, false));
    assert!(!native_restore_planned(true, false));
    // The pre-manage phase is state-free: a capacity-1 channel built
    // before any registration round-trips a handoff through the worker
    // wait, and disconnect ends it — so spawning the thread after
    // `manage` can neither panic nor lose the first wake.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (1, RestoreQueue::Sent));
    assert_eq!(restore_take(&rx, &epoch), Some(1));
    drop(tx);
    assert_eq!(restore_take(&rx, &epoch), None);
}

#[cfg(target_os = "linux")]
#[test]
fn compact_restore_plans_deltas_only_for_settled_floating_panels() {
    use crate::niri::{CompactSpot, PanelWindow};
    let saved = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let floating = |pos: Option<(f64, f64)>| PanelWindow {
        id: 11, floating: true, size: (420, 640), pos, workspace: Some(7),
    };
    // Same output: exact numeric id plus AdjustFixed delta, never SetFixed.
    assert_eq!(
        plan_compact_restore(Some(&saved), &floating(Some((90.0, 205.0))), Some("DP-1")),
        Some((11, 10, -5))
    );
    // Already home: the caller skips the move request, still a plan.
    assert_eq!(
        plan_compact_restore(Some(&saved), &floating(Some((100.0, 200.0))), Some("DP-1")),
        Some((11, 0, 0))
    );
    // No saved spot: the initial anchor is preserved, never forced.
    assert_eq!(plan_compact_restore(None, &floating(Some((90.0, 205.0))), Some("DP-1")), None);
    // Tiling, transient nulls, other outputs, and missing workspaces: fail
    // closed (nulls retry at the worker; outputs never fight the drag).
    let tiled = PanelWindow { floating: false, ..floating(Some((90.0, 205.0))) };
    assert_eq!(plan_compact_restore(Some(&saved), &tiled, Some("DP-1")), None);
    assert_eq!(plan_compact_restore(Some(&saved), &floating(None), Some("DP-1")), None);
    assert_eq!(plan_compact_restore(Some(&saved), &floating(Some((90.0, 205.0))), Some("HDMI-1")), None);
    assert_eq!(plan_compact_restore(Some(&saved), &floating(Some((90.0, 205.0))), None), None);
}

#[cfg(target_os = "linux")]
#[test]
fn native_hide_snapshots_visibility_before_the_mode_lock() {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    // The production critical section, modeled faithfully: the fake main
    // thread answers visibility requests only while holding the MODE lock
    // (like tray/zbus handlers that must take it), and the getter blocks
    // until main answers (like Tauri's blocking rx.recv). Every handshake
    // is bounded; no thread outlives the test.
    let mode = Arc::new(Mutex::new(()));
    let (req_tx, req_rx) = mpsc::sync_channel::<mpsc::Sender<bool>>(1);
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let main_mode = mode.clone();
    let main = thread::spawn(move || {
        for reply in req_rx {
            let _held = main_mode.lock().expect("main takes MODE to answer");
            entered_tx.send(()).expect("main holds MODE");
            reply.send(true).expect("answer while holding MODE");
            release_rx.recv_timeout(Duration::from_secs(5)).expect("release");
        }
    });
    // The old order (lock, then getter): main can never answer while the
    // lock is held, so the answer must not arrive — bounded proof of the
    // circular wait, without any unbounded join.
    let (probe_tx, probe_rx) = mpsc::channel::<bool>();
    let held = mode.lock().unwrap();
    req_tx.send(probe_tx).expect("request out");
    assert!(entered_rx.recv_timeout(Duration::from_millis(500)).is_err());
    drop(held);
    entered_rx.recv_timeout(Duration::from_secs(5)).expect("main proceeds after release");
    release_tx.send(()).expect("release");
    assert!(probe_rx.recv_timeout(Duration::from_secs(5)).unwrap());
    // The production order through the real helper: snapshot first with no
    // lock held, so main answers while holding MODE, then take the lock.
    let seen = snapshot_visible(|| {
        let (tx, rx) = mpsc::channel::<bool>();
        req_tx.send(tx).expect("request out");
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "getter timed out".to_owned())
    });
    assert!(seen);
    entered_rx.recv_timeout(Duration::from_secs(5)).expect("main held MODE while answering");
    release_tx.send(()).expect("release");
    let _guard = mode.lock().unwrap();
    drop(req_tx);
    main.join().expect("main exits on disconnect");
}

#[cfg(target_os = "linux")]
#[test]
fn mode_capture_skips_hidden_panels_despite_live_ipc() {
    use crate::niri::CompactSpot;
    let old = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let live = CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 };
    // A hidden native panel must not overwrite compact memory even when the
    // compositor would answer: no IPC runs, the old spot survives.
    let mut calls = 0;
    let fresh = decide_native_capture(false, 7, 7, || {
        calls += 1;
        Some(live.clone())
    });
    assert_eq!(calls, 0);
    assert_eq!(merge_compact_spot(Some(old.clone()), fresh), Some(old.clone()));
    // A getter error snapshots to hidden through the real helper, so the
    // same preservation holds end to end.
    let seen = snapshot_visible(|| Err::<bool, String>("gone".to_owned()));
    assert!(!seen);
    let fresh = decide_native_capture(seen, 7, 7, || {
        calls += 1;
        Some(live.clone())
    });
    assert_eq!(calls, 0);
    assert_eq!(merge_compact_spot(Some(old.clone()), fresh), Some(old));
}

#[cfg(target_os = "linux")]
#[test]
fn visible_capture_runs_ipc_regardless_of_recorded_mode() {
    // Unit 20f3: the recorded flag is not proof — visible snapshots query
    // either way; hidden never does. (The old expanded-never arm moved to
    // capture_compact_spot, which proves floating itself.)
    use crate::niri::CompactSpot;
    let live = CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 };
    let mut calls = 0;
    let fresh = decide_native_capture(true, 7, 7, || {
        calls += 1;
        Some(live.clone())
    });
    assert_eq!(calls, 1);
    assert_eq!(merge_compact_spot(None, fresh), Some(live.clone()));
    // Hidden still runs zero IPC and preserves, recorded flag or not.
    let mut hidden_calls = 0;
    let none = decide_native_capture(false, 7, 7, || {
        hidden_calls += 1;
        Some(live.clone())
    });
    assert_eq!(hidden_calls, 0);
    assert!(none.is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn recorded_expanded_must_not_skip_actual_floating_capture() {
    // Unit 20f3 (was RED on the old recorded gate: decide returned None):
    // the ACTUAL production seam with recorded-expanded state but live
    // floating IPC captures the real anchor — and proves the real wire
    // sequence (Windows + Workspaces), not a pure bool. Tiled, hidden,
    // and stale variants preserve the anchor with zero inference.
    use crate::niri::CompactSpot;
    let old = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let live_pos = (10.0, 20.0);
    let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]});
    let mut script = |panel: serde_json::Value, counter: std::rc::Rc<std::cell::Cell<usize>>| {
        let windows = serde_json::json!({"Windows": panel["Windows"]});
        let workspaces = workspaces.clone();
        move |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
            counter.set(counter.get() + 1);
            if wire.contains("Windows") {
                Ok(windows.clone())
            } else {
                Ok(workspaces.clone())
            }
        }
    };
    // Recorded expanded, actually floating: captures before any later tile.
    let shell = test_hide_shell(6, Some(old.clone()));
    *shell.native_expanded.lock().unwrap() = true;
    let counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let mut request =
        script(worker_windows(Some(live_pos), Some((0.0, 0.0))), std::rc::Rc::clone(&counter));
    capture_mode_anchor(&shell, 6, std::process::id(), true, 6, 6, &mut request);
    assert!(counter.get() >= 2, "real wire sequence: Windows + Workspaces");
    assert_eq!(
        *shell.native_compact.lock().unwrap(),
        Some(CompactSpot { output: "DP-1".to_owned(), x: live_pos.0, y: live_pos.1 }),
    );
    // Actually tiled: no overwrite, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    *shell.native_expanded.lock().unwrap() = true;
    let mut tiled = worker_windows(Some(live_pos), Some((0.0, 0.0)));
    tiled["Windows"][0]["is_floating"] = serde_json::json!(false);
    let counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let mut request = script(tiled, std::rc::Rc::clone(&counter));
    capture_mode_anchor(&shell, 6, std::process::id(), true, 6, 6, &mut request);
    assert!(counter.get() >= 1, "tiled proof comes from the wire, not the flag");
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Hidden: zero wire, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("hidden capture must not touch the wire");
    };
    capture_mode_anchor(&shell, 6, std::process::id(), false, 6, 6, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Stale (epoch advanced past the job): zero wire, commit refuses.
    let shell = test_hide_shell(7, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("stale capture must not touch the wire");
    };
    capture_mode_anchor(&shell, 6, std::process::id(), true, 6, 6, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old));
}

#[cfg(target_os = "linux")]
#[test]
fn shared_boundary_capture_refreshes_the_anchor_from_wire_sizes() {
    // S24/S26 (T10/todo11): the ACTUAL shared-boundary seam must refresh
    // the remembered panel anchor from live wire geometry — the probe
    // moved the pair to (600, 244) but return restored the stale
    // (2048, 56) because the shared route never captured. Pair 500x640
    // and panel-only 420x640 commit the client top-left; rose-only 72x72
    // translates the rose origin to the panel anchor (-428, -284);
    // tiled, hidden, covered, unknown-size, null-position, and stale
    // snapshots preserve the anchor with zero inference.
    use crate::niri::CompactSpot;
    use crate::niri::unit_restore::{PAIR_WINDOW, PANEL_WINDOW, ROSE_OFFSET, ROSE_WINDOW};
    let old = CompactSpot { output: "DP-1".to_owned(), x: 2048.0, y: 56.0 };
    let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]});
    fn frame(size: (i32, i32), pos: Option<(f64, f64)>, floating: bool) -> serde_json::Value {
        let layout = match pos {
            Some((x, y)) => serde_json::json!({"tile_pos_in_workspace_view": [x, y], "window_size": [size.0, size.1]}),
            None => serde_json::json!({"window_size": [size.0, size.1]}),
        };
        serde_json::json!({"Windows": [
            {"id": 43, "pid": std::process::id(), "title": crate::platform::PANEL_TITLE,
             "workspace_id": 7, "is_floating": floating, "layout": layout},
        ]})
    }
    // Moved pair: the probe regression. Live (600, 244) replaces stale (2048, 56).
    let shell = test_hide_shell(6, Some(old.clone()));
    let counter = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let windows = frame(PAIR_WINDOW, Some((600.0, 244.0)), true);
    let pair_workspaces = workspaces.clone();
    let inner = std::rc::Rc::clone(&counter);
    let mut request = move |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        inner.set(inner.get() + 1);
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(pair_workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert!(counter.get() >= 2, "real wire sequence: Windows + Workspaces");
    assert_eq!(
        *shell.native_compact.lock().unwrap(),
        Some(CompactSpot { output: "DP-1".to_owned(), x: 600.0, y: 244.0 }),
    );
    // Panel-only commits its own top-left.
    let shell = test_hide_shell(6, Some(old.clone()));
    let windows = frame(PANEL_WINDOW, Some((10.0, 20.0)), true);
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert_eq!(
        *shell.native_compact.lock().unwrap(),
        Some(CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 }),
    );
    // Rose-only translates the rose origin back to the panel anchor.
    let shell = test_hide_shell(6, Some(old.clone()));
    let rose = (10.0 + f64::from(ROSE_OFFSET.0), 20.0 + f64::from(ROSE_OFFSET.1));
    let windows = frame(ROSE_WINDOW, Some(rose), true);
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert_eq!(
        *shell.native_compact.lock().unwrap(),
        Some(CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 }),
    );
    // Tiled pair: proof comes from the wire, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    let windows = frame(PAIR_WINDOW, Some((600.0, 244.0)), false);
    let calls = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let inner = std::rc::Rc::clone(&calls);
    let tiled_workspaces = workspaces.clone();
    let mut request = move |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        inner.set(inner.get() + 1);
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(tiled_workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert!(calls.get() >= 1, "tiled proof comes from the wire, not the flag");
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Unknown transient size: exactly one wire query, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    let windows = frame((200, 200), Some((600.0, 244.0)), true);
    let calls = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let inner = std::rc::Rc::clone(&calls);
    let transient_workspaces = workspaces.clone();
    let mut request = move |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        inner.set(inner.get() + 1);
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(transient_workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert_eq!(calls.get(), 1, "unrecognized sizes run no output query");
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Null position: transient drag state, never an anchor.
    let shell = test_hide_shell(6, Some(old.clone()));
    let windows = frame(PAIR_WINDOW, None, true);
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 6, 6, &mut request);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Covered (opacity-0) window: toolkit-visible yet mid-sequence, zero wire.
    let shell = test_hide_shell(6, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("covered capture must not touch the wire");
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, false, 6, 6, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Hidden: zero wire, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("hidden capture must not touch the wire");
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), false, true, 6, 6, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Stale job (epoch advanced past it): zero wire, commit refuses.
    let shell = test_hide_shell(7, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("stale capture must not touch the wire");
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 7, 7, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old.clone()));
    // Snapshot raced across the epoch: zero wire, anchor preserved.
    let shell = test_hide_shell(6, Some(old.clone()));
    let mut calls = 0;
    let mut request = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        calls += 1;
        unreachable!("racing capture must not touch the wire");
    };
    capture_shared_transition_anchor(&shell, 6, std::process::id(), true, true, 5, 6, &mut request);
    assert_eq!(calls, 0);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(old));
}

#[cfg(target_os = "linux")]
#[test]
fn clipped_poll_never_exceeds_remaining() {
    assert_eq!(clipped_poll(Duration::from_millis(10)), Duration::from_millis(10));
    assert_eq!(clipped_poll(Duration::from_secs(10)), NATIVE_RESTORE_POLL);
    assert_eq!(clipped_poll(Duration::ZERO), Duration::ZERO);
}

#[cfg(target_os = "linux")]
#[test]
fn stale_wake_drain_is_bounded_and_latest_wins() {
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(0);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    // Flood while draining: a hot producer must not spin the waiter past
    // the cap, whatever the heat. Deterministic: the bound is structural.
    let flooder = thread::spawn(move || {
        for _ in 0..300 {
            epoch.fetch_add(1, Ordering::SeqCst);
            let _ = tx.try_send(());
        }
    });
    let mut drained = 0;
    while drained <= RESTORE_DRAIN_CAP {
        drained = drain_stale_wakes(&rx, RESTORE_DRAIN_CAP);
        if flooder.is_finished() {
            break;
        }
    }
    assert!(drained <= RESTORE_DRAIN_CAP);
    flooder.join().expect("flooder finishes");
    // ...then the newest generation still wins on a quiet channel.
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (1, RestoreQueue::Sent));
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (2, RestoreQueue::Coalesced));
    assert_eq!(restore_take(&rx, &epoch), Some(2));
}

#[cfg(target_os = "linux")]
#[test]
fn strict_capture_needs_positive_visibility_and_a_stable_generation() {
    use crate::niri::CompactSpot;
    let old = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let live = CompactSpot { output: "DP-1".to_owned(), x: 10.0, y: 20.0 };
    let origin = CompactSpot { output: "DP-1".to_owned(), x: 0.0, y: 0.0 };
    // (visible, snapshot epoch, current epoch, expected queries): unit 20f3
    // dropped the recorded-mode column — queries run for stable visible
    // snapshots either way; hidden or racing cells stay silent and keep
    // the remembered spot, even with live IPC answering behind the closure.
    let cases: Vec<(bool, u64, u64, usize)> = vec![
        (false, 5, 5, 0),
        (false, 5, 6, 0),
        (true, 5, 6, 0),
        (true, 5, 5, 1),
        (true, 6, 6, 1),
        (false, 6, 6, 0),
    ];
    for (visible, snap, current, queries) in cases {
        let mut calls = 0;
        let fresh = decide_native_capture(visible, snap, current, || {
            calls += 1;
            Some(live.clone())
        });
        assert_eq!(calls, queries, "visible={visible} snap={snap} current={current}");
        let merged = merge_compact_spot(Some(old.clone()), fresh);
        if queries == 0 {
            assert_eq!(merged, Some(old.clone()));
        } else {
            assert_eq!(merged, Some(live.clone()));
        }
    }
    // A genuine origin still captures; a None capture still preserves.
    let mut calls = 0;
    let fresh = decide_native_capture(true, 9, 9, || {
        calls += 1;
        Some(origin.clone())
    });
    assert_eq!(calls, 1);
    assert_eq!(merge_compact_spot(Some(old.clone()), fresh), Some(origin));
    let kept = decide_native_capture(true, 9, 9, || {
        calls += 1;
        None
    });
    assert_eq!(merge_compact_spot(Some(old.clone()), kept), Some(old));
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Clone)]
enum ModeStep {
    Resizable(bool),
    Request(String),
    Size,
    Handoff,
}

#[cfg(target_os = "linux")]
#[test]
fn gated_opacity_values() {
    // The gate is opacity, never a logical-visibility latch: hidden is
    // exactly 0, reveal restores exactly 1. Mode split and cover-first
    // order live in the shared-unit seam tests, not here.
    assert_eq!(GATED_OPACITY_HIDDEN, 0.0);
    assert_eq!(GATED_OPACITY_SHOWN, 1.0);
}

#[cfg(target_os = "linux")]
#[test]
fn gated_reveal_needs_the_current_epoch_and_the_held_gate() {
    // (job, current, gate, reveal): a hide/mode bump stales the job, a
    // newer show overwrites the gate, clearing cancels — all skip
    // reveal/refocus/emit and stay hidden. Only the held current job
    // reveals on worker-confirmed settle; worker failure (deadline,
    // unresolvable geometry, wire errors) cancels (hide + reset, no
    // focus/emit, Err for retry) instead of revealing, so a gated show
    // never appears at the unconfirmed anchor. No focus or panel-shown
    // emit happens while gated; both live only in the reveal closure.
    let cases: [(u64, u64, Option<u64>, bool); 6] = [
        (3, 3, Some(3), true),
        (3, 4, Some(3), false),
        (3, 3, Some(4), false),
        (3, 3, None, false),
        (2, 3, None, false),
        (4, 4, Some(4), true),
    ];
    for (job, current, gate, reveal) in cases {
        assert_eq!(
            gate_reveal_fresh(job, current, gate), reveal,
            "job={job} current={current} gate={gate:?}"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn gated_show_falls_back_only_without_a_consumer() {
    // Desired show-branch contract through the shared handoff seam: Sent
    // and Full-coalesced both reach the worker (coalescing converges on
    // the latest generation), so those await it; only Disconnected — no
    // consumer, no completion ever — must cancel-fallback immediately
    // (hide + opacity/interaction reset, no focus/emit, Err for retry)
    // instead of stranding opacity 0. A stale hide still never reveals
    // (previous table owns those cases).
    assert!(!gated_needs_reveal_fallback(RestoreQueue::Sent));
    assert!(!gated_needs_reveal_fallback(RestoreQueue::Coalesced));
    assert!(gated_needs_reveal_fallback(RestoreQueue::Disconnected));
    // The seam itself reports delivery at runtime: sent, then coalesced
    // while full, then disconnected once the worker is gone.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (1, RestoreQueue::Sent));
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (2, RestoreQueue::Coalesced));
    assert!(queue_reaches_worker(RestoreQueue::Sent));
    assert!(queue_reaches_worker(RestoreQueue::Coalesced));
    drop(rx);
    assert_eq!(restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents), (3, RestoreQueue::Disconnected));
    assert!(!queue_reaches_worker(RestoreQueue::Disconnected));
}

#[cfg(target_os = "linux")]
#[test]
fn collapse_cover_ack_is_event_driven_and_stale_safe() {
    // Unit 20a: the old collapse queued the cover and floated at once —
    // unordered main-thread vs socket delivery could show a misplaced
    // frame at opacity 1. The ack below gates the float, event-driven
    // with no lock held and no sleep fence; stale jobs never proceed.
    let epoch = AtomicU64::new(7);
    let (tx, rx) = mpsc::channel::<()>();
    tx.send(()).unwrap();
    assert_eq!(await_cover_ack(&rx, 7, &epoch, Duration::from_millis(50)), CoverAck::Acked);
    let (_hung, hung_rx) = mpsc::channel::<()>();
    assert_eq!(await_cover_ack(&hung_rx, 7, &epoch, Duration::from_millis(20)), CoverAck::Timeout);
    epoch.store(8, Ordering::SeqCst);
    let (tx3, rx3) = mpsc::channel::<()>();
    tx3.send(()).unwrap();
    assert_eq!(await_cover_ack(&rx3, 7, &epoch, Duration::from_millis(50)), CoverAck::Stale);
    let (_hung4, hung_rx4) = mpsc::channel::<()>();
    assert_eq!(await_cover_ack(&hung_rx4, 7, &epoch, Duration::from_millis(20)), CoverAck::Stale);
}

#[cfg(target_os = "linux")]
#[test]
fn ordered_collapse_applies_cover_before_float_ipc() {
    // The production sequence with fakes: a cover applied on another
    // thread acks, the waiter observes it with no lock held, and only
    // then does the float IPC run. Deterministic: the ack receive gates
    // the order, no sleeps, no main thread.
    use std::sync::Arc;
    use std::thread;
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let (ack_tx, ack_rx) = mpsc::channel::<()>();
    let applied = order.clone();
    thread::spawn(move || {
        applied.lock().unwrap().push("cover-applied");
        let _ = ack_tx.send(());
    });
    let epoch = AtomicU64::new(3);
    assert_eq!(await_cover_ack(&ack_rx, 3, &epoch, Duration::from_secs(2)), CoverAck::Acked);
    order.lock().unwrap().push("float-sent");
    assert_eq!(*order.lock().unwrap(), vec!["cover-applied", "float-sent"]);
}

#[cfg(target_os = "linux")]
#[test]
fn rapid_mode_show_hide_never_reveals_stale_or_steals_gates() {
    // Lifecycle sequence with production fns only: show(1) takes a gate,
    // a hide/mode generation clears it, show(2) publishes fresh. Job 1
    // must never reveal, refocus, or emit; only job 2 is eligible; a
    // superseded mode transition commits nothing (last committer wins,
    // converging with the worker's actual-vs-desired reconcile).
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(false);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (job1, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert_eq!(*gate.lock().unwrap(), Some(job1));
    let hide_job = mode_take_generation(&epoch, &gate);
    assert_eq!(*gate.lock().unwrap(), None);
    assert!(!restore_job_fresh(job1, epoch.load(Ordering::SeqCst)));
    let stale: CommandResult<bool> = Ok(false);
    assert_eq!(plan_restore_completion(&stale, false), RestoreCompletion::Silent);
    assert!(!settled_reveal_eligible(true, job1, epoch.load(Ordering::SeqCst), *gate.lock().unwrap()));
    let (job2, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert!(settled_reveal_eligible(true, job2, epoch.load(Ordering::SeqCst), *gate.lock().unwrap()));
    assert!(!settled_reveal_eligible(true, job1, epoch.load(Ordering::SeqCst), *gate.lock().unwrap()));
    assert_eq!(commit_mode_if_fresh(&expanded, job1, &epoch, true), false);
    assert_eq!(*expanded.lock().unwrap(), false);
    assert_eq!(commit_mode_if_fresh(&expanded, hide_job, &epoch, true), false);
    let live = mode_take_generation(&epoch, &gate);
    assert_eq!(commit_mode_if_fresh(&expanded, live, &epoch, true), true);
    assert_eq!(*expanded.lock().unwrap(), true);
}

/// Unit 20a1 regression: a successful collapse must commit compact BEFORE
/// its own restore handoff increments the generation. The handoff fake
/// below performs the REAL epoch-incrementing handoff (as production
/// does), so the old inside-transition order self-stales and this fails
/// with `Ok(true)` / expanded still true despite a landed float.

#[cfg(target_os = "linux")]
#[test]
fn cover_cleanup_observes_publishers_under_one_hold() {
    use std::sync::atomic::AtomicU64;
    // Unit 20d1 (RED was the stale-read window: pre-lock snapshot decided
    // with a stale epoch and uncovered the newer gate): the runner loads
    // the epoch INSIDE the acquired gate, over SHARED epoch/gate — never
    // cloned snapshots — so a landed publish is always observed.
    let epoch = AtomicU64::new(6);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (show_job, queue) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert!(queue_reaches_worker(queue));
    let mut effects = 0u32;
    assert!(!run_cover_cleanup_locked(6, &epoch, &gate, &mut || effects += 1));
    assert_eq!(effects, 0, "live newer gate must never be uncovered");
    assert_eq!(*gate.lock().unwrap(), Some(show_job), "newer gate untouched");
    // Lock-hold proof: the hook runs under the hold before the load, so
    // no publisher can interleave between load and decide.
    let mut hook_effects = 0u32;
    assert!(!run_cover_cleanup_locked_with(6, &epoch, &gate, &mut || hook_effects += 1, || {
        assert!(gate.try_lock().is_err(), "publisher interleaved between lock and load");
    }));
    assert_eq!(hook_effects, 0);
}

#[cfg(target_os = "linux")]
#[test]
fn cancel_mark_never_recedes_for_older_timeout() {
    // Unit 20e: overlapping timeouts route through the ACTUAL shared
    // cancellation — Timeout(7), then a late Timeout(6) whose transition
    // must never run — and the water never recedes.
    let mark = Mutex::new(None);
    let mut transition = || -> CommandResult<bool> {
        panic!("no IPC on timeout")
    };
    assert!(route_covered_collapse(CoverAck::Timeout, 7, true, &mark, &mut transition).is_err());
    assert!(route_covered_collapse(CoverAck::Timeout, 6, true, &mark, &mut transition).is_err());
    assert_eq!(*mark.lock().unwrap(), Some(7u64), "late older cancel must not erase the newer mark");
    assert!(!cover_apply_allowed(7, 7, *mark.lock().unwrap()), "cover 7 stays cancelled");
    assert!(!cover_apply_allowed(6, 6, *mark.lock().unwrap()), "older job stays blocked");
    assert!(cover_apply_allowed(8, 8, *mark.lock().unwrap()), "newer uncancelled job still allowed");
}

#[cfg(target_os = "linux")]
#[test]
fn restore_intent_show_bootstraps_without_anchor() {
    // Unit 20g1: initial show without a session anchor explicitly
    // bootstraps; reopen with a saved anchor preserves. No AppHandle.
    assert_eq!(restore_intent_for_show(false), RestoreIntent::BootstrapBase);
    assert_eq!(restore_intent_for_show(true), RestoreIntent::PreserveCompact);
}

#[cfg(target_os = "linux")]
#[test]
fn restore_intent_keeps_the_remembered_spot_on_mode_off() {
    // Requirement S15/S17: leaving expanded/fullscreen must return to the
    // remembered compact spot, so every `!on` request with an anchor
    // preserves; only a request with nothing remembered lands on the
    // calibrated base. Freshness is eligibility only, checked at commit.
    assert_eq!(
        restore_intent_for_mode_request(false, true, true),
        RestoreIntent::PreserveCompact,
        "a remembered spot survives a mode change"
    );
    assert_eq!(
        restore_intent_for_mode_request(false, true, false),
        RestoreIntent::CollapseToBase,
        "nothing remembered: the base is the only place to land"
    );
    assert_eq!(
        restore_intent_for_mode_request(true, true, true),
        RestoreIntent::PreserveCompact
    );
    assert_eq!(
        restore_intent_for_mode_request(false, false, false),
        RestoreIntent::PreserveCompact,
        "invalid native request never carries base intent"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn restore_handoff_carries_owed_base_intent() {
    // Unit 20g1: a connected live gate carries its owed base intent and
    // reveal obligation across a plain Preserve refresh — the refresh
    // must not downgrade the owed CollapseToBase. Publication and read
    // share the gate domain; stale jobs resolve no intent.
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (base_job, _) =
        gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::CollapseToBase, &intents);
    let (next, _) =
        restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert_eq!(
        resolve_job_intent(next, &epoch, &gate, &intents),
        Some(RestoreIntent::CollapseToBase),
        "owed base survives a Preserve refresh"
    );
    assert_eq!(
        resolve_job_intent(base_job, &epoch, &gate, &intents),
        None,
        "superseded base job resolves nothing"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn worker_preserve_without_anchor_never_adopts() {
    // Unit 20g1 BEHAVIORAL: the REAL worker seam against a scripted
    // socket — Preserve with no session anchor must fail explicitly
    // instead of adopting two equal compositor frames as a base.
    // The original adoption path timed out after libtest started:
    // its match guard re-locks native_compact during anchor commit.
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    let frame = worker_windows(Some((1016.0, 502.0)), Some((1444.0, 786.0)));
    let socket_path =
        std::env::temp_dir().join(format!("gd-20g1-preserve-{}.sock", std::process::id()));
    let fake = start_fake_niri(
        &socket_path,
        vec![frame.clone(), frame],
        serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}),
    );
    let data_dir =
        std::env::temp_dir().join(format!("gd-20g1-preserve-{}", std::process::id()));
    let (snap_tx, _snap_rx) = mpsc::channel::<()>();
    let shell = Shell {
        config: DesktopConfig { data_dir: data_dir.clone(), port: 0, shortcut: String::new() },
        daemon: Arc::new(Daemon::new(0, data_dir, None)),
        snap: snap_tx,
        places_windows: false,
        rose_hidden: AtomicBool::new(false),
        panel_spot: Mutex::new(None),
        full_screen: Mutex::new(None),
        native_expanded: Mutex::new(false),
        native_compact: Mutex::new(None),
        native_epoch: AtomicU64::new(6),
        native_restore: Mutex::new(None),
        native_gate: Mutex::new(None),
        native_intent: Mutex::new(Some((6, RestoreIntent::PreserveCompact))),
        native_unit: Mutex::new(NiriUnitState::dormant()),
        native_mover: Mutex::new(None),
        native_suppress_until: Mutex::new(None),
        cover_cancelled: Mutex::new(None),
        native_hide_job: Mutex::new(None),
        native_io: Mutex::new(()),
        native_work_area: Mutex::new(None),
        native_unit_cache: Mutex::new(None),
        shortcut: Mutex::new(None),
    };
    let mut setter_calls = 0;
    let mut set_resizable_panel = |_: bool| { setter_calls += 1; Ok(()) };
    let socket = socket_path.to_str().expect("temp socket path is utf-8").to_owned();
    let cases = [
        (6, Some((6, RestoreIntent::PreserveCompact)), false, Some("niri: compact anchor unavailable; hidden for retry")),
        (6, None, false, Some("niri: restore intent unavailable; hidden for retry")),
        (6, Some((5, RestoreIntent::PreserveCompact)), false, Some("niri: restore intent unavailable; hidden for retry")),
        (7, Some((6, RestoreIntent::PreserveCompact)), false, None),
        (6, Some((6, RestoreIntent::BootstrapBase)), false, Some("niri: base calibration requires owned cover; hidden for retry")),
        (6, Some((6, RestoreIntent::CollapseToBase)), false, Some("niri: base calibration requires owned cover; hidden for retry")),
        (6, Some((6, RestoreIntent::BootstrapBase)), true, Some("niri: base calibration requires owned cover; hidden for retry")),
        (6, Some((6, RestoreIntent::CollapseToBase)), true, Some("niri: base calibration requires owned cover; hidden for retry")),
    ];
    let mut outcomes = Vec::new();
    for hidden in [false, true] {
        for (epoch, intent, anchored, error) in cases {
            let saved = anchored.then(|| crate::niri::CompactSpot {
                output: "DP-1".to_owned(), x: 1016.0, y: 502.0,
            });
            shell.rose_hidden.store(hidden, Ordering::SeqCst);
            shell.native_epoch.store(epoch, Ordering::SeqCst);
            *shell.native_intent.lock().unwrap() = intent;
            *shell.native_compact.lock().unwrap() = saved.clone();
            let outcome = run_restore_job_inner(&shell, 6, &mut set_resizable_panel, Some(&socket));
            let expected = error.map_or(Ok(false), |error| Err(error.to_owned()));
            let unchanged = *shell.native_compact.lock().unwrap() == saved
                && shell.native_epoch.load(Ordering::SeqCst) == epoch
                && *shell.native_intent.lock().unwrap() == intent
                && shell.native_gate.lock().unwrap().is_none()
                && shell.native_mover.lock().unwrap().is_none()
                && shell.native_hide_job.lock().unwrap().is_none();
            outcomes.push((hidden, intent, anchored, outcome, expected, unchanged));
        }
    }
    let requests = fake.requests().clone();
    fake.finish();
    for (hidden, intent, anchored, outcome, expected, unchanged) in outcomes {
        assert_eq!(outcome, expected, "hidden={hidden} intent={intent:?} anchored={anchored}");
        assert!(unchanged, "rejected job changed state: hidden={hidden} intent={intent:?}");
    }
    assert!(requests.is_empty(), "rejected jobs must perform zero IPC: {requests:?}");
    assert_eq!(setter_calls, 0, "rejected jobs must perform zero toolkit setters");
}

#[cfg(target_os = "linux")]
#[test]
fn covered_collapse_timeout_runs_zero_mode_actions() {
    // Unit 20f3 BEHAVIORAL: the ACTUAL production route — Timeout and
    // Stale run zero mode actions (counted transition), Acked runs
    // exactly one. Timeout still cancels the late cover via the shared
    // mark; Stale reports the live mode untouched.
    let mark = Mutex::new(None);
    let calls = std::cell::Cell::new(0);
    let mut transition = || -> CommandResult<bool> {
        calls.set(calls.get() + 1);
        Ok(false)
    };
    assert!(route_covered_collapse(CoverAck::Timeout, 7, true, &mark, &mut transition).is_err());
    assert!(route_covered_collapse(CoverAck::Stale, 7, true, &mark, &mut transition).is_ok());
    assert_eq!(calls.get(), 0, "timeout/stale must run no mode IPC");
    assert!(route_covered_collapse(CoverAck::Acked, 7, true, &mark, &mut transition).is_ok());
    assert_eq!(calls.get(), 1, "acked cover runs the transition once");
}

#[cfg(target_os = "linux")]
fn test_hide_shell(epoch: u64, anchor: Option<crate::niri::CompactSpot>) -> Shell {
    use std::sync::atomic::AtomicU64;
    let data_dir = std::env::temp_dir().join(format!("gd-20f2-hide-{}", std::process::id()));
    let (snap_tx, _snap_rx) = mpsc::channel::<()>();
    Shell {
        config: DesktopConfig { data_dir: data_dir.clone(), port: 0, shortcut: String::new() },
        daemon: Arc::new(Daemon::new(0, data_dir, None)),
        snap: snap_tx,
        places_windows: false,
        rose_hidden: AtomicBool::new(false),
        panel_spot: Mutex::new(None),
        full_screen: Mutex::new(None),
        native_expanded: Mutex::new(false),
        native_compact: Mutex::new(anchor),
        native_epoch: AtomicU64::new(epoch),
        native_restore: Mutex::new(None),
        native_gate: Mutex::new(None),
        native_intent: Mutex::new(None),
        native_unit: Mutex::new(NiriUnitState::dormant()),
        native_mover: Mutex::new(None),
        native_suppress_until: Mutex::new(None),
        cover_cancelled: Mutex::new(None),
        native_hide_job: Mutex::new(None),
        native_io: Mutex::new(()),
        native_work_area: Mutex::new(None),
        native_unit_cache: Mutex::new(None),
        shortcut: Mutex::new(None),
    }
}

#[cfg(target_os = "linux")]
#[test]
fn timeout_cover_needs_cancellation_ownership() {
    // Unit 20d1 (RED was the epoch-only guard: still fresh after a
    // timeout, so the late cover would re-apply): cancellation is shared
    // ownership — only the mark stops the re-cover.
    assert!(!cover_apply_allowed(6, 6, Some(6)), "cancelled cover must not re-apply");
    assert!(cover_apply_allowed(6, 6, None), "fresh unmarked cover still applies");
    assert!(!cover_apply_allowed(6, 7, None), "stale cover never applies");
    assert!(!cover_apply_allowed(6, 7, Some(6)), "stale cancelled cover never applies");
    assert!(cover_apply_allowed(7, 7, Some(6)), "an older mark never blocks a newer job");
}

#[cfg(target_os = "linux")]
#[test]
fn gateless_bump_before_delivery_erases_pending_uncover() {
    use std::sync::atomic::AtomicU64;
    // Unit 20d: covered refused collapse plans through the ACTUAL finish
    // seam; a gateless take bumps before the queued delivery drains; the
    // pending reset STILL executes. Fake event queue + real production
    // bumps, no GUI. (RED on the old epoch-only delivery: no-op, stuck.)
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let _intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let job = mode_take_generation(&epoch, &gate);
    assert_eq!(job, 6);
    // Plan through the actual finish seam with a recorder: fails if the
    // finish ever stops invoking the applier path.
    let mut recorded = Vec::new();
    finish_collapse_cover_with(
        true, job, false, false,
        epoch.load(Ordering::SeqCst), *gate.lock().unwrap(),
        &mut |cleanup| recorded.push(cleanup),
    );
    assert_eq!(recorded, vec![CoverCleanup::Own(6)]);
    // Fake event queue: the SAME production runner over the shared
    // epoch/gate — no cloned snapshots — exactly like the queued GTK
    // callback.
    let mut effects_ran = false;
    let mut delivered = false;
    let mut queued = Some(|| {
        delivered = run_cover_cleanup_locked(job, &epoch, &gate, &mut || effects_ran = true);
    });
    // Gateless interleave before the callback drains (real production bump).
    let _newer = mode_take_generation(&epoch, &gate);
    assert_eq!(epoch.load(Ordering::SeqCst), 7);
    assert_eq!(*gate.lock().unwrap(), None, "gateless take installs no visual owner");
    queued.take().expect("queued delivery")();
    assert!(delivered, "pending uncover must survive a gateless bump before delivery");
    assert!(effects_ran, "reset effects ran despite the epoch advance");
    // Own stale gate releases in the same hold.
    let epoch2 = AtomicU64::new(7);
    let mut stale = Some(6u64);
    let mut effects2 = 0u32;
    assert!(run_cover_delivery(6, epoch2.load(Ordering::SeqCst), &mut stale, &mut || effects2 += 1));
    assert_eq!(stale, None);
    assert_eq!(effects2, 1);
}

#[cfg(target_os = "linux")]
#[test]
fn cover_delivery_skips_live_newer_gate() {
    use std::sync::atomic::AtomicU64;
    // Same queued delivery, but a successor gated show publishes through
    // the REAL sender path before the callback drains: no reset, no
    // input/focus writes, and the newer gate is never cleared.
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let job = mode_take_generation(&epoch, &gate);
    assert_eq!(job, 6);
    let mut recorded = Vec::new();
    finish_collapse_cover_with(
        true, job, false, false,
        epoch.load(Ordering::SeqCst), *gate.lock().unwrap(),
        &mut |cleanup| recorded.push(cleanup),
    );
    assert_eq!(recorded, vec![CoverCleanup::Own(6)]);
    let mut effects_ran = false;
    let mut delivered = false;
    let mut queued = Some(|| {
        delivered = run_cover_cleanup_locked(job, &epoch, &gate, &mut || effects_ran = true);
    });
    // Successor publishes through the actual gated sender before delivery.
    let (show_job, queue) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert!(queue_reaches_worker(queue));
    queued.take().expect("queued delivery")();
    assert!(!delivered, "live newer gate must never be uncovered");
    assert!(!effects_ran, "no opacity/input writes over the successor");
    assert_eq!(*gate.lock().unwrap(), Some(show_job), "newer gate untouched");
}

/// Covered collapse outcomes through the ONE shared finish: refused-Ok,
/// disconnected-sender, wire-error, and successful Sent/Coalesced shapes —
/// real mode orchestration plus real sender outcomes, never a hardcoded
/// handoff behind the assertions.

#[cfg(target_os = "linux")]
#[test]
fn unconfirmed_cover_aborts_before_any_ipc() {
    // Unit 20d1: Timeout runs through the ACTUAL routing with fakes that
    // panic on ANY transition IPC, setter, or handoff — no float
    // requests, no queued restore. Cleanup invoked via the finish
    // recorder; the shared mark stops the late cover; Acked still
    // transitions; Stale runs no IPC and reports the live mode.
    let mark = Mutex::new(None);
    let mut transition = || -> CommandResult<bool> {
        panic!("transition IPC must never run after an unconfirmed cover")
    };
    let outcome = route_covered_collapse(CoverAck::Timeout, 6, true, &mark, &mut transition);
    let err = outcome.expect_err("timeout fails closed");
    assert!(err.contains("timed out"), "bounded explicit error, got {err}");
    assert_eq!(*mark.lock().unwrap(), Some(6), "shared cancellation mark set");
    assert!(!cover_apply_allowed(6, 6, *mark.lock().unwrap()), "late cover cannot re-cover after cleanup");
    // Production tail then routes (err, nothing queued) through the
    // shared finish: nothing bumped, no visual owner — uncover owned.
    let mut finished = Vec::new();
    finish_collapse_cover_with(
        true, 6, true, false, 6, None,
        &mut |cleanup| finished.push(cleanup),
    );
    assert_eq!(finished, vec![CoverCleanup::Own(6)], "cleanup invoked with err + nothing queued");
    // Acked still runs the transition and leaves cleanup to the tail.
    let mark2 = Mutex::new(None);
    let mut transition2 = || -> CommandResult<bool> { Ok(false) };
    assert_eq!(
        route_covered_collapse(CoverAck::Acked, 6, true, &mark2, &mut transition2),
        Ok(false)
    );
    assert_eq!(*mark2.lock().unwrap(), None, "no mark on the confirmed path");
    // Stale runs no IPC, reports the live mode, still routes cleanup.
    let mark3 = Mutex::new(None);
    let mut transition3 = || -> CommandResult<bool> {
        panic!("stale runs no IPC")
    };
    assert_eq!(
        route_covered_collapse(CoverAck::Stale, 6, false, &mark3, &mut transition3),
        Ok(false),
        "stale reports the live mode"
    );
    assert_eq!(*mark3.lock().unwrap(), None, "no mark on the stale path");
    // Production tail routes the stale Ok the same shared way.
    let mut finished3 = Vec::new();
    finish_collapse_cover_with(
        true, 6, false, false, 6, None,
        &mut |cleanup| finished3.push(cleanup),
    );
    assert_eq!(finished3, vec![CoverCleanup::Own(6)]);
}

#[cfg(target_os = "linux")]
#[test]
fn cover_cleanup_never_uncovers_a_newer_gate() {
    // Planner arm matrix (the orchestration tests above own the
    // end-to-end Own/Current shapes): a live newer gate is never
    // uncovered — neither on refused-Ok, nor on queued success, nor on
    // propagated errors — and an undispatched cover plans nothing.
    assert_eq!(plan_cover_cleanup(true, false, false, 5, 6, Some(6)), None);
    assert_eq!(plan_cover_cleanup(true, true, false, 5, 6, Some(6)), None);
    assert_eq!(plan_cover_cleanup(true, false, true, 5, 6, Some(6)), None);
    assert_eq!(plan_cover_cleanup(false, true, false, 5, 5, None), None);
}

/// Unit 20a2a RED: commit job5 fresh, a competing show publishes job6,
/// then OUR unconditional handoff runs (old order). It must retain the
/// newer gate and never bump past it — the old unconditional publish
/// steals it. Existing production fns only; no new symbols yet.

#[cfg(target_os = "linux")]
#[test]
fn commit_then_handoff_never_steals_newer_gate() {
    // Commit job5 fresh, a competing show publishes job6, then OUR
    // compare-and-handoff runs: it must refuse, retaining the newer gate
    // and never bumping past it. (RED on the old unconditional order:
    // gate became Some(7), epoch 7.)
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    assert_eq!(commit_mode_if_fresh(&expanded, 5, &epoch, false), false);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert_eq!(show_job, 6);
    assert_eq!(gated_handoff_if_expected(&tx, &epoch, &gate, 5, RestoreIntent::PreserveCompact, &intents), None);
    assert_eq!(*gate.lock().unwrap(), Some(show_job), "newer gate retained");
    assert_eq!(epoch.load(Ordering::SeqCst), show_job, "no bump past newer show");
    // A fresh expectation still proceeds and publishes (the channel
    // still holds the competitor's wake, so Coalesced is the correct
    // outcome — it still reaches the worker).
    let live = mode_take_generation(&epoch, &gate);
    let (our_job, queue) = gated_handoff_if_expected(&tx, &epoch, &gate, live, RestoreIntent::PreserveCompact, &intents)
        .expect("fresh handoff proceeds");
    assert_eq!(our_job, live + 1);
    assert!(queue_reaches_worker(queue));
    assert_eq!(*gate.lock().unwrap(), Some(our_job));
}

/// Unit 20a2a RED: job5 hidden collapse commits; a competing gated show
/// holds job6; the old unconditional plain handoff bumps past it, so the
/// show's reveal guard (`job == current`) can never hold — stranded at
/// opacity 0. Plain must refuse once superseded.

#[cfg(target_os = "linux")]
#[test]
fn plain_handoff_after_newer_show_keeps_it_revealable() {
    // Job5 hidden collapse commits; a competing gated show holds job6;
    // the plain compare-and-handoff refuses, so the show's reveal guard
    // still holds. (RED on the old unconditional plain bump: epoch moved
    // to 7 and the show stranded at opacity 0.)
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    assert_eq!(commit_mode_if_fresh(&expanded, 5, &epoch, false), false);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert_eq!(plain_handoff_if_expected(&tx, &epoch, &gate, 5, RestoreIntent::PreserveCompact, &intents), None);
    assert!(
        settled_reveal_eligible(true, show_job, epoch.load(Ordering::SeqCst), *gate.lock().unwrap()),
        "newer gated show stays revealable"
    );
    // A fresh plain expectation still bumps without publishing any gate
    // (Coalesced here is correct — the competitor's wake is queued).
    let live = mode_take_generation(&epoch, &gate);
    let (plain_job, queue) = plain_handoff_if_expected(&tx, &epoch, &gate, live, RestoreIntent::PreserveCompact, &intents)
        .expect("fresh plain handoff proceeds");
    assert!(queue_reaches_worker(queue));
    assert_eq!(*gate.lock().unwrap(), None, "plain never publishes");
    assert_eq!(epoch.load(Ordering::SeqCst), plain_job);
}

/// Unit 20a2a: full seam with a competitor injected between our commit
/// and our handoff — the exact interleave the old order could not
/// survive. Our compare-and-handoff must refuse: the newer gate stays,
/// the epoch never moves past it, and we still report our committed
/// compact mode. Deterministic: the injection runs inside the handoff
/// step itself, no threads or sleeps.

#[cfg(target_os = "linux")]
#[test]
fn failed_collapse_unwinds_only_its_own_cover() {
    assert_eq!(unwind_reset_generation(true, 5, 5), Some(5));
    assert_eq!(unwind_reset_generation(true, 5, 6), None);
    assert_eq!(unwind_reset_generation(false, 5, 5), None);
    assert_eq!(unwind_reset_generation(false, 5, 6), None);
    // The owned unwind restores visuals; a successor generation plans
    // nothing, so newer visuals are never touched.
    assert!(plan_gate_effects(5, unwind_reset_generation(true, 5, 5).unwrap(), false)
        .contains(&GateEffect::ResetVisuals));
    assert_eq!(plan_gate_effects(6, 5, false), Vec::<GateEffect>::new());
}

/// Unit 20a2a RED: mover taken at job5; collapse job6 resets the anchor
/// to None; the worker assigns without rechecking the generation and
/// resurrects a dead anchor. Stale wakes must not undo the reset.

#[cfg(target_os = "linux")]
#[test]
fn plain_handoff_carries_a_fresh_gate_forward() {
    use std::sync::atomic::AtomicU64;
    // Production paths: the rose-unhide joint wake and the ungated
    // expanded show both call the real `restore_handoff`. While a gated
    // show owns the current generation, that plain wake must carry the
    // reveal obligation forward — not bump past it and strand opacity 0.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert_eq!(*gate.lock().unwrap(), Some(show_job));
    let (plain_job, _) = restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    assert!(plain_job > show_job);
    let current = epoch.load(Ordering::SeqCst);
    let held = *gate.lock().unwrap();
    assert_eq!(current, plain_job);
    assert_eq!(held, Some(plain_job), "plain wake orphaned the fresh gated show");
    assert!(settled_reveal_eligible(true, plain_job, current, held));
    // Ungated plain case keeps the historical wake: no gate invented.
    let epoch2 = AtomicU64::new(0);
    let gate2: Mutex<Option<u64>> = Mutex::new(None);
    let intents2 = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx2, _rx2) = mpsc::sync_channel::<()>(1);
    assert_eq!(restore_handoff(&tx2, &epoch2, &gate2, RestoreIntent::PreserveCompact, &intents2).0, 1);
    assert_eq!(*gate2.lock().unwrap(), None);
    // An already-superseded gate is never adopted by a newer plain wake.
    let epoch3 = AtomicU64::new(5);
    let gate3 = Mutex::new(Some(3));
    let intents3 = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx3, _rx3) = mpsc::sync_channel::<()>(1);
    assert_eq!(restore_handoff(&tx3, &epoch3, &gate3, RestoreIntent::PreserveCompact, &intents3).0, 6);
    assert_eq!(*gate3.lock().unwrap(), Some(3));
}

#[cfg(target_os = "linux")]
#[test]
fn anchor_commit_refuses_a_stale_wake_after_production_bump() {
    use std::sync::atomic::AtomicU64;
    // Generations come from real production calls — gated show, then a
    // collapse take that resets the anchor — never literal constants.
    // The stale show-epoch write must refuse so the reset is never
    // resurrected.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    let compact: Mutex<Option<crate::niri::CompactSpot>> = Mutex::new(None);
    let spot = Some(crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 1.0, y: 2.0 });
    assert!(commit_compact_anchor(&compact, &gate, &epoch, show_job, spot));
    let collapse = mode_take_generation(&epoch, &gate);
    assert!(commit_compact_anchor(&compact, &gate, &epoch, collapse, None));
    assert_eq!(*compact.lock().unwrap(), None);
    let stale = Some(crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 9.0, y: 9.0 });
    assert!(!commit_compact_anchor(&compact, &gate, &epoch, show_job, stale));
    assert_eq!(*compact.lock().unwrap(), None, "stale wake must not undo reset");
}

#[cfg(target_os = "linux")]
#[test]
fn anchor_commit_holds_the_generation_domain_across_check_and_store() {
    use std::sync::atomic::AtomicU64;
    // The hook runs between the freshness check and the anchor store
    // while the commit holds its locks: any gate-domain bump attempted
    // exactly there must serialize outside, never interleave.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    let compact: Mutex<Option<crate::niri::CompactSpot>> = Mutex::new(None);
    let spot = Some(crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 1.0, y: 2.0 });
    let landed = commit_compact_anchor_with_hook(&compact, &gate, &epoch, show_job, spot.clone(), || {
        assert!(gate.try_lock().is_err(), "gate-domain bump interleaved between check and store");
        assert!(compact.try_lock().is_err(), "anchor store not under the compact lock");
        assert_eq!(epoch.load(Ordering::SeqCst), show_job);
    });
    assert!(landed);
    assert_eq!(*compact.lock().unwrap(), spot);
}

#[cfg(target_os = "linux")]
#[test]
fn mover_ownership_is_generation_guarded() {
    use std::sync::atomic::AtomicU64;
    // Collapse clear and worker put-back share one gate→mover domain:
    // a superseded job neither clears a fresh mover nor resurrects one.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
    let mover = Mutex::new(Some(crate::niri::Mover::Dot));
    assert!(clear_mover_if_fresh(&mover, &gate, &epoch, show_job));
    assert_eq!(*mover.lock().unwrap(), None);
    assert!(restore_mover_if_fresh(&mover, &gate, &epoch, show_job, crate::niri::Mover::Panel));
    assert_eq!(*mover.lock().unwrap(), Some(crate::niri::Mover::Panel));
    let _collapse = mode_take_generation(&epoch, &gate);
    assert!(!clear_mover_if_fresh(&mover, &gate, &epoch, show_job));
    assert_eq!(*mover.lock().unwrap(), Some(crate::niri::Mover::Panel));
    assert!(!restore_mover_if_fresh(&mover, &gate, &epoch, show_job, crate::niri::Mover::Dot));
    assert_eq!(*mover.lock().unwrap(), Some(crate::niri::Mover::Panel));
}

#[cfg(target_os = "linux")]
#[test]
fn stale_mover_wake_never_undoes_collapse_reset() {
    // Mover taken at job5; collapse job6 resets the anchor to None; the
    // synchronized commit refuses the stale write. (RED on the old
    // unchecked write: anchor resurrected to Some.)
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let _intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let mover = Mutex::new(Some(crate::niri::Mover::Dot));
    let compact: Mutex<Option<crate::niri::CompactSpot>> = Mutex::new(None);
    let taken = mover.lock().unwrap().take();
    assert!(taken.is_some());
    let _collapse = mode_take_generation(&epoch, &gate);
    assert!(commit_compact_anchor(&compact, &gate, &epoch, 6, None));
    let stale_spot = Some(crate::niri::CompactSpot {
        output: "DP-1".to_owned(),
        x: 1.0,
        y: 2.0,
    });
    assert!(!commit_compact_anchor(&compact, &gate, &epoch, 5, stale_spot));
    assert_eq!(*compact.lock().unwrap(), None, "stale wake must not undo reset");
    // A fresh write still lands, and a fresh reset still clears.
    let anchor = Some(crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 3.0, y: 4.0 });
    assert!(commit_compact_anchor(&compact, &gate, &epoch, 6, anchor.clone()));
    assert_eq!(*compact.lock().unwrap(), anchor);
    assert!(commit_compact_anchor(&compact, &gate, &epoch, 6, None));
    assert_eq!(*compact.lock().unwrap(), None);
}

#[cfg(target_os = "linux")]
#[test]
fn gated_handoff_publishes_before_dispatch() {
    use std::sync::atomic::AtomicU64;
    // After-return checks alone would still pass for a store-after-send
    // regression (the store lands before these asserts run), so the
    // dispatch observer below pins the send moment itself: it runs
    // inside the gate lock after publication and before any worker wake
    // is observable, with no sleeps and no threads.
    let epoch = AtomicU64::new(0);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let (job, queue) = gated_restore_handoff_with_send(
        &epoch,
        &gate,
        RestoreIntent::PreserveCompact,
        &intents,
        |dispatched_job, dispatched_gate, dispatched_intent| {
        assert_eq!(dispatched_job, 1);
        assert_eq!(dispatched_gate, Some(1));
        assert_eq!(dispatched_intent, RestoreIntent::PreserveCompact);
        assert_eq!(epoch.load(Ordering::SeqCst), 1);
        match tx.try_send(()) {
            Ok(()) => RestoreQueue::Sent,
            Err(mpsc::TrySendError::Full(_)) => RestoreQueue::Coalesced,
            Err(mpsc::TrySendError::Disconnected(_)) => RestoreQueue::Disconnected,
        }
    });
    assert_eq!(job, 1);
    assert_eq!(queue, RestoreQueue::Sent);
    assert_eq!(*gate.lock().unwrap(), Some(job));
    assert_eq!(epoch.load(Ordering::SeqCst), job);
    assert!(rx.try_recv().is_ok());
    // Second handoff observes the next generation the same way.
    let (tx2, rx2) = mpsc::sync_channel::<()>(1);
    // Drain-less reuse: fresh channel keeps the queue outcome Sent.
    let _ = rx;
    let epoch2 = AtomicU64::new(1);
    let gate2 = Mutex::new(Some(1));
    let intents2 = Mutex::new(None::<(u64, RestoreIntent)>);
    let (job2, queue2) = gated_restore_handoff_with_send(
        &epoch2,
        &gate2,
        RestoreIntent::CollapseToBase,
        &intents2,
        |dispatched_job, dispatched_gate, dispatched_intent| {
        assert_eq!(dispatched_job, 2);
        assert_eq!(dispatched_gate, Some(2));
        assert_eq!(dispatched_intent, RestoreIntent::CollapseToBase);
        assert_eq!(epoch2.load(Ordering::SeqCst), 2);
        match tx2.try_send(()) {
            Ok(()) => RestoreQueue::Sent,
            Err(mpsc::TrySendError::Full(_)) => RestoreQueue::Coalesced,
            Err(mpsc::TrySendError::Disconnected(_)) => RestoreQueue::Disconnected,
        }
    });
    assert_eq!(job2, 2);
    assert_eq!(queue2, RestoreQueue::Sent);
    assert_eq!(*gate2.lock().unwrap(), Some(job2));
    assert_eq!(epoch2.load(Ordering::SeqCst), job2);
    assert!(rx2.try_recv().is_ok());
    // Production wrapper keeps the same contract after return.
    let epoch3 = AtomicU64::new(0);
    let gate3 = Mutex::new(None);
    let intents3 = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx3, rx3) = mpsc::sync_channel::<()>(1);
    let (job3, queue3) = gated_restore_handoff(&tx3, &epoch3, &gate3, RestoreIntent::PreserveCompact, &intents3);
    assert_eq!((job3, queue3), (1, RestoreQueue::Sent));
    assert_eq!(*gate3.lock().unwrap(), Some(1));
    assert!(rx3.try_recv().is_ok());
}

#[cfg(target_os = "linux")]
#[test]
fn io_worker_wire_never_overlaps_mode() {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    // Unit 20f: W mirrors the production worker pass-top (raw io hold +
    // fresh + desired re-check, NO state lock) and parks in fake joint
    // wire; M mirrors the mode transition closure (sequenced fake apply).
    // Order log proves no overlap; try_lock proves the parked wire holds
    // no state lock, so mode commits never block mid-transaction.
    const BOUND: Duration = Duration::from_secs(5);
    let io = Arc::new(Mutex::new(()));
    let epoch = Arc::new(AtomicU64::new(6));
    let gate: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let expanded = Arc::new(Mutex::new(false));
    let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (attempting_tx, attempting_rx) = mpsc::channel::<()>();
    let t = (io, epoch, gate, expanded, log);
    let (iow, epochw, expandedw, logw) =
        (Arc::clone(&t.0), Arc::clone(&t.1), Arc::clone(&t.3), Arc::clone(&t.4));
    let w = std::thread::spawn(move || {
        let _hold = iow.lock().unwrap();
        if !restore_job_fresh(6, epochw.load(Ordering::SeqCst))
            || *expandedw.lock().unwrap()
        {
            return;
        }
        logw.lock().unwrap().push("W-enter");
        entered_tx.send(()).unwrap_or(());
        let _ = release_rx.recv_timeout(BOUND);
        logw.lock().unwrap().push("W-exit");
    });
    entered_rx.recv_timeout(BOUND).expect("worker parked in wire");
    assert!(t.3.try_lock().is_ok(), "mode lock free while worker wire blocked");
    assert!(t.2.try_lock().is_ok(), "gate free while worker wire blocked");
    let (iom, epochm, logb) = (Arc::clone(&t.0), Arc::clone(&t.1), Arc::clone(&t.4));
    let m = std::thread::spawn(move || {
        logb.lock().unwrap().push("M-attempt");
        attempting_tx.send(()).unwrap_or(());
        native_io_sequenced(&iom, &epochm, 6, || {
            logb.lock().unwrap().push("M-enter");
        });
    });
    attempting_rx.recv_timeout(BOUND).expect("mode at the gate");
    release_tx.send(()).expect("release worker");
    w.join().expect("worker joined");
    m.join().expect("mode joined");
    assert_eq!(
        *t.4.lock().unwrap(),
        vec!["W-enter", "M-attempt", "W-exit", "M-enter"],
        "mode waits while worker wire holds io"
    );
}

/// Fake compositor handle (unit 20f3): explicit stop + join + socket
/// removal, so the accept loop never outlives its test. The blocking
/// accept wakes via a self-connection; client reads carry a timeout so
/// no stuck peer hangs teardown. Consume with finish() at test end — a
/// panicking test leaks the thread till process end, same as before.
#[cfg(target_os = "linux")]
struct FakeNiri {
    log: std::sync::Arc<Mutex<Vec<String>>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    path: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl FakeNiri {
    fn requests(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.log.lock().unwrap()
    }
    fn finish(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept; the loop exits on the stop flag.
        let _ = std::os::unix::net::UnixStream::connect(&self.path);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("fake compositor joins");
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Scripted Niri socket for worker-pass tests (unit 20f1): serves queued
/// windows snapshots (repeating the last), a constant workspaces payload,
/// and `Handled` for actions on a fresh connection per request, logging
/// every wire. Every client wait stays inside request budgets; teardown
/// joins through the returned handle (unit 20f3).

#[cfg(target_os = "linux")]
fn start_fake_niri(
    path: &std::path::Path,
    windows: Vec<serde_json::Value>,
    workspaces: serde_json::Value,
) -> FakeNiri {
    use std::os::unix::net::UnixListener;
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).expect("fake socket binds");
    let log = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let queue = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::from(windows)));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (log_thread, queue_thread, stop_thread) = (Arc::clone(&log), Arc::clone(&queue), Arc::clone(&stop));
    let thread = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        loop {
            if stop_thread.load(Ordering::SeqCst) {
                break;
            }
            let Ok((mut stream, _)) = listener.accept() else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let mut line = String::new();
            let clone = match stream.try_clone() {
                Ok(clone) => clone,
                Err(_) => continue,
            };
            if BufReader::new(clone).read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            let wire = line.trim().to_owned();
            if wire.is_empty() {
                continue;
            }
            log_thread.lock().unwrap().push(wire.clone());
            let payload = if wire.contains("Windows") {
                let mut queue = queue_thread.lock().unwrap();
                if queue.len() > 1 {
                    queue.pop_front().unwrap()
                } else {
                    queue[0].clone()
                }
            } else if wire.contains("Workspaces") {
                workspaces.clone()
            } else if wire == "\"Version\"" {
                serde_json::json!({"Version":"26.04 (fixture)"})
            } else {
                serde_json::json!("Handled")
            };
            let reply = serde_json::json!({"Ok": payload}).to_string() + "\n";
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    FakeNiri { log, stop, thread: Some(thread), path: path.to_path_buf() }
}

/// Worker-pass windows fixture (unit 20f1): exact pid+title panel and
/// dot on one workspace; positions scripted per pass, sizes fixed.

#[cfg(target_os = "linux")]
fn worker_windows(panel_pos: Option<(f64, f64)>, dot_pos: Option<(f64, f64)>) -> serde_json::Value {
    let pid = std::process::id();
    let layout = |pos: Option<(f64, f64)>, size: (i32, i32)| match pos {
        Some((x, y)) => serde_json::json!({"tile_pos_in_workspace_view": [x, y], "window_size": [size.0, size.1], "tile_size": [size.0, size.1]}),
        None => serde_json::json!({"window_size": [size.0, size.1], "tile_size": [size.0, size.1]}),
    };
    serde_json::json!({"Windows": [
        {"id": 9, "pid": pid, "title": crate::platform::PANEL_TITLE, "workspace_id": 7,
         "is_floating": true, "layout": layout(panel_pos, (420, 640))},
        {"id": 7, "pid": pid, "title": crate::platform::DOT_TITLE, "workspace_id": 7,
         "is_floating": true, "layout": layout(dot_pos, (72, 72))},
    ]})
}

#[cfg(target_os = "linux")]
#[test]
fn worker_bootstrap_and_collapse_calibrate_then_restore_the_owned_base() {
    use std::sync::atomic::AtomicU64;
    for hidden in [false,true] {
        for intent in [RestoreIntent::BootstrapBase,RestoreIntent::CollapseToBase,RestoreIntent::PreserveCompact] {
            let x = if intent == RestoreIntent::PreserveCompact {80.0} else if hidden {860.0} else {780.0};
            let y = if intent == RestoreIntent::PreserveCompact {50.0} else {42.0};
            let final_frame = worker_windows(Some((x,y)),Some((x+428.0,y+284.0)));
            let frames = vec![
                worker_windows(Some((200.0,100.0)),Some((300.0,100.0))),
                worker_windows(Some((200.0,100.0)),Some((300.0,100.0))),
                worker_windows(Some((12.0,30.0)),Some((300.0,100.0))),
                worker_windows(Some((13.0,31.0)),Some((300.0,100.0))),
                worker_windows(Some((12.0,30.0)),Some((300.0,100.0))),
                worker_windows(Some((1217.0,955.0)),Some((300.0,100.0))),
                worker_windows(Some((1217.0,955.0)),Some((300.0,100.0))),
                final_frame,
            ];
            let path = std::env::temp_dir().join(format!("gd-base-{}-{hidden}-{intent:?}.sock",std::process::id()));
            let fake = start_fake_niri(&path,frames,
                serde_json::json!({"Workspaces":[{"id":7,"output":"DP-1"}]}));
            let data_dir = std::env::temp_dir().join(format!("gd-base-data-{}",std::process::id()));
            let (snap,_rx) = mpsc::channel();
            let shell = Shell {
                config: DesktopConfig {data_dir:data_dir.clone(),port:0,shortcut:String::new()},
                daemon: Arc::new(Daemon::new(0,data_dir,None)), snap, places_windows:false,
                rose_hidden:AtomicBool::new(hidden), panel_spot:Mutex::new(None), full_screen:Mutex::new(None),
                native_expanded:Mutex::new(false),
                native_compact:Mutex::new(match intent {
                    RestoreIntent::BootstrapBase => None,
                    RestoreIntent::CollapseToBase => Some(CompactSpot {output:"DP-1".into(),x:1.0,y:2.0}),
                    RestoreIntent::PreserveCompact => Some(CompactSpot {output:"DP-1".into(),x:80.0,y:50.0}),
                }),
                native_epoch:AtomicU64::new(6), native_restore:Mutex::new(None), native_gate:Mutex::new(Some(6)),
                native_intent:Mutex::new(Some((6,intent))),
                native_unit:Mutex::new(NiriUnitState::dormant()),
                native_mover:Mutex::new(None),
                native_suppress_until:Mutex::new(None), cover_cancelled:Mutex::new(None),
                native_hide_job:Mutex::new(None), native_io:Mutex::new(()),
                native_work_area:Mutex::new(None), native_unit_cache:Mutex::new(None), shortcut:Mutex::new(None),
            };
            let mut setters = 0;
            let mut setter = |_: bool| {setters += 1; Ok(())};
            let result = run_restore_job_inner(&shell,6,&mut setter,path.to_str());
            let requests = fake.requests().clone();
            fake.finish();
            assert_eq!(result,Ok(true),"hidden={hidden} intent={intent:?}");
            assert_eq!(*shell.native_compact.lock().unwrap(),Some(CompactSpot {output:"DP-1".into(),x,y}));
            assert!(shell.native_work_area.lock().unwrap().is_some(), "covered preserve must measure bounds without resetting its anchor");
            assert_eq!(shell.native_epoch.load(Ordering::SeqCst),6);
            assert_eq!(*shell.native_gate.lock().unwrap(),Some(6));
            assert_eq!(*shell.native_intent.lock().unwrap(),Some((6,intent)));
            assert!(shell.native_mover.lock().unwrap().is_none());
            assert!(shell.native_hide_job.lock().unwrap().is_none());
            assert_eq!(setters,0,"compact calibration never changes expanded constraints");
            let moves: Vec<_> = requests.iter().filter(|wire| wire.contains("MoveFloatingWindow")).collect();
            assert_eq!(moves.len(),if hidden {5} else {6});
            assert!(requests.iter().any(|wire| wire == "\"Version\""));
            assert!(moves.iter().all(|wire| {
                let wire: serde_json::Value = serde_json::from_str(wire).unwrap();
                matches!(wire["Action"]["MoveFloatingWindow"]["id"].as_u64(),Some(9)|Some(7))
            }));
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn worker_requeries_after_null_position_wait() {
    // Unit 20f1: a null dot position must re-query before acting. Pass 1
    // observes stale panel coords + missing dot; pass 2 observes settled
    // geometry. Full worker pass through the REAL run_restore_job_inner
    // against a scripted socket — no compositor, no windows.
    // (RED on the old fall-through: a move from the stale pass-1
    // coordinates is queued before any re-query.)
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    let anchor = crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 816.0, y: 422.0 };
    let (rx, ry) = crate::niri::rose_beside_panel_target(
        (anchor.x, anchor.y), (420, 640), (72, 72), PANEL_GAP);
    let stale = worker_windows(Some((100.0, 100.0)), None);
    let settled = worker_windows(Some((anchor.x, anchor.y)), Some((rx as f64, ry as f64)));
    let socket_path =
        std::env::temp_dir().join(format!("gd-20f1-niri-{}.sock", std::process::id()));
    let fake = start_fake_niri(
        &socket_path,
        vec![stale, settled],
        serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}),
    );
    // Explicit socket path (unit 20f3): no process-environment mutation —
    // parallel tests can never observe each other's sockets.
    let data_dir = std::env::temp_dir().join(format!("gd-20f1-data-{}", std::process::id()));
    let (snap_tx, _snap_rx) = mpsc::channel::<()>();
    let shell = Shell {
        config: DesktopConfig { data_dir: data_dir.clone(), port: 0, shortcut: String::new() },
        daemon: Arc::new(Daemon::new(0, data_dir, None)),
        snap: snap_tx,
        places_windows: false,
        rose_hidden: AtomicBool::new(false),
        panel_spot: Mutex::new(None),
        full_screen: Mutex::new(None),
        native_expanded: Mutex::new(false),
        native_compact: Mutex::new(Some(anchor)),
        native_epoch: AtomicU64::new(6),
        native_restore: Mutex::new(None),
        native_gate: Mutex::new(None),
        native_intent: Mutex::new(Some((6, RestoreIntent::PreserveCompact))),
        native_unit: Mutex::new(NiriUnitState::dormant()),
        native_mover: Mutex::new(None),
        native_suppress_until: Mutex::new(None),
        cover_cancelled: Mutex::new(None),
        native_hide_job: Mutex::new(None),
        native_io: Mutex::new(()),
        native_work_area: Mutex::new(None),
        native_unit_cache: Mutex::new(None),
        shortcut: Mutex::new(None),
    };
    // Full worker pass through the REAL seam (no AppHandle needed:
    // state plus one injected no-op setter — no compositor, no windows).
    let mut set_resizable_panel = |_: bool| Ok(());
    let socket = socket_path.to_str().expect("temp socket path is utf-8").to_owned();
    let outcome = run_restore_job_inner(&shell, 6, &mut set_resizable_panel, Some(&socket));
    assert_eq!(outcome, Ok(true));
    let log = fake.requests();
    assert!(
        log.iter().filter(|w| w.contains("Windows")).count() >= 2,
        "must re-query after the wait"
    );
    assert!(
        log.iter().all(|w| !w.contains("MoveFloatingWindow")),
        "zero action from stale coordinates: {log:?}"
    );
    drop(log);
    fake.finish();
}

#[cfg(target_os = "linux")]
#[test]
fn gated_handoff_serializes_concurrent_shows() {
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Barrier};
    // Deterministic concurrency: barrier start, join end, no sleeps. The
    // gate lock serializes bump+store so epoch order always matches gate
    // order; the join observes the final state, never a timed race.
    const SHOWS: u64 = 8;
    let epoch = Arc::new(AtomicU64::new(0));
    let gate = Arc::new(Mutex::new(None));
    let intents = Arc::new(Mutex::new(None::<(u64, RestoreIntent)>));
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let start = Arc::new(Barrier::new(SHOWS as usize));
    let mut handles = Vec::new();
    for _ in 0..SHOWS {
        let (epoch, gate, tx, start, intents) = (Arc::clone(&epoch), Arc::clone(&gate), tx.clone(), Arc::clone(&start), Arc::clone(&intents));
        handles.push(thread::spawn(move || {
            start.wait();
            gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents).0
        }));
    }
    let mut jobs: Vec<u64> = handles.into_iter().map(|h| h.join().expect("show finishes")).collect();
    jobs.sort_unstable();
    assert_eq!(jobs, (1..=SHOWS).collect::<Vec<_>>());
    assert_eq!(epoch.load(Ordering::SeqCst), SHOWS);
    assert_eq!(*gate.lock().unwrap(), Some(SHOWS));
    // Capacity-1 coalescing kept at most one wakequeued; drain it.
    while rx.try_recv().is_ok() {}
}

#[cfg(target_os = "linux")]
#[test]
fn settled_reveal_needs_confirmed_settlement() {
    // Low-level gate pinned here; the production `CommandResult<bool>`
    // routing (deadline/invalid/cancel/reveal) is pinned by
    // `restore_completion_routes_production_results` below, not by
    // these literals alone.
    assert!(settled_reveal_eligible(true, 3, 3, Some(3)));
    assert!(!settled_reveal_eligible(false, 3, 3, Some(3)));
    assert!(!settled_reveal_eligible(true, 3, 4, Some(3)));
    assert!(!settled_reveal_eligible(true, 3, 3, Some(4)));
    assert!(!settled_reveal_eligible(true, 3, 3, None));
    assert!(!settled_reveal_eligible(false, 3, 4, None));
}

#[cfg(target_os = "linux")]
#[test]
fn unit_wiring_registered_for_the_panel() {
    // T10/T19 wiring: the getter exists in shell, is invoked, has a
    // generated permission, and the capability grants it to the panel
    // only. These pass before behavior lands; the pins below fail first.
    let source = include_str!("../shell.rs");
    assert!(source.contains("fn niri_unit_state"), "getter must exist");
    assert!(source.contains("fn niri_unit_ready"), "ready command must exist");
    let invoked = source.split(".invoke_handler").nth(1).unwrap_or("");
    assert!(invoked.contains("niri_unit_state"), "getter must be invoked");
    assert!(invoked.contains("niri_unit_ready"), "ready command must be invoked");
    let build = include_str!("../../build.rs");
    assert!(build.contains("\"niri_unit_state\""), "generated permission must exist");
    assert!(build.contains("\"niri_unit_ready\""), "ready permission must exist");
    let caps = include_str!("../../capabilities/default.json");
    // Split on the identifier line: the bare id also prefixes the
    // permission name, so a bare split would cut inside it.
    let block = caps.split("\"identifier\": \"niri-unit\"").nth(1).unwrap_or("");
    assert!(block.contains("allow-niri-unit-state"), "panel capability must grant the getter");
    assert!(block.contains("allow-niri-unit-ready"), "panel capability must grant the handshake");
    assert!(block.contains("\"windows\": [\"panel\"]"), "grant must be panel-only");
}


#[cfg(target_os = "linux")]
#[test]
fn unit_snapshot_pairs_revision_under_gate() {
    // B2: revision must pair with the copied state. Main holds the gate
    // while a worker snapshots through the production core, then
    // releases and publishes the post-bump pair itself: pre-fix the
    // worker sails through the hold (blocked-assert fails); fixed, it
    // blocks, then reads one whole generation — pre- or post-bump, both
    // consistent. Bounded rendezvous only; the Shell reader echoes the
    // same pair afterwards on the main thread.
    use std::sync::atomic::AtomicU64;
    let gate = Mutex::new(None);
    let unit = Mutex::new(NiriUnitState::dormant());
    let epoch = AtomicU64::new(9);
    let expanded = Mutex::new(false);
    let rose = AtomicBool::new(false);
    let (done_tx, done_rx) = mpsc::channel::<NiriUnitSnapshot>();
    thread::scope(|scope| {
        let held = gate.lock().unwrap();
        scope.spawn(|| {
            done_tx.send(unit_snapshot_locked(&gate, &unit, &epoch, &expanded, &rose, false, true, true)).unwrap();
        });
        assert!(
            done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "snapshot must block on the held gate"
        );
        drop(held);
        // Production caller shape: the gate-owned handoff advances the
        // epoch first; publication follows under the fresh revision
        // (same-revision changed state is ignored downstream). Separate
        // holds — publishing while holding would re-lock the gate.
        let next = {
            let _held = gate.lock().unwrap();
            epoch.fetch_add(1, Ordering::SeqCst) + 1
        };
        assert!(publish_unit_open(&gate, &unit, &epoch, next, true));
        assert_eq!(next, 10);
        let snap = done_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        // Either whole pair is consistent; a rev-9/open-true mix is not.
        assert!(snap.revision == 10 || !snap.open, "revision must match copied state: {snap:?}");
        assert!(!snap.enabled, "dormant activation stays disabled");
    });
    assert_eq!(epoch.load(Ordering::SeqCst), 10);
    assert!(unit.lock().unwrap().open);
    // Thin Shell reader echoes the same pair through production state.
    let shell = test_hide_shell(10, None);
    let snap = unit_snapshot_of(&shell, false, true, true);
    assert_eq!(snap.revision, 10);
    assert!(!snap.open && !snap.enabled);
}

#[cfg(target_os = "linux")]
#[test]
fn shortcut_get_niri_default_is_the_niri_binding_default() {
    // S19 RED: the Niri default reported to Settings must be the binding
    // default, even for the unknown-binding fallback; other backends
    // keep their own default below the Niri branch.
    let source = include_str!("../shell.rs");
    let get = source.split("fn shortcut_get").nth(1).expect("shortcut_get exists")
        .split("\nfn ").next().unwrap_or("");
    assert!(
        get.contains("kdl_binds::DEFAULT_KEY"),
        "Niri shortcut_get must report the Niri binding default"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn restore_completion_routes_production_results() {
    // Production-path routing through `plan_restore_completion` with the
    // real `CommandResult<bool>` shapes `run_restore_job_inner`
    // produces: `Ok(true)` only for confirmed settle (beside, remembered,
    // expanded), `Ok(false)` for stale/no-socket,
    // `Err` for deadline/unresolvable/wire.
    // Only the settled fresh path may reveal; every failure cancels
    // (guarded hide, no focus/emit, Err for retry) or stays silent.
    let deadline: CommandResult<bool> =
        Err("niri: restore deadline exceeded; hidden for retry".to_owned());
    let compact_unresolvable: CommandResult<bool> =
        Err("niri: compact geometry unresolvable; hidden for retry".to_owned());
    let beside_unresolvable: CommandResult<bool> =
        Err("niri: beside-rose geometry unresolvable; hidden for retry".to_owned());
    let wire: CommandResult<bool> = Err("niri: silent".to_owned());
    let unsettled: CommandResult<bool> = Ok(false);
    let settled: CommandResult<bool> = Ok(true);
    // Settled + owns-fresh gate reveals; the reveal closure still
    // re-checks freshness, so stale `Ok(true)` routes to the reveal arm
    // but reveals nothing (previous table owns the stale cases).
    assert_eq!(plan_restore_completion(&settled, true), RestoreCompletion::Reveal);
    assert!(settled_reveal_eligible(true, 3, 3, Some(3)));
    assert!(!settled_reveal_eligible(true, 2, 3, Some(2)));
    assert!(!settled_reveal_eligible(true, 3, 3, Some(4)));
    // Deadline, unresolvable geometry, and wire failures always cancel,
    // fresh or stale (the guarded cancel no-ops when stale).
    for inner in [&deadline, &compact_unresolvable, &beside_unresolvable, &wire] {
        assert_eq!(plan_restore_completion(inner, true), RestoreCompletion::Cancel, "{inner:?}");
        assert_eq!(plan_restore_completion(inner, false), RestoreCompletion::Cancel, "{inner:?}");
        assert!(!settled_reveal_eligible(false, 5, 5, Some(5)));
    }
    // Unsettled (stale cancel, missing socket, absent spot) hides only
    // while still owning a fresh gate, else stays silent for retry.
    assert_eq!(plan_restore_completion(&unsettled, true), RestoreCompletion::Cancel);
    assert_eq!(plan_restore_completion(&unsettled, false), RestoreCompletion::Silent);
    // D1/D2: no unconditional recovery exists — a fresh unsettled job
    // with no gate of its own is an ordinary gateless follower (a stale
    // cancel, a missing socket, a follower pass) and stays silent with
    // Ok(()), never hide/error. Owned-gate failures still cancel above;
    // stale generations plan no effects, so a stale callback can never
    // touch a newer lifecycle. (`false` + `None` is pinned with the gate
    // table; the needles below are joined so this pin holds no match.)
    assert_eq!(plan_restore_completion(&unsettled, false), RestoreCompletion::Silent);
    assert_eq!(plan_gate_effects(4, 3, true), Vec::<GateEffect>::new());
    // The unsafe fallback stays removed: neither the freshness-only
    // predicate nor the unguarded hide/reset may come back, and the
    // completion path must not name them. (Needles are joined so this
    // pin itself contains no contiguous match.)
    let source = include_str!("../shell.rs");
    for needle in [
        ["stranded", "recover", "wanted"].join("_"),
        ["recover", "stranded", "panel"].join("_"),
    ] {
        assert!(!source.contains(&needle), "removed fallback must stay removed: {needle}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn timeout_and_unresolvable_geometry_never_reveal() {
    use crate::niri::{CompactSpot, PanelWindow};
    // Invalid plans fail closed through the production routing: a `None`
    // plan is the unresolvable-geometry `Err`, never a silent `Ok` and
    // never a reveal. The settled home still reveals only when fresh.
    let saved = CompactSpot { output: "DP-1".to_owned(), x: 100.0, y: 200.0 };
    let floating = |pos: Option<(f64, f64)>, size: (i32, i32)| PanelWindow {
        id: 11, floating: true, size, pos, workspace: Some(7),
    };
    assert_eq!(
        plan_compact_restore(Some(&saved), &floating(Some((100.0, 200.0)), (420, 640)), Some("DP-1")),
        Some((11, 0, 0))
    );
    let settled: CommandResult<bool> = Ok(true);
    assert_eq!(plan_restore_completion(&settled, true), RestoreCompletion::Reveal);
    assert!(settled_reveal_eligible(true, 5, 5, Some(5)));
    let unresolvable: CommandResult<bool> =
        Err("niri: compact geometry unresolvable; hidden for retry".to_owned());
    let deadline: CommandResult<bool> =
        Err("niri: restore deadline exceeded; hidden for retry".to_owned());
    for panel in [
        floating(Some((90.0, 205.0)), (0, 0)),
        floating(Some((90.0, 205.0)), (-420, 640)),
        floating(Some((90.0, 205.0)), (420, 640)),
    ] {
        for output in [Some("DP-1"), None, Some("HDMI-1")] {
            let plan = plan_compact_restore(Some(&saved), &panel, output);
            if plan.is_none() {
                // This branch is the production `Err` path: cancel, never reveal.
                assert_eq!(plan_restore_completion(&unresolvable, true), RestoreCompletion::Cancel);
                assert_eq!(plan_restore_completion(&deadline, true), RestoreCompletion::Cancel);
                assert!(!settled_reveal_eligible(false, 5, 5, Some(5)), "output={output:?}");
            }
        }
    }
    assert_eq!(plan_compact_restore(None, &floating(Some((90.0, 205.0)), (420, 640)), Some("DP-1")), None);
    // Stale/no-socket `Ok(false)`: cancel only while still owning a fresh
    // gate, else silent — never a reveal. A fresh compact job without
    // an anchor instead returns an explicit error before any IPC;
    // bootstrap/collapse remain blocked on base calibration.
    let no_spot: CommandResult<bool> = Ok(false);
    assert_eq!(plan_restore_completion(&no_spot, true), RestoreCompletion::Cancel);
    assert_eq!(plan_restore_completion(&no_spot, false), RestoreCompletion::Silent);
    assert!(!settled_reveal_eligible(false, 5, 5, Some(5)));
}

#[cfg(target_os = "linux")]
#[test]
fn hidden_initial_anchor_reveals_only_after_settle() {
    // Unit fix routing for the newly gated hidden-no-spot show, through
    // the real production shapes: only a worker-confirmed `Ok(true)`
    // with a fresh held gate may reveal; the no-spot `Ok(false)` and
    // every `Err` cancel or stay silent, never reveal at the anchor.
    let settled: CommandResult<bool> = Ok(true);
    assert_eq!(plan_restore_completion(&settled, true), RestoreCompletion::Reveal);
    assert!(settled_reveal_eligible(true, 7, 7, Some(7)));
    let no_spot: CommandResult<bool> = Ok(false);
    assert_eq!(plan_restore_completion(&no_spot, true), RestoreCompletion::Cancel);
    assert_eq!(plan_restore_completion(&no_spot, false), RestoreCompletion::Silent);
    assert!(!settled_reveal_eligible(false, 7, 7, Some(7)));
    let deadline: CommandResult<bool> =
        Err("niri: restore deadline exceeded; hidden for retry".to_owned());
    assert_eq!(plan_restore_completion(&deadline, true), RestoreCompletion::Cancel);
    assert_eq!(plan_restore_completion(&deadline, false), RestoreCompletion::Cancel);
}

#[cfg(target_os = "linux")]
#[test]
fn hidden_no_spot_reveals_only_after_default_settle() {
    // Live FAIL mv347ejs leg (1): hidden-no-spot must reveal at the
    // verified default anchor once settled — first sighting arms, second
    // equal sighting settles and routes to reveal; a moving frame keeps
    // waiting (bounded by the worker deadline, never a permanent cancel).
    use crate::niri::{default_anchor_settled, default_anchor_valid, PanelWindow};
    let panel = PanelWindow { id: 28, floating: true, size: (420, 640), pos: Some((90.0, 205.0)), workspace: Some(7) };
    assert!(default_anchor_valid(&panel));
    assert!(!default_anchor_settled(None, (90.0, 205.0)));
    assert!(default_anchor_settled(Some((90.0, 205.0)), (90.0, 205.0)));
    let settled: CommandResult<bool> = Ok(true);
    assert_eq!(plan_restore_completion(&settled, true), RestoreCompletion::Reveal);
    assert!(settled_reveal_eligible(true, 9, 9, Some(9)));
    // A moving default frame is not settled: no reveal yet.
    assert!(!default_anchor_settled(Some((91.0, 205.0)), (90.0, 205.0)));
    assert!(!settled_reveal_eligible(false, 9, 9, Some(9)));
}

#[cfg(target_os = "linux")]
#[test]
fn missing_window_deadline_never_unmaps_a_stale_show() {
    // Live FAIL mv347ejs leg (3): job3 outlived panel id28 to the
    // deadline. A stale generation must plan NOTHING — no unmap of a
    // newer show, no dialog-shaped window — while a fresh deadline still
    // routes to the guarded cancel (hide+reset, no focus/emit, Err).
    assert_eq!(plan_gate_effects(4, 3, true), Vec::<GateEffect>::new());
    assert_eq!(
        plan_gate_effects(3, 3, true),
        vec![GateEffect::Unmap, GateEffect::ResetVisuals]
    );
    let deadline: CommandResult<bool> =
        Err("niri: restore deadline exceeded; hidden for retry".to_owned());
    assert_eq!(plan_restore_completion(&deadline, true), RestoreCompletion::Cancel);
    assert_eq!(plan_restore_completion(&deadline, false), RestoreCompletion::Cancel);
    assert!(!crate::niri::missing_window_should_retry(
        NATIVE_RESTORE_JOB,
        NATIVE_RESTORE_JOB,
        0
    ));
    assert!(!crate::niri::missing_window_should_retry(
        Duration::ZERO,
        NATIVE_RESTORE_JOB,
        crate::niri::MISSING_WINDOW_MAX_PASSES
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn niri_recovery_never_hides_show_behind_calibration() {
    assert!(!native_recovery_show_gated());
}

#[cfg(target_os = "linux")]
#[test]
fn niri_shared_surface_uses_one_niri_only_policy() {
    assert!(shared_surface_available(), "verified native sizing enables the shared candidate");
    assert!(shared_route_wanted(shared_surface_available(),false,true,true));
    assert!(!shared_route_wanted(shared_surface_available(),true,true,true));
    assert!(!shared_route_wanted(shared_surface_available(),false,false,true));
    assert!(!shared_route_wanted(shared_surface_available(),false,true,false));
    assert!(native_niri_mode(false,true,true), "Niri integration must remain enabled");
}

#[cfg(target_os = "linux")]
#[test]
fn shared_unit_seam_tests() {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    use crate::niri::unit_surface::{shape_for, ShapeKind, UnitMode};
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::io;
    // Mode: closed stored-full reads RoseOnly; open pairs / stands alone.
    assert_eq!(shared_restore_mode(true, false, true), R::Fullscreen);
    assert_eq!(shared_restore_mode(true, false, false), R::Pair);
    assert_eq!(shared_restore_mode(true, true, false), R::PanelOnly);
    assert_eq!(shared_restore_mode(false, false, true), R::RoseOnly);
    assert_eq!(shared_restore_mode(false, true, true), R::RoseOnly);
    assert_eq!(shared_surface_mode(R::Pair), Some(UnitMode::Pair));
    assert_eq!(shared_surface_mode(R::Fullscreen), Some(UnitMode::Fullscreen));
    // Shape contract: empty while covered (even fullscreen); revealed
    // fullscreen is Full, revealed pair is the compact region.
    assert_eq!(shape_for(UnitMode::Pair, false, true), ShapeKind::Empty);
    assert_eq!(shape_for(UnitMode::Fullscreen, false, true), ShapeKind::Empty);
    assert_eq!(shape_for(UnitMode::Fullscreen, false, false), ShapeKind::Full);
    assert!(matches!(shape_for(UnitMode::Pair, false, false), ShapeKind::Region(_)));
    // Route gate: explicit activation AND Niri only; dormant FALSE never routes.
    assert!(shared_route_wanted(true, false, true, true));
    assert!(!shared_route_wanted(false, false, true, true));
    assert!(!shared_route_wanted(true, true, true, true));
    assert!(!shared_route_wanted(true, false, false, true));
    assert!(!shared_route_wanted(true, false, true, false));
    // Scripted compositor: probes move the exact PANEL id only (id 9).
    // Models the live Niri frame: the shared window maps at the 200x200
    // GTK content size while non-resizable, and while the window stays
    // mapped the requested size never lands no matter how often it is
    // re-requested — it only adopts the queued size on remap
    // (hide+show). Code that never remaps spins stale and fails honest.
    struct Fake {
        pos: Cell<(f64, f64)>,
        handled: bool,
        drift: bool,
        floating: Cell<bool>,
        released: Cell<bool>,
        pending: Cell<Option<(i32, i32)>>,
        mapped: Cell<bool>,
        remaps: Cell<usize>,
        seen: RefCell<Vec<(i32, i32)>>,
        window_size: Cell<(i32, i32)>,
        tile: Cell<(f64, f64)>,
        offset: Cell<(f64, f64)>,
        log: RefCell<Vec<Value>>,
    }
    impl Fake {
        fn live() -> Self {
            Self { pos: Cell::new((200.0, 100.0)), handled: true, drift: false, floating: Cell::new(true), released: Cell::new(false), pending: Cell::new(None), mapped: Cell::new(true), remaps: Cell::new(0), seen: RefCell::new(vec![]), window_size: Cell::new((200, 200)), tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)), log: RefCell::new(vec![]) }
        }
        fn adopt(&self, size: (i32, i32)) {
            match size {
                (420, 640) => { self.window_size.set((420, 640)); self.tile.set((420.5, 640.5)); self.offset.set((0.0, 0.0)); }
                (500, 640) => { self.window_size.set((500, 640)); self.tile.set((508.0, 648.0)); self.offset.set((4.0, 4.0)); }
                (72, 72) => { self.window_size.set((72, 72)); self.tile.set((80.0, 80.0)); self.offset.set((4.0, 4.0)); }
                _ => {}
            }
        }
        /// Scripted GTK+compositor resize: panics while pinned (sizing
        /// before release would silently keep the old frame); queues the
        /// request but never lands while mapped — only a remap adopts it.
        fn land(&self, size: (i32, i32)) {
            assert!(self.released.get(), "GTK clamps set_size while min=max is pinned");
            if !self.seen.borrow().contains(&size) {
                self.seen.borrow_mut().push(size);
            }
            self.pending.set(Some(size));
        }
        /// Immediate landing for sub-cases isolating a later step
        /// (render-ack, drift) from the remap the happy path covers.
        fn land_now(&self, size: (i32, i32)) {
            assert!(self.released.get(), "GTK clamps set_size while min=max is pinned");
            if !self.seen.borrow().contains(&size) {
                self.seen.borrow_mut().push(size);
            }
            self.pending.set(Some(size));
            self.adopt(size);
        }
        fn hide(&self) -> bool {
            self.mapped.set(false);
            true
        }
        fn show(&self) -> bool {
            self.mapped.set(true);
            self.remaps.set(self.remaps.get() + 1);
            if let Some(size) = self.pending.get() {
                self.adopt(size);
            }
            true
        }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(asked.clone());
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                let ws = if self.drift { 8 } else { 7 };
                let (px, py) = self.pos.get();
                let (sw, sh) = self.window_size.get();
                let (tw, th) = self.tile.get();
                let (ox, oy) = self.offset.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": ws, "is_floating": self.floating.get(),
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    {"id": 5, "pid": 42, "title": crate::platform::DOT_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [72, 72], "tile_size": [72.0, 72.0], "tile_pos_in_workspace_view": [300.0, 100.0]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}, {"id": 8, "output": "HDMI-1"}]}));
            }
            if asked == json!("Outputs") {
                return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1", "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
            }
            if asked == json!("Layers") {
                return Ok(json!({"Layers": []}));
            }
            if asked["Action"]["MoveWindowToFloating"]["id"] == json!(9) {
                if !self.handled {
                    return Ok(json!({"unexpected": "ok"}));
                }
                self.floating.set(true);
                return Ok(json!("Handled"));
            }
            for label in ["SetWindowWidth", "SetWindowHeight"] {
                if let Some(change) = asked["Action"].get(label) {
                    assert_eq!(change["id"],9);
                    assert!(change["change"]["SetFixed"].as_i64().is_some_and(|v| v > 0));
                    // An ACK alone does not commit a scripted stale buffer.
                    return Ok(if self.handled { json!("Handled") } else { json!({"unexpected":"ok"}) });
                }
            }
            let mover = &asked["Action"]["MoveFloatingWindow"];
            assert_eq!(mover["id"], 9, "shared route moves the exact PANEL id, never the DOT");
            if !self.handled {
                return Ok(json!({"unexpected": "ok"}));
            }
            if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                let (x, y) = self.pos.get();
                self.pos.set((x + dx as f64, y + dy as f64));
            } else {
                let axis = |v: &Value, origin: f64, extent: f64| if let Some(fixed) = v["SetFixed"].as_f64() { origin + fixed } else { origin + extent - 75.0 };
                self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
            }
            Ok(json!("Handled"))
        }
        fn moved_ids(&self) -> Vec<u64> {
            self.log.borrow().iter().filter_map(|w| w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64)).collect()
        }
    }
    fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
        crate::niri::CompactSpot { output: "DP-1".into(), x, y }
    }
    // cover -> release -> 420 -> prepare -> mode-resize -> finish -> render-ack -> reveal.
    // The 200x200 start proves the unmapped apply: each size is queued
    // while unmapped and adopted on show, so the settle observes it
    // without retries. A regression that only re-requests while mapped
    // The mapped mode resize commits without replacing the prepared id.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |size: (i32, i32)| {
        if fake.mapped.get() { fake.land_now(size); } else { fake.land(size); }
        true
    };
    let mut hide = || fake.hide();
    let mut show = || fake.show();
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(steps, vec!["cover", "release", "420", "prepare", "mode-resize", "finish", "animate-settle", "render-ack", "reveal"]);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert!(!fake.moved_ids().is_empty() && fake.moved_ids().iter().all(|id| *id == 9));
    // Mapped-only (S26): the mode resize preserves the mapping; no
    // calibration remap ever runs.
    assert_eq!(fake.window_size.get(), (500, 640));
    assert_eq!(fake.seen.borrow().as_slice(), [(420, 640), (500, 640)]);
    assert_eq!(fake.remaps.get(), 0, "mapped-only: no unmap/remap step");
    // A compositor that never commits fails honest and moves nothing:
    // budget exhausted names the stall instead of faking a reveal.
    // Mapped-only: no remap fallback exists; the settle cancels honest.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |_: (i32, i32)| { assert!(fake.released.get()); true };
    let mut hide = || true;
    let mut show = || true;
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_millis(150), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit size unsettled"));
    assert_eq!(steps, vec!["cover", "release", "420"]);
    assert!(fake.moved_ids().is_empty());
    // Re-requests that never land expire instead of revealing stale:
    // mapped-only settle cancels honest with no remap fallback.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |size: (i32, i32)| { fake.land(size); true };
    let mut hide = || true;
    let mut show = || true;
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_millis(400), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit size unsettled"));
    assert_eq!(fake.window_size.get(), (200, 200));
    assert!(fake.moved_ids().is_empty());
    // Mapped-only (S26): no remap ever runs, so the Niri window id is
    // stable across the whole transition. This fixture keeps the
    // fixed-id geometry path above; any unmap would be a defect.
    let fake = Fake::live();
    let id = Cell::new(9_u64);
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |size| { fake.land_now(size); true };
    let mut hide = || fake.hide();
    let mut show = || { id.set(id.get() + 1); fake.show() };
    let mut request = |wire: &str, budget| {
        let asked: Value = serde_json::from_str(wire)?;
        if asked == json!("Windows") {
            let mut value = fake.request(wire, budget)?;
            value["Windows"][0]["id"] = json!(id.get());
            return Ok(value);
        }
        // Translate only the current exact-id action for this fixture.
        if let Some(action_id) = asked.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64) {
            assert_eq!(action_id, id.get(), "never move a previous mapping");
            let mut translated = asked.clone();
            translated["Action"]["MoveFloatingWindow"]["id"] = json!(9);
            return fake.request(&translated.to_string(), budget);
        }
        fake.request(wire, budget)
    };
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))),
        "prepare and finish must observe the same mapping");
    assert_eq!(id.get(), 9, "mapped-only: no remap replaces the validated id");

    // Fixed constraints are still pinned when the resize is asked: GTK would
    // clamp the size to the old frame and finish would refuse to move.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || false;
    let mut resize = |_: (i32, i32)| panic!("never size without releasing the pinned constraints");
    let mut hide = || true;
    let mut show = || panic!("never map after a failed release");
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit size release unacked"));
    assert_eq!(steps, vec!["cover", "release"]);
    assert!(fake.moved_ids().is_empty());
    // Absent render ack: geometry succeeded but nothing reveals.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |size: (i32, i32)| { fake.land_now(size); true };
    let mut hide = || fake.hide();
    let mut show = || fake.show();
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || false;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_millis(60), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit render ack absent"));
    assert_eq!(*steps.last().unwrap(), "render-ack");
    // Stale before reveal: silent, no visual effect, anchor untouched.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || true;
    let mut resize = |_: (i32, i32)| true;
    let mut hide = || true;
    let mut show = || true;
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || fake.log.borrow().len() > 4;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || fake.log.borrow().len() < 4, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Silent);
    // Output drift: remembered DP-1 vs fresh HDMI-1 fails closed with no commit.
    // The remap still lands 420 first, so this isolates the prepare gate.
    let fake = Fake { drift: true, ..Fake::live() };
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || { fake.released.set(true); true };
    let mut resize = |size: (i32, i32)| { fake.land(size); true };
    let mut hide = || fake.hide();
    let mut show = || fake.show();
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let kept = Some(anchor(100.0, 200.0));
    let outcome = run_shared_unit_sequence(42, kept.as_ref(), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert!(matches!(outcome, SharedOutcome::Cancelled(_)));
    assert_eq!(kept, Some(anchor(100.0, 200.0)));
    // Cover ack timeout fails closed with zero socket traffic.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || false;
    let mut release = || true;
    let mut resize = |_: (i32, i32)| true;
    let mut hide = || panic!("never remap after a failed cover");
    let mut show = || panic!("never remap after a failed cover");
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Pair, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit cover unacked"));
    assert_eq!(steps, vec!["cover"]);
    assert!(fake.log.borrow().is_empty());
    // Fullscreen roundtrip retains the anchor with zero moves.
    let fake = Fake::live();
    let mut steps = Vec::new();
    let mut cover = || true;
    let mut release = || panic!("fullscreen is managed: the compact release never runs");
    let mut resize = |_: (i32, i32)| panic!("fullscreen never resizes a client");
    let mut hide = || panic!("fullscreen never remaps a client");
    let mut show = || panic!("fullscreen never remaps a client");
    let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
    let mut ready = || true;
    let outcome = run_shared_unit_sequence(42, Some(&anchor(100.0, 200.0)), R::Fullscreen, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show, &mut request, &mut ready, &mut steps);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert!(fake.moved_ids().is_empty());
    // Drag: restore returns preserved `remembered`; only this commit writes.
    let compact = Mutex::new(None);
    let gate: Mutex<Option<u64>> = Mutex::new(None);
    let epoch = AtomicU64::new(7);
    assert!(commit_dragged_anchor(&compact, &gate, &epoch, 7, Some(anchor(1.0, 2.0))));
    assert_eq!(*compact.lock().unwrap(), Some(anchor(1.0, 2.0)));
    assert!(!commit_dragged_anchor(&compact, &gate, &epoch, 6, Some(anchor(9.0, 9.0))));
    assert_eq!(*compact.lock().unwrap(), Some(anchor(1.0, 2.0)));
}

#[cfg(target_os = "linux")]
#[test]
fn shared_runtime_adapter_shares_the_tested_sequence() {
    use crate::niri::unit_restore::UnitRestoreMode as R;
    use crate::niri::unit_surface::UnitMode;
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::io;
    fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
        crate::niri::CompactSpot { output: "DP-1".into(), x, y }
    }
    struct Sock {
        pos: Cell<(f64, f64)>,
        drift: bool,
        floating: Cell<bool>,
        float_fail: Cell<u8>,
        size: Cell<(i32, i32)>,
        tile: Cell<(f64, f64)>,
        offset: Cell<(f64, f64)>,
        log: RefCell<Vec<Value>>,
        /// GTK reports min=max while the window is non-resizable (how the
        /// shared surface is built and how reveal leaves it), so `set_size`
        /// is clamped to the current frame: this fake reports the same size.
        /// The frame maps at the 200x200 content size, and while mapped
        /// a resize never lands — only a remap (hide+show) adopts the
        /// queued size, mirroring live Niri.
        pinned: Cell<bool>,
        pending: Cell<Option<(i32, i32)>>,
        remaps: Cell<usize>,
        /// When false the compositor never commits a resize, even on
        /// remap: the settle must fail honest instead of revealing stale.
        land: Cell<bool>,
    }
    impl Sock {
        fn live() -> Self {
            Self { pos: Cell::new((200.0, 100.0)), drift: false, floating: Cell::new(true), float_fail: Cell::new(0), size: Cell::new((200, 200)), tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)), log: RefCell::new(vec![]), pinned: Cell::new(true), pending: Cell::new(None), remaps: Cell::new(0), land: Cell::new(true) }
        }
        fn adopt(&self, size: (i32, i32)) {
            if !self.land.get() {
                return;
            }
            if size == (420, 640) {
                self.size.set((420, 640));
                self.tile.set((420.5, 640.5));
                self.offset.set((0.0, 0.0));
            }
            if size == (500, 640) {
                self.size.set((500, 640));
                self.tile.set((508.0, 648.0));
                self.offset.set((4.0, 4.0));
            }
            if size == (72, 72) {
                self.size.set((72, 72));
                self.tile.set((80.0, 80.0));
                self.offset.set((4.0, 4.0));
            }
        }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(asked.clone());
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                let ws = if self.drift { 8 } else { 7 };
                let (px, py) = self.pos.get();
                let (sw, sh) = self.size.get();
                let (tw, th) = self.tile.get();
                let (ox, oy) = self.offset.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": ws, "is_floating": self.floating.get(),
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                    {"id": 5, "pid": 42, "title": crate::platform::DOT_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [72, 72], "tile_size": [72.0, 72.0], "tile_pos_in_workspace_view": [300.0, 100.0]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}, {"id": 8, "output": "HDMI-1"}]}));
            }
            if asked == json!("Outputs") {
                return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1", "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
            }
            if asked == json!("Layers") {
                return Ok(json!({"Layers": []}));
            }
            if asked["Action"]["MoveWindowToFloating"]["id"] == json!(9) {
                // 0 floats, 1 replies unhandled, 2 acks without motion.
                if self.float_fail.get() == 1 {
                    return Ok(json!({"unexpected": "ok"}));
                }
                if self.float_fail.get() == 0 {
                    self.floating.set(true);
                }
                return Ok(json!("Handled"));
            }
            for label in ["SetWindowWidth", "SetWindowHeight"] {
                if let Some(change) = asked["Action"].get(label) {
                    assert_eq!(change["id"],9);
                    assert!(change["change"]["SetFixed"].as_i64().is_some_and(|v| v > 0));
                    // Preserve the stale-buffer/remap cases, including land=false.
                    return Ok(json!("Handled"));
                }
            }
            let mover = &asked["Action"]["MoveFloatingWindow"];
            assert_eq!(mover["id"], 9, "runtime adapter moves the exact PANEL id only");
            if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                let (x, y) = self.pos.get();
                self.pos.set((x + dx as f64, y + dy as f64));
            } else {
                let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
            }
            Ok(json!("Handled"))
        }
        fn moved_ids(&self) -> Vec<u64> {
            self.log.borrow().iter().filter_map(|w| w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64)).collect()
        }
    }
    struct Ops<'a> {
        sock: &'a Sock,
        calls: RefCell<Vec<&'static str>>,
        resizes: RefCell<Vec<(i32, i32)>>,
        commits: RefCell<Vec<Option<crate::niri::CompactSpot>>>,
        reveals: RefCell<Vec<(UnitMode, bool)>>,
        cancels: RefCell<Vec<&'static str>>,
        cover_ack: Cell<bool>,
    }
    impl<'a> SharedUnitOps for Ops<'a> {
        fn cover(&self) -> bool {
            self.calls.borrow_mut().push("cover");
            self.cover_ack.get()
        }
        fn resize(&self, size: (i32, i32)) -> bool {
            self.calls.borrow_mut().push("resize");
            self.resizes.borrow_mut().push(size);
            assert!(!self.sock.pinned.get(), "GTK clamps set_size while min=max is pinned: {size:?}");
            // Queue only: the next compositor sample commits it,
            // without needing a new mapping after preparation.
            self.sock.pending.set(Some(size));
            true
        }
        fn hide(&self) -> bool {
            self.calls.borrow_mut().push("hide");
            true
        }
        fn show(&self) -> bool {
            self.calls.borrow_mut().push("show");
            self.sock.remaps.set(self.sock.remaps.get() + 1);
            if let Some(size) = self.sock.pending.get() {
                self.sock.adopt(size);
            }
            true
        }
        fn set_resizable(&self, on: bool) -> bool {
            self.calls.borrow_mut().push(if on { "resizable-true" } else { "resizable-false" });
            self.sock.pinned.set(!on);
            true
        }
        fn request(&self, wire: &str, timeout: Duration) -> io::Result<Value> {
            if wire == crate::niri::WINDOWS_REQUEST {
                if let Some(size) = self.sock.pending.get() {
                    self.sock.adopt(size);
                }
            }
            self.sock.request(wire, timeout)
        }
        fn render_ready(&self) -> bool {
            true
        }
        fn commit(&self, spot: Option<crate::niri::CompactSpot>) {
            self.commits.borrow_mut().push(spot);
        }
        fn reveal(&self, mode: UnitMode, open: bool) {
            self.reveals.borrow_mut().push((mode, open));
            // The real reveal re-pins the landed size; the next compact job
            // must release it again before sizing.
            self.sock.pinned.set(true);
        }
        fn cancel(&self, reason: &'static str) {
            self.cancels.borrow_mut().push(reason);
        }
        fn managed_fullscreen(&self, pid: u32) -> bool {
            self.calls.borrow_mut().push("managed");
            let windows = self.request(crate::niri::WINDOWS_REQUEST, Duration::from_millis(50)).unwrap();
            assert!(crate::niri::own_panel_window(&windows, pid).is_some());
            assert!(self.sock.moved_ids().is_empty());
            self.sock.floating.set(false);
            true
        }
    }
    // Pair happy path: same order as the seam, plus commit + focused reveal.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(steps, vec!["cover", "release", "420", "prepare", "mode-resize", "finish", "animate-settle", "render-ack", "reveal"]);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(100.0, 200.0))]);
    assert_eq!(*ops.reveals.borrow(), vec![(UnitMode::Pair, true)]);
    // Each size is applied mapped via apply_size_policy and observed on
    // re-query: one ask per phase, no stale retry loop, no remap.
    assert_eq!(*ops.resizes.borrow(), vec![(420, 640), (500, 640)]);
    // The release precedes every sizing pass: the pinned window (built
    // non-resizable, re-pinned by the previous reveal) clamps set_size.
    // Mapped-only (S26): no hide/show calls anywhere.
    assert_eq!(ops.calls.borrow().as_slice(), ["cover", "resizable-true", "resize", "resize"]);
    assert!(!sock.moved_ids().is_empty() && sock.moved_ids().iter().all(|id| *id == 9));
    assert!(ops.cancels.borrow().is_empty());
    // Unsettled size: the compositor never commits, so the job cancels
    // honest with no move, no commit, and no reveal of a stale frame.
    let sock = Sock::live();
    sock.land.set(false);
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_millis(150), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit size unsettled"));
    assert_eq!(steps, vec!["cover", "release", "420"]);
    assert_eq!(*ops.cancels.borrow(), vec!["unit size unsettled"]);
    assert!(ops.commits.borrow().is_empty() && ops.reveals.borrow().is_empty() && sock.moved_ids().is_empty());
    // Cover nack: exact-owned cancel, zero socket traffic, no commit/reveal.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(false) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit cover unacked"));
    assert_eq!(*ops.cancels.borrow(), vec!["unit cover unacked"]);
    assert!(sock.log.borrow().is_empty() && ops.commits.borrow().is_empty() && ops.reveals.borrow().is_empty());
    // Stale mid-job: silent with zero commit/reveal/cancel effects.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let seen = Cell::new(0);
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || { seen.set(seen.get() + 1); seen.get() < 4 }, &mut steps);
    assert_eq!(outcome, SharedOutcome::Silent);
    assert!(ops.commits.borrow().is_empty() && ops.reveals.borrow().is_empty() && ops.cancels.borrow().is_empty());
    // Fullscreen: managed exact-id path, anchor retained, zero resizes/moves.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Fullscreen, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(steps[0], "managed");
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(100.0, 200.0))]);
    assert_eq!(*ops.reveals.borrow(), vec![(UnitMode::Fullscreen, true)]);
    assert!(ops.resizes.borrow().is_empty() && sock.moved_ids().is_empty());
    // Both-hidden close stays mapped covered: commit, no reveal.
    // keep_mapped is always true in production (unit_window_for); the
    // worker owns the covered end.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::RoseOnly, true, false, true, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(100.0, 200.0))]);
    assert!(ops.reveals.borrow().is_empty(), "close stays covered, never revealed");
    assert!(steps.iter().any(|s| *s == "covered"), "close ends covered: {steps:?}");
    assert!(!steps.iter().any(|s| *s == "reveal"), "close never reveals: {steps:?}");
    // Bootstrap: finish recomputes the base with the actual 508 tile (772,
    // not the 780 client estimate) and that prepared anchor commits.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, None, R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(772.0, 42.0))));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(772.0, 42.0))]);
    // B1: a tiled panel must refloat its exact id before prepare/420
    // readiness instead of timing out polling for floating.
    let sock = Sock::live();
    sock.floating.set(false);
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_millis(400), || true, &mut steps);
    assert_eq!(steps, vec!["cover", "float", "release", "420", "prepare", "mode-resize", "finish", "animate-settle", "render-ack", "reveal"]);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    let log = sock.log.borrow();
    assert_eq!(log[0], json!("Windows"));
    assert_eq!(log[1]["Action"]["MoveWindowToFloating"]["id"], json!(9));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(100.0, 200.0))]);
    // Rejected refloat: no resize, probe, or reveal; exact-owned cancel.
    let sock = Sock::live();
    sock.floating.set(false);
    sock.float_fail.set(1);
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit refloat rejected"));
    assert_eq!(steps, vec!["cover", "float"]);
    assert_eq!(*ops.cancels.borrow(), vec!["unit refloat rejected"]);
    assert!(ops.resizes.borrow().is_empty() && ops.commits.borrow().is_empty() && ops.reveals.borrow().is_empty());
    // Handled without motion: the requery must still fail, never reveal.
    let sock = Sock::live();
    sock.floating.set(false);
    sock.float_fail.set(2);
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Cancelled("unit refloat unverified"));
    assert_eq!(*ops.cancels.borrow(), vec!["unit refloat unverified"]);
    assert!(ops.reveals.borrow().is_empty());
    // B1 tiled→both-hidden close: 72 client completes with tile+offset
    // aligned origin, then stays covered — commit, no reveal.
    let sock = Sock::live();
    sock.floating.set(false);
    sock.tile.set((428.0, 648.0));
    sock.offset.set((4.0, 4.0));
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::RoseOnly, true, false, true, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(steps, vec!["cover", "float", "release", "420", "prepare", "mode-resize", "finish", "covered"]);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert_eq!(*ops.resizes.borrow(), vec![(420, 640), (72, 72)]);
    assert!(ops.reveals.borrow().is_empty(), "close stays covered, never revealed");
    assert!(sock.moved_ids().iter().all(|id| *id == 9));
    // Full→compact roundtrip: managed fullscreen tiles, the Pair return
    // refloats the exact id and retains the remembered anchor.
    let sock = Sock::live();
    let ops = Ops { sock: &sock, calls: RefCell::new(vec![]), resizes: RefCell::new(vec![]), commits: RefCell::new(vec![]), reveals: RefCell::new(vec![]), cancels: RefCell::new(vec![]), cover_ack: Cell::new(true) };
    let mut steps = Vec::new();
    let full = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Fullscreen, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(full, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert!(!sock.floating.get());
    let mut steps = Vec::new();
    let back = drive_shared_unit_job(&ops, 42, Some(&anchor(100.0, 200.0)), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(steps, vec!["cover", "float", "release", "420", "prepare", "mode-resize", "finish", "animate-settle", "render-ack", "reveal"]);
    assert_eq!(back, SharedOutcome::Revealed(Some(anchor(100.0, 200.0))));
    assert_eq!(*ops.commits.borrow(), vec![Some(anchor(100.0, 200.0)), Some(anchor(100.0, 200.0))]);
}

#[cfg(target_os = "linux")]
#[test]
fn shared_activation_is_last_and_gated() {
    use crate::niri::unit_surface::UnitMode;
    // Builder config: single surface only on Niri-with-socket; every other
    // backend keeps its own windows.
    assert!(native_niri_mode(false, true, true));
    assert!(!native_niri_mode(true, true, true));
    assert!(!native_niri_mode(false, false, true));
    assert!(!native_niri_mode(false, true, false));
    // Startup map: fresh process, chat closed — RoseOnly sized and
    // mapped either way (S26: the ONE toplevel stays mapped; a
    // hidden-rose close ends covered at opacity 0, never unmapped).
    let shown = plan_shared_startup(false);
    assert_eq!(shown.size, (72, 72));
    assert!(shown.map);
    let parked = plan_shared_startup(true);
    assert_eq!(parked.size, (72, 72));
    assert!(parked.map, "hidden-rose startup stays mapped covered, never unmapped");
    assert_eq!(crate::niri::unit_surface::mode_size(UnitMode::RoseOnly), Some(shown.size));
    // Activation: any unreadiness leaves FALSE with zero effects.
    fn activate(worker: bool, follow: bool, window: bool, socket: bool) -> (bool, bool) {
        let gate = Mutex::new(None);
        let unit = Mutex::new(NiriUnitState::dormant());
        let epoch = AtomicU64::new(0);
        let on = activate_shared_unit(&gate, &unit, &epoch, false, true, socket, worker, follow, window);
        let active = unit.lock().unwrap().active;
        (on, active)
    }
    assert_eq!(activate(false, true, true, true), (false, false));
    assert_eq!(activate(true, false, true, true), (false, false));
    assert_eq!(activate(true, true, false, true), (false, false));
    assert_eq!(activate(true, true, true, false), (false, false));
    assert_eq!(activate(true, true, true, true), (true, true));
    // Follow suppression rides the same active+Niri gate as the worker.
    assert!(shared_route_wanted(true, false, true, true));
    assert!(!shared_route_wanted(false, false, true, true));
    assert!(!shared_route_wanted(true, false, true, false));
}

#[cfg(target_os = "linux")]
#[test]
fn shared_close_reveals_rose_unless_both_hidden() {
    // Corrected close semantics: with the rose wanted
    // (rose_hidden=false) a close reveals the 72x72 rose-only surface —
    // rose click, Alt+Space, and the panel Hide button all close ONLY
    // the chat and never flip the saved rose preference. Only
    // open=false AND rose_hidden=true (nothing left to show) ends
    // covered.
    use crate::niri::unit_restore::UnitRestoreMode as R;
    use crate::niri::unit_surface::UnitMode;
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::io;
    fn anchor() -> crate::niri::CompactSpot {
        crate::niri::CompactSpot { output: "DP-1".into(), x: 100.0, y: 200.0 }
    }
    struct Ops {
        reveals: RefCell<Vec<(UnitMode, bool)>>,
        size: Cell<(i32, i32)>,
        pos: Cell<(f64, f64)>,
    }
    impl Ops {
        fn tile(&self) -> (f64, f64) {
            match self.size.get() {
                (420, 640) => (420.5, 640.5),
                (500, 640) => (508.0, 648.0),
                (72, 72) => (80.0, 80.0),
                (w, h) => (w as f64, h as f64),
            }
        }
    }
    impl SharedUnitOps for Ops {
        fn cover(&self) -> bool { true }
        fn resize(&self, size: (i32, i32)) -> bool { self.size.set(size); true }
        fn set_resizable(&self, _: bool) -> bool { true }
        fn hide(&self) -> bool { panic!("S26: close must not unmap") }
        fn show(&self) -> bool { panic!("S26: close must not remap") }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                let (sw, sh) = self.size.get();
                let (tw, th) = self.tile();
                let oy = if (sw, sh) == (420, 640) { 0.0 } else { 4.0 };
                let ox = if (sw, sh) == (420, 640) { 0.0 } else { 4.0 };
                let (px, py) = self.pos.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
            }
            if asked == json!("Outputs") {
                return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1", "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
            }
            if asked == json!("Layers") {
                return Ok(json!({"Layers": []}));
            }
            for label in ["SetWindowWidth", "SetWindowHeight"] {
                if let Some(change) = asked["Action"].get(label) {
                    if let Some(v) = change["change"]["SetFixed"].as_i64() {
                        let (w, h) = self.size.get();
                        let next = if label == "SetWindowWidth" { (v as i32, h) } else { (w, v as i32) };
                        self.size.set(next);
                    }
                    return Ok(json!("Handled")); }
            }
            if asked.get("Action").is_some() {
                let mover = &asked["Action"]["MoveFloatingWindow"];
                if mover.is_object() {
                    assert_eq!(mover["id"], 9);
                    if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                        let (x, y) = self.pos.get();
                        self.pos.set((x + dx as f64, y + dy as f64));
                    } else {
                        let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                        self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
                    }
                    return Ok(json!("Handled"));
                }
                return Ok(json!("Handled"));
            }
            Ok(json!("Handled"))
        }
        fn render_ready(&self) -> bool { true }
        fn commit(&self, _: Option<crate::niri::CompactSpot>) {}
        fn reveal(&self, mode: UnitMode, open: bool) { self.reveals.borrow_mut().push((mode, open)); }
        fn cancel(&self, _: &'static str) {}
        fn managed_fullscreen(&self, _: u32) -> bool { unreachable!() }
    }
    assert_eq!(
        crate::niri::unit_restore::surface_size(R::RoseOnly),
        Some((72, 72)),
        "the revealed close surface is the 72x72 rose"
    );
    // Rose wanted: render-ack + reveal, never "covered".
    let ops = Ops { reveals: RefCell::new(vec![]), size: Cell::new((500, 640)), pos: Cell::new((200.0, 100.0)) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor()), R::RoseOnly, true, false, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert!(matches!(outcome, SharedOutcome::Revealed(_)));
    assert_eq!(*ops.reveals.borrow(), vec![(UnitMode::RoseOnly, false)], "close reveals the rose-only surface");
    assert!(steps.iter().any(|s| *s == "reveal"), "rose-wanted close reveals: {steps:?}");
    assert!(!steps.iter().any(|s| *s == "covered"), "rose-wanted close never covers: {steps:?}");
    // Both hidden: covered commit, no reveal — the only covered close.
    let ops = Ops { reveals: RefCell::new(vec![]), size: Cell::new((500, 640)), pos: Cell::new((200.0, 100.0)) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&anchor()), R::RoseOnly, true, false, true, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert!(matches!(outcome, SharedOutcome::Revealed(_)));
    assert!(ops.reveals.borrow().is_empty(), "both-hidden close stays covered");
    assert!(steps.iter().any(|s| *s == "covered"), "both-hidden close ends covered: {steps:?}");
    assert!(!steps.iter().any(|s| *s == "reveal"), "both-hidden close never reveals: {steps:?}");
    assert!(shared_job_reveals(true, false), "open reveals with rose wanted");
    assert!(shared_job_reveals(true, true), "open reveals with rose hidden");
    assert!(shared_job_reveals(false, false), "close with rose wanted reveals the rose");
    assert!(!shared_job_reveals(false, true), "both-hidden close stays covered");
}

#[cfg(target_os = "linux")]
#[test]
fn shared_capture_guard_is_config_independent() {
    // S15/S26: the guard consults placement state only — no output
    // geometry. The same predicate holds on two synthetic outputs with
    // different margins.
    use crate::niri::CompactSpot;
    for (output, margin) in [("DP-1", 12.0), ("HDMI-1", 24.0)] {
        let placed = CompactSpot { output: output.to_owned(), x: 600.0 + margin, y: 244.0 + margin };
        // No commanded placement yet: every raw spot is refused, so a
        // compositor fresh-map base can never seed the anchor.
        let raw = CompactSpot { output: output.to_owned(), x: 600.0 + margin, y: 244.0 + margin };
        assert!(shared_capture_is_transient(None, &raw), "unplaced {output} refuses every raw spot");
        // Echo of our own last commanded placement: ignored, never a new anchor.
        assert!(shared_capture_is_transient(Some(&placed), &placed), "echo on {output} is not a capture");
        // Genuine displacement (user drag): capturable on every output.
        let dragged = CompactSpot { output: output.to_owned(), x: placed.x + 50.0, y: placed.y + 40.0 };
        assert!(!shared_capture_is_transient(Some(&placed), &dragged), "drag on {output} captures");
    }
    // Seam: with no remembered anchor a live floating window still
    // commits nothing — the base can never become the anchor.
    let shell = test_hide_shell(6, None);
    let pid = std::process::id();
    let windows = serde_json::json!({"Windows": [
        {"id": 9, "pid": pid, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
         "layout": {"window_size": [500, 640], "tile_pos_in_workspace_view": [2036.0, 56.0]}},
    ]});
    let workspaces = serde_json::json!({"Workspaces": [{"id": 7, "output": "DP-1"}]});
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire.contains("Windows") { Ok(windows.clone()) } else { Ok(workspaces.clone()) }
    };
    capture_shared_transition_anchor(&shell, 6, pid, true, true, 6, 6, &mut request);
    assert_eq!(*shell.native_compact.lock().unwrap(), None, "unplaced capture never seeds the anchor");
}

#[cfg(target_os = "linux")]
#[test]
fn shared_stale_strut_self_corrects_in_the_same_job() {
    // T10/S7: Outputs carries no struts, so the layout key stays
    // identical while the bar grows into the target. A cached hit must
    // detect the clamp from the OUTCOME, drop the stale entry, and
    // re-probe in the SAME job — never cancel on stale geometry forever.
    use crate::niri::unit_restore::{CachedCalibration, UnitRestoreMode as R};
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::io;
    fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
        crate::niri::CompactSpot { output: "DP-1".into(), x, y }
    }
    struct Fake {
        pos: Cell<(f64, f64)>,
        accept: Cell<bool>,
        size: Cell<(i32, i32)>,
        tile: Cell<(f64, f64)>,
        offset: Cell<(f64, f64)>,
        /// Probe-measured work-area origin (the strut inset). The
        /// Outputs reply deliberately ignores it: same key, new bar.
        origin: Cell<(f64, f64)>,
        /// When true the compositor clamps AdjustFixed moves into the
        /// live area, like Niri's keep-visible behaviour.
        clamp_moves: Cell<bool>,
        log: RefCell<Vec<Value>>,
    }
    impl Fake {
        fn live() -> Self {
            Self { pos: Cell::new((200.0, 100.0)), accept: Cell::new(true), size: Cell::new((200, 200)),
                tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)),
                origin: Cell::new((12.0, 30.0)), clamp_moves: Cell::new(false), log: RefCell::new(vec![]) }
        }
        fn adopt(&self, size: (i32, i32)) {
            match size {
                (420, 640) => { self.size.set((420, 640)); self.tile.set((420.5, 640.5)); self.offset.set((0.0, 0.0)); }
                (500, 640) => { self.size.set((500, 640)); self.tile.set((508.0, 648.0)); self.offset.set((4.0, 4.0)); }
                (72, 72) => { self.size.set((72, 72)); self.tile.set((80.0, 80.0)); self.offset.set((4.0, 4.0)); }
                _ => {}
            }
        }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(asked.clone());
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                let (px, py) = self.pos.get();
                let (sw, sh) = self.size.get();
                let (tw, th) = self.tile.get();
                let (ox, oy) = self.offset.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
            }
            if asked == json!("Outputs") {
                return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1",
                    "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
            }
            if asked == json!("Layers") {
                return Ok(json!({"Layers": []}));
            }
            let mover = &asked["Action"]["MoveFloatingWindow"];
            assert_eq!(mover["id"], 9, "stale-strut route moves the exact PANEL id only");
            if self.accept.get() {
                if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                    let (x, y) = self.pos.get();
                    let mut next = (x + dx as f64, y + dy as f64);
                    if self.clamp_moves.get() {
                        let (ox, oy) = self.origin.get();
                        let (w, h) = (f64::from(self.size.get().0), f64::from(self.size.get().1));
                        next.0 = next.0.clamp(ox + 12.0, ox + 1280.0 - 12.0 - w);
                        next.1 = next.1.clamp(oy + 12.0, oy + 1000.0 - 12.0 - h);
                    }
                    self.pos.set(next);
                } else {
                    let (ox, oy) = self.origin.get();
                    let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                    self.pos.set((axis(&mover["x"], ox, 1280.0), axis(&mover["y"], oy, 1000.0)));
                }
            }
            Ok(json!("Handled"))
        }
        fn probes(&self) -> usize {
            self.log.borrow().iter().filter(|w| {
                w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64) == Some(9)
                    && w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_none()
            }).count()
        }
    }
    fn run(fake: &Fake, spot: &crate::niri::CompactSpot, cached: Option<CachedCalibration>, fresh: &impl Fn() -> bool)
        -> (SharedOutcome, Vec<&'static str>, Option<CachedCalibration>, bool) {
        let mut steps = Vec::new();
        let mut cache_out = None;
        let mut cache_clear = false;
        let mut cover = || true;
        let mut release = || true;
        let mut resize = |size: (i32, i32)| { fake.adopt(size); true };
        let mut hide = || true;
        let mut show = || true;
        let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
        let mut ready = || true;
        let outcome = run_shared_unit_sequence_cached(42, Some(spot), R::Pair, false, 8, 12.0,
            Duration::from_secs(2), fresh, &mut cover, &mut release, &mut resize, &mut hide, &mut show,
            &mut request, &mut ready, &mut steps, cached, &mut cache_out, &mut cache_clear);
        (outcome, steps, cache_out, cache_clear)
    }
    let spot = anchor(100.0, 40.0);
    let fake = Fake::live();
    let (outcome, _, cache, _) = run(&fake, &spot, None, &|| true);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    // Stale area origin y=30: the planned target is inset to y=42.
    assert_eq!(fake.pos.get(), (100.0, 42.0));
    let cache = cache.expect("probe success fills the cache");
    assert_eq!(cache.area.origin, (12.0, 30.0));
    let probes = fake.probes();
    assert!(probes > 0);
    // Only the strut origin changes; the Outputs key is identical.
    // The window reopens at the compositor base, as after a remap.
    fake.origin.set((12.0, 74.0));
    fake.clamp_moves.set(true);
    fake.pos.set((2036.0, 56.0));
    let (outcome, steps, cache2, cleared) = run(&fake, &spot, Some(cache), &|| true);
    assert!(cleared, "clamp miss flags the stale entry for drop");
    // The stale plan aims at y=42 but the live area starts at y=86:
    // the job must miss, re-probe, and land on the correct target.
    assert!(steps.contains(&"cached"), "stale entry is tried first: {steps:?}");
    assert!(steps.contains(&"prepare"), "clamp miss re-probes in the same job: {steps:?}");
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    assert_eq!(fake.pos.get(), (100.0, 86.0));
    assert_eq!(fake.probes(), probes + 4, "exactly one bounded re-probe");
    assert_eq!(cache2.as_ref().expect("re-probe refreshes the cache").area.origin, (12.0, 74.0));
    // A stuck compositor must surface the probe failure, not the stale hit.
    fake.origin.set((12.0, 118.0));
    fake.accept.set(false);
    fake.pos.set((2036.0, 56.0));
    let (outcome, steps, cache3, cleared) = run(&fake, &spot, cache2, &|| true);
    assert!(cleared, "miss without refresh still flags the drop");
    assert!(steps.contains(&"prepare"), "miss still re-probes when stuck: {steps:?}");
    assert_eq!(outcome, SharedOutcome::Cancelled("unit prepare unresolvable"));
    assert!(cache3.is_none(), "failed re-probe stores nothing");
    // Drive level: the STORED entry itself is dropped after a miss that
    // cannot refresh, so the next job probes instead of reusing it.
    use crate::niri::unit_surface::UnitMode;
    struct Ops<'a> {
        sock: &'a Fake,
        stored: RefCell<Option<CachedCalibration>>,
        cleared: Cell<usize>,
        cancels: RefCell<Vec<&'static str>>,
    }
    impl<'a> SharedUnitOps for Ops<'a> {
        fn cover(&self) -> bool { true }
        fn resize(&self, size: (i32, i32)) -> bool { self.sock.adopt(size); true }
        fn set_resizable(&self, _on: bool) -> bool { true }
        fn hide(&self) -> bool { true }
        fn show(&self) -> bool { true }
        fn request(&self, wire: &str, timeout: Duration) -> io::Result<Value> {
            self.sock.request(wire, timeout)
        }
        fn render_ready(&self) -> bool { true }
        fn commit(&self, _spot: Option<crate::niri::CompactSpot>) {}
        fn cached(&self) -> Option<CachedCalibration> { self.stored.borrow().clone() }
        fn commit_cache(&self, cache: CachedCalibration) { *self.stored.borrow_mut() = Some(cache); }
        fn clear_cache(&self) {
            *self.stored.borrow_mut() = None;
            self.cleared.set(self.cleared.get() + 1);
        }
        fn reveal(&self, _mode: UnitMode, _open: bool) {}
        fn cancel(&self, reason: &'static str) { self.cancels.borrow_mut().push(reason); }
        fn managed_fullscreen(&self, _pid: u32) -> bool { true }
    }
    let drive_fake = Fake::live();
    let ops = Ops { sock: &drive_fake, stored: RefCell::new(None), cleared: Cell::new(0), cancels: RefCell::new(vec![]) };
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&spot), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    assert_eq!(ops.stored.borrow().as_ref().expect("drive commits the probe").area.origin, (12.0, 30.0));
    assert_eq!(ops.cleared.get(), 0, "success never clears");
    // The bar grows and the compositor sticks: miss, failed re-probe,
    // Cancelled — and the stored entry is gone.
    drive_fake.origin.set((12.0, 74.0));
    drive_fake.clamp_moves.set(true);
    drive_fake.accept.set(false);
    drive_fake.pos.set((2036.0, 56.0));
    let mut steps = Vec::new();
    let outcome = drive_shared_unit_job(&ops, 42, Some(&spot), R::Pair, true, true, false, 8, 12.0,
        Duration::from_secs(2), || true, &mut steps);
    assert!(steps.contains(&"cache-miss"), "drive re-probes after the miss: {steps:?}");
    assert_eq!(outcome, SharedOutcome::Cancelled("unit prepare unresolvable"));
    assert!(ops.stored.borrow().is_none(), "a Cancelled miss drops the stored entry");
    assert_eq!(ops.cleared.get(), 1, "exactly one generation-gated clear");
    assert_eq!(*ops.cancels.borrow(), vec!["unit prepare unresolvable"]);
}

#[cfg(target_os = "linux")]
#[test]
fn environment_layer_change_clears_cache_and_next_transition_reprobes() {
    // T10/S7 residual: a REMOVED bar leaves the old inset legal
    // (actual==planned, verification passes), so only the layer-set
    // change can drop the stale entry before it is reused.
    use crate::niri::unit_restore::{CachedCalibration, UnitRestoreMode as R};
    use serde_json::{json, Value};
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;
    fn anchor(x: f64, y: f64) -> crate::niri::CompactSpot {
        crate::niri::CompactSpot { output: "DP-1".into(), x, y }
    }
    fn bar_event() -> Value {
        json!({"Layers": [{"namespace": "bar", "output": "DP-1", "layer": "Top", "keyboard_interactivity": "None"}]})
    }
    struct Fake {
        pos: Cell<(f64, f64)>,
        size: Cell<(i32, i32)>,
        tile: Cell<(f64, f64)>,
        offset: Cell<(f64, f64)>,
        log: RefCell<Vec<Value>>,
    }
    impl Fake {
        fn live() -> Self {
            Self { pos: Cell::new((200.0, 100.0)), size: Cell::new((200, 200)),
                tile: Cell::new((200.0, 200.0)), offset: Cell::new((0.0, 0.0)), log: RefCell::new(vec![]) }
        }
        fn adopt(&self, size: (i32, i32)) {
            match size {
                (420, 640) => { self.size.set((420, 640)); self.tile.set((420.5, 640.5)); self.offset.set((0.0, 0.0)); }
                (500, 640) => { self.size.set((500, 640)); self.tile.set((508.0, 648.0)); self.offset.set((4.0, 4.0)); }
                _ => {}
            }
        }
        fn request(&self, wire: &str, _: Duration) -> io::Result<Value> {
            let asked: Value = serde_json::from_str(wire)?;
            self.log.borrow_mut().push(asked.clone());
            if asked == json!("Version") {
                return Ok(json!({"Version": "26.04 (test)"}));
            }
            if asked == json!("Windows") {
                let (px, py) = self.pos.get();
                let (sw, sh) = self.size.get();
                let (tw, th) = self.tile.get();
                let (ox, oy) = self.offset.get();
                return Ok(json!({"Windows": [
                    {"id": 9, "pid": 42, "title": crate::platform::PANEL_TITLE, "workspace_id": 7, "is_floating": true,
                     "layout": {"window_size": [sw, sh], "tile_size": [tw, th], "window_offset_in_tile": [ox, oy], "tile_pos_in_workspace_view": [px, py]}},
                ]}));
            }
            if asked == json!("Workspaces") {
                return Ok(json!({"Workspaces": [{"id": 7, "output": "DP-1"}]}));
            }
            if asked == json!("Outputs") {
                return Ok(json!({"Outputs": {"DP-1": {"name": "DP-1",
                    "logical": {"x": 0, "y": 0, "width": 2560, "height": 1440, "scale": 1.0, "transform": "Normal"}}}}));
            }
            if asked == json!("Layers") {
                return Ok(json!({"Layers": []}));
            }
            let mover = &asked["Action"]["MoveFloatingWindow"];
            assert_eq!(mover["id"], 9);
            if let (Some(dx), Some(dy)) = (mover["x"]["AdjustFixed"].as_i64(), mover["y"]["AdjustFixed"].as_i64()) {
                let (x, y) = self.pos.get();
                self.pos.set((x + dx as f64, y + dy as f64));
            } else {
                let axis = |v: &Value, o: f64, e: f64| if let Some(f) = v["SetFixed"].as_f64() { o + f } else { o + e - 75.0 };
                self.pos.set((axis(&mover["x"], 12.0, 1280.0), axis(&mover["y"], 30.0, 1000.0)));
            }
            Ok(json!("Handled"))
        }
        fn probes(&self) -> usize {
            self.log.borrow().iter().filter(|w| {
                w.pointer("/Action/MoveFloatingWindow/id").and_then(Value::as_u64) == Some(9)
                    && w.pointer("/Action/MoveFloatingWindow/x/AdjustFixed").is_none()
            }).count()
        }
    }
    fn shell_with(cache: Option<CachedCalibration>) -> Shell {
        let data_dir = std::env::temp_dir().join(format!("gd-env-data-{}", std::process::id()));
        let (snap, _rx) = mpsc::channel();
        Shell {
            config: DesktopConfig { data_dir: data_dir.clone(), port: 0, shortcut: String::new() },
            daemon: Arc::new(Daemon::new(0, data_dir, None)), snap, places_windows: false,
            rose_hidden: AtomicBool::new(false), panel_spot: Mutex::new(None), full_screen: Mutex::new(None),
            native_expanded: Mutex::new(false),
            native_compact: Mutex::new(Some(anchor(100.0, 200.0))),
            native_epoch: AtomicU64::new(6), native_restore: Mutex::new(None), native_gate: Mutex::new(None),
            native_intent: Mutex::new(None),
            native_unit: Mutex::new(NiriUnitState::dormant()),
            native_mover: Mutex::new(None),
            native_suppress_until: Mutex::new(None), cover_cancelled: Mutex::new(None),
            native_hide_job: Mutex::new(None), native_io: Mutex::new(()),
            native_work_area: Mutex::new(None), native_unit_cache: Mutex::new(cache), shortcut: Mutex::new(None),
        }
    }
    fn run(fake: &Fake, spot: &crate::niri::CompactSpot, cached: Option<CachedCalibration>)
        -> (SharedOutcome, Vec<&'static str>, Option<CachedCalibration>) {
        let mut steps = Vec::new();
        let mut cache_out = None;
        let mut cache_clear = false;
        let mut cover = || true;
        let mut release = || true;
        let mut resize = |size: (i32, i32)| { fake.adopt(size); true };
        let mut hide = || true;
        let mut show = || true;
        let mut request = |wire: &str, budget: Duration| fake.request(wire, budget);
        let mut ready = || true;
        let outcome = run_shared_unit_sequence_cached(42, Some(spot), R::Pair, false, 8, 12.0,
            Duration::from_secs(2), || true, &mut cover, &mut release, &mut resize, &mut hide, &mut show,
            &mut request, &mut ready, &mut steps, cached, &mut cache_out, &mut cache_clear);
        (outcome, steps, cache_out)
    }
    let spot = anchor(100.0, 200.0);
    // First placement probes and fills the cache.
    let fake = Fake::live();
    let (outcome, _, cache) = run(&fake, &spot, None);
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    let cache = cache.expect("probe fills the cache");
    let probes = fake.probes();
    assert!(probes > 0);
    // Baseline Layers observation records without clearing.
    let shell = shell_with(Some(cache.clone()));
    let mut last = None;
    assert!(!note_environment_event(&shell.native_gate, &shell.native_unit_cache, &bar_event(), &mut last, &|| true));
    assert!(shell.native_unit_cache.lock().unwrap().is_some(), "baseline records, never clears");
    // Unchanged payload leaves the entry intact: next transition reuses
    // it with zero probe moves.
    assert!(!note_environment_event(&shell.native_gate, &shell.native_unit_cache, &bar_event(), &mut last, &|| true));
    let (outcome, steps, _) = run(&fake, &spot, shell.native_unit_cache.lock().unwrap().clone());
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    assert!(steps.contains(&"cached") && !steps.contains(&"prepare"));
    assert_eq!(fake.probes(), probes, "unchanged payload issues no extra probe");
    // The bar is removed: an empty list differs, so the entry is dropped
    // and the next transition re-probes once and re-fills it.
    assert!(note_environment_event(&shell.native_gate, &shell.native_unit_cache, &json!({"Layers": []}), &mut last, &|| true));
    assert!(shell.native_unit_cache.lock().unwrap().is_none(), "layer change clears the entry");
    let (outcome, steps, refilled) = run(&fake, &spot, shell.native_unit_cache.lock().unwrap().clone());
    assert_eq!(outcome, SharedOutcome::Revealed(Some(spot.clone())));
    assert!(steps.contains(&"prepare"), "cleared entry re-probes: {steps:?}");
    assert!(refilled.is_some(), "re-probe re-fills the entry");
    // A config reload clears the entry the same way.
    let shell = shell_with(refilled);
    let mut last = None;
    assert!(note_environment_event(&shell.native_gate, &shell.native_unit_cache, &json!({"ConfigLoaded": {"failed": false}}), &mut last, &|| true));
    assert!(shell.native_unit_cache.lock().unwrap().is_none(), "ConfigLoaded clears the entry");
    // A stale generation clears nothing and records nothing.
    let shell = shell_with(Some(cache.clone()));
    let mut last = None;
    assert!(!note_environment_event(&shell.native_gate, &shell.native_unit_cache, &bar_event(), &mut last, &|| false));
    assert!(shell.native_unit_cache.lock().unwrap().is_some(), "stale event clears nothing");
    assert!(last.is_none(), "stale event records nothing");
}

#[cfg(target_os = "linux")]
#[test]
fn shared_reveal_focus_follows_chat_open_only() {
    // Rose-only must never be focusable (workspace-return focus memory would
    // land on us); chat-open must be focusable so the user can type at once.
    assert!(shared_reveal_focusable(true), "chat-open is focusable");
    assert!(!shared_reveal_focusable(false), "rose-only never takes focus");
}

#[cfg(target_os = "linux")]
fn native_windows() -> serde_json::Value {
    serde_json::json!({"Windows": [{
        "id": 9, "pid": 100, "title": crate::platform::PANEL_TITLE,
        "workspace_id": 7, "is_floating": true,
        "layout": {"tile_pos_in_workspace_view": [10.0, 20.0], "window_size": [420, 640]},
    }]})
}

/// Same shape with a tiled panel: the superseded-tile state where the
/// recorded mode says compact but the compositor still tiles (unit 20f1).
#[cfg(target_os = "linux")]
fn native_windows_tiled() -> serde_json::Value {
    serde_json::json!({"Windows": [{
        "id": 9, "pid": 100, "title": crate::platform::PANEL_TITLE,
        "workspace_id": 7, "is_floating": false,
        "layout": {"tile_pos_in_workspace_view": [10.0, 20.0], "window_size": [420, 640]},
    }]})
}

#[cfg(target_os = "linux")]
struct ModeCase {
    expanded: bool,
    on: bool,
    bare_windows: bool,
    tiled_windows: bool,
    fail_setter: bool,
    fail_size: bool,
    fail_fix: bool,
    err_wires: Vec<String>,
    ok_wires: Vec<String>,
    expect_steps: Vec<ModeStep>,
    expect_ok: Option<bool>,
    expect_mode: bool,
}

#[cfg(target_os = "linux")]
fn check_mode_case(name: &str, case: &ModeCase) {
    use std::cell::RefCell;
    let log = RefCell::new(Vec::<ModeStep>::new());
    let windows = if case.bare_windows {
        serde_json::json!({"Windows": []})
    } else if case.tiled_windows {
        native_windows_tiled()
    } else {
        native_windows()
    };
    let mut set_resizable = |resizable: bool| -> Result<(), String> {
        log.borrow_mut().push(ModeStep::Resizable(resizable));
        if resizable && case.fail_setter {
            return Err("setter down".to_owned());
        }
        if !resizable && case.fail_fix {
            return Err("fix down".to_owned());
        }
        Ok(())
    };
    let mut set_compact_size = || -> Result<(), String> {
        log.borrow_mut().push(ModeStep::Size);
        if case.fail_size {
            return Err("size down".to_owned());
        }
        Ok(())
    };
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        log.borrow_mut().push(ModeStep::Request(wire.to_owned()));
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else if case.err_wires.iter().any(|w| w == wire) {
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "niri: silent"))
        } else if case.ok_wires.iter().any(|w| w == wire) {
            Ok(serde_json::json!({"unexpected": "ok"}))
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let mut queue_restore = || log.borrow_mut().push(ModeStep::Handoff);
    let mut expanded = case.expanded;
    let outcome = run_native_mode_change(
        &mut expanded, case.on, 100, &mut set_resizable, &mut set_compact_size,
        &mut request, &mut queue_restore,
    );
    assert_eq!(log.borrow().as_slice(), case.expect_steps.as_slice(), "{name}");
    match case.expect_ok {
        Some(ok) => assert_eq!(outcome, Ok(ok), "{name}"),
        None => assert!(outcome.is_err(), "{name}"),
    }
    assert_eq!(expanded, case.expect_mode, "{name}");
}

#[cfg(target_os = "linux")]
#[test]
fn native_mode_table_expand_paths() {
    let tilt = crate::niri::action_tiling(9);
    let width = crate::niri::action_set_window_width(9);
    let height = crate::niri::action_reset_window_height(9);
    let queried = |wires: Vec<String>| {
        let mut steps = vec![ModeStep::Request(crate::niri::WINDOWS_REQUEST.to_owned()), ModeStep::Resizable(true)];
        steps.extend(wires.into_iter().map(ModeStep::Request));
        steps
    };
    for (name, case) in [
        ("release-tile-width-height", ModeCase {
            expanded: false, on: true, bare_windows: false, tiled_windows: false,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), tilt.clone(), width.clone(), height.clone()]),
            expect_ok: Some(true), expect_mode: true,
        }),
        ("release-failure-stops", ModeCase {
            expanded: false, on: true, bare_windows: false, tiled_windows: false,
            fail_setter: true, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: vec![ModeStep::Request(crate::niri::WINDOWS_REQUEST.to_owned()), ModeStep::Resizable(true)],
            expect_ok: None, expect_mode: false,
        }),
        ("tile-failure-rolls-back", ModeCase {
            expanded: false, on: true, bare_windows: false, tiled_windows: false,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![tilt.clone()], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), tilt.clone()]),
                vec![ModeStep::Resizable(false)]].concat(),
            expect_ok: None, expect_mode: false,
        }),
    ] {
        check_mode_case(name, &case);
    }
    // Geometry failures after a Handled tile keep the honestly expanded
    // mode while surfacing the error — never a false compact report, and
    // no rollback clamp after the flip. Earlier geometry wires still run.
    for (failing, before) in [(width.clone(), vec![]), (height.clone(), vec![width.clone()])] {
        let name = "geometry-failure-stays-expanded";
        let mut log_steps = vec![ModeStep::Request(crate::niri::WINDOWS_REQUEST.to_owned()),
            ModeStep::Resizable(true),
            ModeStep::Request(crate::niri::WINDOWS_REQUEST.to_owned()),
            ModeStep::Request(tilt.clone())];
        log_steps.extend(before.into_iter().map(ModeStep::Request));
        log_steps.push(ModeStep::Request(failing.clone()));
        check_mode_case(name, &ModeCase {
            expanded: false, on: true, bare_windows: false, tiled_windows: false,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![failing],
            expect_steps: log_steps, expect_ok: Some(true), expect_mode: true,
        });
    }
    // Unit 20f1: recorded expanded but actually floating (a superseded
    // float landed without a commit) still tiles — never a blind geometry
    // retry plus commit over a floating window.
    check_mode_case("tile-despite-stale-expanded-record", &ModeCase {
        expanded: true, on: true, bare_windows: false, tiled_windows: false,
        fail_setter: false, fail_size: false, fail_fix: false,
        err_wires: vec![], ok_wires: vec![],
        expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), tilt.clone(), width.clone(), height.clone()]),
        expect_ok: Some(true), expect_mode: true,
    });
}

#[cfg(target_os = "linux")]
#[test]
fn native_mode_table_compact_paths() {
    let float = crate::niri::action_floating(9);
    let queried = |wires: Vec<String>| wires.into_iter().map(ModeStep::Request).collect::<Vec<_>>();
    for (name, case) in [
        ("float-size-pin-restore", ModeCase {
            expanded: true, on: false, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), float.clone()]),
                vec![ModeStep::Size, ModeStep::Resizable(false), ModeStep::Handoff]].concat(),
            expect_ok: Some(false), expect_mode: false,
        }),
        ("float-failure-untouched", ModeCase {
            expanded: true, on: false, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![float.clone()], ok_wires: vec![],
            expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), float.clone()]),
            expect_ok: None, expect_mode: true,
        }),
        ("size-failure-compact-no-pin", ModeCase {
            expanded: true, on: false, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: true, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), float.clone()]),
                vec![ModeStep::Size]].concat(),
            expect_ok: None, expect_mode: false,
        }),
        ("fix-failure-compact", ModeCase {
            expanded: true, on: false, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: true,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), float.clone()]),
                vec![ModeStep::Size, ModeStep::Resizable(false)]].concat(),
            expect_ok: None, expect_mode: false,
        }),
        ("same-compact-silent", ModeCase {
            expanded: false, on: false, bare_windows: false, tiled_windows: false,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned()]),
                vec![ModeStep::Handoff]].concat(),
            expect_ok: Some(false), expect_mode: false,
        }),
        // Unit 20f1: recorded compact but actually tiled (a superseded
        // tile landed without a commit) still floats back — a cached
        // compact record never skips cancelling the tile.
        ("same-compact-acts-on-tiled", ModeCase {
            expanded: false, on: false, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: [queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), float.clone()]),
                vec![ModeStep::Size, ModeStep::Resizable(false), ModeStep::Handoff]].concat(),
            expect_ok: Some(false), expect_mode: false,
        }),
    ] {
        check_mode_case(name, &case);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn native_mode_table_retry_paths() {
    let width = crate::niri::action_set_window_width(9);
    let height = crate::niri::action_reset_window_height(9);
    let queried = |wires: Vec<String>| wires.into_iter().map(ModeStep::Request).collect::<Vec<_>>();
    for (name, case) in [
        ("retry-regrows-geometry", ModeCase {
            expanded: false, on: true, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), width.clone(), height.clone()]),
            expect_ok: Some(true), expect_mode: true,
        }),
        ("retry-geometry-failure-diagnostic-ok", ModeCase {
            expanded: true, on: true, bare_windows: false, tiled_windows: true,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![width.clone()],
            expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned(), width.clone()]),
            expect_ok: Some(true), expect_mode: true,
        }),
        ("retry-missing-window-noop", ModeCase {
            expanded: true, on: true, bare_windows: true, tiled_windows: false,
            fail_setter: false, fail_size: false, fail_fix: false,
            err_wires: vec![], ok_wires: vec![],
            expect_steps: queried(vec![crate::niri::WINDOWS_REQUEST.to_owned(), crate::niri::WINDOWS_REQUEST.to_owned()]),
            expect_ok: Some(true), expect_mode: true,
        }),
    ] {
        check_mode_case(name, &case);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn hide_intent_publish_never_recedes() {
    // Unit 20f2: overlapping publishes route through the ACTUAL shared
    // helper — publish 7, then late publish 6 — and the water never
    // recedes. (RED on the old unconditional store order above.)
    let hide: Mutex<Option<u64>> = Mutex::new(None);
    publish_hide_intent(&hide, 7);
    publish_hide_intent(&hide, 6);
    assert_eq!(*hide.lock().unwrap(), Some(7u64), "late older publish erased the newer intent");
    publish_hide_intent(&hide, 7);
    assert_eq!(*hide.lock().unwrap(), Some(7u64), "republish keeps the water");
    assert!(clear_hide_intent(&hide, 7), "exact owner clears");
    assert_eq!(*hide.lock().unwrap(), None);
    assert!(!clear_hide_intent(&hide, 7), "double clear is a no-op");
    publish_hide_intent(&hide, 9);
    assert!(!clear_hide_intent(&hide, 8), "older job never clears newer intent");
    assert_eq!(*hide.lock().unwrap(), Some(9u64));
}

#[cfg(target_os = "linux")]
#[test]
fn hide_take_publishes_atomically_under_one_hold() {
    // Unit 20f2a: the ACTUAL production take+publish — one bump clears
    // any gate and owns the marker, so no show/mode can interleave
    // between them. Monotonic both ways: a newer take supersedes, an
    // older take never recedes a newer publish, and an older completion
    // never clears the newer intent.
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(6);
    let gate = Mutex::new(Some(6u64));
    let _intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let hide = Mutex::new(None);
    assert_eq!(take_hide_generation(&epoch, &gate, &hide), 7);
    assert_eq!(epoch.load(Ordering::SeqCst), 7);
    assert_eq!(*gate.lock().unwrap(), None, "take clears the gate");
    assert_eq!(*hide.lock().unwrap(), Some(7u64), "take owns the marker");
    assert_eq!(take_hide_generation(&epoch, &gate, &hide), 8);
    assert_eq!(*hide.lock().unwrap(), Some(8u64));
    assert!(!clear_hide_intent(&hide, 7), "older completion never clears newer intent");
    assert_eq!(*hide.lock().unwrap(), Some(8u64));
    // Older take against a newer publish keeps the water (same
    // monotonic rule as publish_hide_intent, shared hold).
    *hide.lock().unwrap() = Some(9u64);
    let landed = take_hide_generation(&epoch, &gate, &hide);
    assert_eq!(*hide.lock().unwrap(), Some(9u64), "stale take must not recede job={landed}");
}

#[cfg(target_os = "linux")]
#[test]
fn show_entry_invalidates_fresh_hide_before_any_branch() {
    // Unit 20f2a: the ACTUAL show-entry helper also called in
    // show_panel_niri — a fresh pending hide stales before ANY branch
    // read, so even the gated no-worker Err return cannot leave it
    // fresh for its completion to unmap the show. No pending intent
    // bumps nothing (no unconditional double bump with the handoff).
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(6);
    let gate: Mutex<Option<u64>> = Mutex::new(None);
    let hide: Mutex<Option<u64>> = Mutex::new(None);
    assert_eq!(prepare_niri_show(&epoch, &gate, &hide), None);
    assert_eq!(epoch.load(Ordering::SeqCst), 6, "bare show bumps nothing");
    *hide.lock().unwrap() = Some(6u64);
    assert_eq!(prepare_niri_show(&epoch, &gate, &hide), Some(7));
    assert_eq!(epoch.load(Ordering::SeqCst), 7);
    assert!(!hide_intent_fresh(&hide, &epoch), "pending hide stales at entry");
    // The old hide's completion now plans nothing: no unmap, no reset.
    assert_eq!(plan_hide_completion(7, 6, Some(6)), None, "stale completion has no effects");
    // Already-stale intent likewise bumps nothing.
    assert_eq!(prepare_niri_show(&epoch, &gate, &hide), None);
    assert_eq!(epoch.load(Ordering::SeqCst), 7);
}

#[cfg(target_os = "linux")]
#[test]
fn hide_delivery_failure_releases_only_its_owner() {
    // Unit 20f2a: the ACTUAL seam behind both the main-thread enqueue
    // failure and the pool-join failure — an older failure never clears
    // a newer pending hide, and nothing is queued, so no hide runs
    // after the cleanup (newer lifecycle plans nothing for the old job).
    let hide: Mutex<Option<u64>> = Mutex::new(Some(9u64));
    assert!(!resolve_hide_delivery_failure(&hide, 7), "old failure keeps newer intent");
    assert_eq!(*hide.lock().unwrap(), Some(9u64));
    assert_eq!(plan_hide_completion(9, 7, Some(9)), None, "no queued hide for the old job");
    *hide.lock().unwrap() = Some(7u64);
    assert!(resolve_hide_delivery_failure(&hide, 7), "exact owner releases");
    assert_eq!(*hide.lock().unwrap(), None);
}

#[cfg(target_os = "linux")]
#[test]
fn toggle_routes_show_while_hide_pending() {
    // Unit 20f2: full routing matrix through the ACTUAL production
    // helper — a fresh pending hide routes Show even while mapped, and
    // the visibility getter provably never runs then (it panics).
    assert_eq!(plan_toggle_route::<String>(true, || panic!("getter skipped while pending")), Ok(true));
    assert_eq!(plan_toggle_route::<String>(true, || Ok(false)), Ok(true));
    assert_eq!(plan_toggle_route::<String>(false, || Ok(true)), Ok(false));
    assert_eq!(plan_toggle_route::<String>(false, || Ok(false)), Ok(true));
    assert!(plan_toggle_route::<String>(false, || Err("getter down".to_owned())).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn hide_completion_plans_only_for_fresh_owner() {
    // Unit 20f2: delivery matrix through the ACTUAL planner — fresh job
    // plus own intent unmaps+resets; stale epoch, superseded intent, or
    // missing intent plan nothing (a gateless hide passes on epoch
    // freshness alone: no gate is required).
    assert_eq!(
        plan_hide_completion(6, 6, Some(6)),
        Some(vec![GateEffect::Unmap, GateEffect::ResetVisuals])
    );
    assert_eq!(plan_hide_completion(7, 6, Some(6)), None);
    assert_eq!(plan_hide_completion(6, 6, Some(7)), None);
    assert_eq!(plan_hide_completion(6, 6, None), None);
    assert_eq!(plan_hide_completion(7, 6, None), None);
}

#[cfg(target_os = "linux")]
#[test]
fn hide_transaction_orders_capture_before_finish() {
    // Unit 20f2: the production seam with injected capture + recorder —
    // fresh capture merges then finishes; stale skips capture but still
    // finishes; capture-None preserves the anchor. No AppHandle, no socket.
    let spot = crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 3.0, y: 4.0 };
    let shell = test_hide_shell(6, None);
    let order = std::cell::RefCell::new(Vec::<&'static str>::new());
    let captures = std::cell::Cell::new(0u32);
    let mut capture = || {
        order.borrow_mut().push("capture");
        captures.set(captures.get() + 1);
        Some(spot.clone())
    };
    let mut finish = || order.borrow_mut().push("finish");
    run_hide_transaction(&shell, 6, true, 6, 6, &mut capture, &mut finish);
    assert_eq!(captures.get(), 1);
    assert_eq!(*order.borrow(), vec!["capture", "finish"]);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(spot.clone()));
    // Stale (epoch advanced): no capture, no overwrite, finish runs.
    shell.native_epoch.store(7, Ordering::SeqCst);
    order.borrow_mut().clear();
    run_hide_transaction(&shell, 6, true, 6, 6, &mut capture, &mut finish);
    assert_eq!(captures.get(), 1, "stale job never captures");
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(spot.clone()), "stale job never overwrites");
    assert_eq!(*order.borrow(), vec!["finish"]);
    // Capture-None (tiled/err): anchor preserved, finish runs.
    shell.native_epoch.store(8, Ordering::SeqCst);
    order.borrow_mut().clear();
    let mut capture_none = || {
        order.borrow_mut().push("capture");
        None
    };
    run_hide_transaction(&shell, 8, true, 8, 8, &mut capture_none, &mut finish);
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(spot.clone()));
    assert_eq!(*order.borrow(), vec!["capture", "finish"]);
}

#[cfg(target_os = "linux")]
#[test]
fn hide_capture_blocked_leaves_state_locks_free() {
    // Unit 20f2: parked fake capture inside the REAL seam — the caller
    // never blocks; every state lock stays free under io; a newer show
    // epoch published mid-capture refuses the commit yet still finishes.
    // Channel barriers only; every wait is recv_timeout fail-closed and
    // no spawned thread asserts, so one failure cannot hang the suite.
    const BOUND: Duration = Duration::from_secs(5);
    let anchor = crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 1.0, y: 2.0 };
    let spot = crate::niri::CompactSpot { output: "DP-1".to_owned(), x: 3.0, y: 4.0 };
    let shell = test_hide_shell(6, Some(anchor.clone()));
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let shell_ref = &shell;
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let mut capture = || {
                entered_tx.send(()).unwrap_or(());
                if release_rx.recv_timeout(BOUND).is_err() {
                    return None;
                }
                Some(spot.clone())
            };
            let mut finish = || {
                done_tx.send(()).unwrap_or(());
            };
            run_hide_transaction(shell_ref, 6, true, 6, 6, &mut capture, &mut finish);
        });
        entered_rx.recv_timeout(BOUND).expect("capture parked under io");
        // Same locks the production code holds brief-only: all free here.
        assert!(shell.native_expanded.try_lock().is_ok());
        assert!(shell.native_compact.try_lock().is_ok());
        assert!(shell.native_mover.try_lock().is_ok());
        assert!(shell.native_gate.try_lock().is_ok());
        // Newer show epoch published while blocked: commit must refuse.
        assert_eq!(mode_take_generation(&shell.native_epoch, &shell.native_gate), 7);
        release_tx.send(()).expect("release capture");
        done_rx.recv_timeout(BOUND).expect("stale job still finishes");
    });
    assert_eq!(*shell.native_compact.lock().unwrap(), Some(anchor), "stale commit never overwrites");
}

#[test]
fn rose_visible_by_default_everywhere_task4() {
    // Task 4: the rose is visible by default on every build, including
    // Linux KSNI on Niri; only an explicit persisted choice hides it.
    assert!(!default_rose_hidden_for(Os::Linux, true, true));
    assert!(!default_rose_hidden_for(Os::Linux, true, false));
    assert!(!default_rose_hidden_for(Os::Linux, false, true));
    assert!(!default_rose_hidden_for(Os::MacOs, true, true));
}

#[test]
fn rose_default_is_visible_everywhere() {
    // Task 4: the rose is visible by default on every build and desktop,
    // including Linux KSNI on Niri; only an explicit persisted choice
    // hides it across restarts.
    assert!(!default_rose_hidden_for(Os::Linux, true, true));
    // macOS, AppIndicator, Hyprland/GNOME stay shown by default.
    assert!(!default_rose_hidden_for(Os::MacOs, true, true));
    assert!(!default_rose_hidden_for(Os::MacOs, false, false));
    assert!(!default_rose_hidden_for(Os::Linux, false, true));
    assert!(!default_rose_hidden_for(Os::Linux, true, false));
    assert!(!default_rose_hidden_for(Os::Linux, false, false));
}

#[cfg(target_os = "linux")]
#[test]
fn rose_hides_in_fullscreen_and_returns_with_the_user_preference() {
    // Requirement S5: the rose is hidden in fullscreen whatever the saved
    // preference says, and returning shows it only while the user still
    // wants it — the preference stays the single source of truth.
    for (expanded, wants, visible) in [
        (true, true, false),
        (true, false, false),
        (false, true, true),
        (false, false, false),
    ] {
        assert_eq!(
            rose_visible_for_mode(expanded, wants), visible,
            "expanded={expanded} wants_rose={wants}"
        );
    }
}


#[cfg(target_os = "linux")]
#[test]
fn unit_fullscreen_hides_rose_keeps_preference() {
    // S5/S9: fullscreen implies no rose whatever the saved preference
    // says, and the preference itself is untouched (still true here) so
    // leaving fullscreen restores the rose beside the chat.
    let wants_rose = true;
    assert!(!rose_visible_for_mode(true, wants_rose));
    assert!(wants_rose, "saved preference must survive fullscreen");
    assert!(rose_visible_for_mode(false, wants_rose));
}

#[cfg(target_os = "linux")]
#[test]
fn unit_fullscreen_roundtrip_keeps_preference_and_anchor_intent() {
    // Fullscreen roundtrip: expanding keeps the saved rose preference,
    // derives Fullscreen, and preserves; collapsing with an anchor
    // preserves it (S15/S17), without one falls back to the base.
    // The commit takes no compact lock, so the anchor is preserved.
    use std::sync::atomic::AtomicU64;
    use crate::niri::unit_surface::UnitMode;
    let gate = Mutex::new(None);
    let unit = Mutex::new(NiriUnitState::dormant());
    unit.lock().unwrap().active = true;
    let epoch = AtomicU64::new(9);
    let expanded = Mutex::new(false);
    let rose = AtomicBool::new(true);
    let intents = Mutex::new(None);
    let commit = |kind, anchored| {
        unit_transition_commit(&gate, &unit, &epoch, &expanded, &rose, &intents, false, true, true, anchored, kind).unwrap()
    };
    let opened = commit(UnitTransition::Open, true);
    assert!(opened.open);
    let full = commit(UnitTransition::SetExpanded(true), true);
    assert!(full.fullscreen && full.rose_hidden, "preference survives expand");
    assert_eq!(unit_mode_for(full.open, full.rose_hidden, full.fullscreen), UnitMode::Fullscreen);
    assert_eq!(*intents.lock().unwrap(), Some((11, RestoreIntent::PreserveCompact)));
    let back = commit(UnitTransition::SetExpanded(false), true);
    assert!(!back.fullscreen && back.rose_hidden);
    assert_eq!(*intents.lock().unwrap(), Some((12, RestoreIntent::PreserveCompact)), "remembered anchor preserved");
    let unanchored = commit(UnitTransition::SetExpanded(false), false);
    assert_eq!(*intents.lock().unwrap(), Some((13, RestoreIntent::CollapseToBase)), "anchorless collapse falls back");
    assert!(unanchored.rose_hidden, "preference still kept");
}

#[test]
fn rose_reappear_reanchors_visible_panel_beside_dot() {
    // Unit fix: unhide with a mapped app-placed non-fullscreen panel
    // reanchors beside the rose synchronously; every other cell stays.
    assert!(rose_unhide_reanchors(false, true, true, false));
    assert!(!rose_unhide_reanchors(true, true, true, false));
    assert!(!rose_unhide_reanchors(false, false, true, false));
    assert!(!rose_unhide_reanchors(false, true, true, true));
    assert!(!rose_unhide_reanchors(false, true, false, false));
}

#[cfg(target_os = "linux")]
#[test]
fn niri_unhide_moves_the_rose_beside_the_visible_panel() {
    // Live FAIL mv347ejs leg (2): Niri unhide must move the ROSA beside
    // the moved panel — never pull the panel back. Hide/fullscreen win,
    // expanded wins, app-owned sessions keep the panel path, hidden or
    // unmapped panels never move the rose.
    assert!(rose_unhide_moves_rose(false, true, false, true, false, false));
    for blocked in [
        (true, true, false, true, false, false),
        (false, false, false, true, false, false),
        (false, true, true, true, false, false),
        (false, true, false, false, false, false),
        (false, true, false, true, true, false),
        (false, true, false, true, false, true),
        (true, false, true, false, true, true),
    ] {
        assert!(
            !rose_unhide_moves_rose(blocked.0, blocked.1, blocked.2, blocked.3, blocked.4, blocked.5),
            "{blocked:?}"
        );
    }
}

#[test]
fn the_rose_item_offers_the_opposite_of_its_state() {
    assert_eq!(rose_menu_label(false), "Hide the rose");
    assert_eq!(rose_menu_label(true), "Show the rose");
}

#[cfg(target_os = "linux")]
#[test]
fn shared_rose_toggle_refused_while_fullscreen() {
    // Fullscreen implies no rose; the shared branch must refuse a rose
    // toggle instead of starting a transition.
    assert!(!shared_rose_toggle_allowed(true), "fullscreen blocks the rose toggle");
    assert!(shared_rose_toggle_allowed(false), "minimized keeps the toggle");
}

/// Unit 20a1 regression: a successful collapse must commit compact BEFORE
/// its own restore handoff increments the generation. The handoff fake
/// below performs the REAL epoch-incrementing handoff (as production
/// does), so the old inside-transition order self-stales and this fails
/// with `Ok(true)` / expanded still true despite a landed float.
#[cfg(target_os = "linux")]
#[test]
fn collapse_commits_compact_before_its_restore_handoff() {
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None::<u64>);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let mut kinds = Vec::new();
    // Faithful to production: the atomic compare-and-handoff on the
    // expected generation, so this still guards commit-before-handoff.
    let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
        kinds.push(kind);
        match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
            ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
        }
    };
    let windows = native_windows();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert_eq!(outcome, Ok(false), "successful float commits compact");
    assert_eq!(*expanded.lock().unwrap(), false);
    assert_eq!(kinds, vec![ModeRestore::Gated]);
}

/// Wire failure is an error, never a stale-success: no commit flip, no
/// handoff queued behind the failure.
#[cfg(target_os = "linux")]
#[test]
fn collapse_wire_failure_returns_error_without_handoff() {
    // The float must actually be attempted: a tiled panel with recorded
    // expanded (unit 20f1 reconcile would otherwise settle silent with
    // no wire at all).
    let epoch = AtomicU64::new(5);
    let expanded = Mutex::new(true);
    let float = crate::niri::action_floating(9);
    let mut kinds = Vec::new();
    let mut handoff = |kind: ModeRestore, _expected: u64| -> bool {
        kinds.push(kind);
        true
    };
    let windows = native_windows_tiled();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else if wire == float {
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "niri: silent"))
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert!(outcome.is_err(), "float failure surfaces, got {outcome:?}");
    assert_eq!(*expanded.lock().unwrap(), true);
    assert!(kinds.is_empty());
}

/// A genuinely superseded transition (external hide bumped first) is
/// harmless: it never overwrites newer state, never unhides anything,
/// and queues no handoff — while reporting the live mode.
#[cfg(target_os = "linux")]
#[test]
fn superseded_transition_never_overwrites_newer_state() {
    let epoch = AtomicU64::new(6);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let mut kinds = Vec::new();
    // Faithful to production: the domain refuses the stale expectation,
    // so the attempt queues nothing into the newer lifecycle.
    let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
        kinds.push(kind);
        match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
            ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
        }
    };
    let windows = native_windows();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert_eq!(outcome, Ok(true), "stale op reports the live mode");
    assert_eq!(*expanded.lock().unwrap(), true);
    assert_eq!(kinds, vec![ModeRestore::Gated], "attempted, then refused");
    assert_eq!(epoch.load(Ordering::SeqCst), 6, "no bump past newer lifecycle");
    assert_eq!(*gate.lock().unwrap(), None, "no gate stolen");
}

/// Covered collapse outcomes through the ONE shared finish: refused-Ok,
/// disconnected-sender, wire-error, and successful Sent/Coalesced shapes —
/// real mode orchestration plus real sender outcomes, never a hardcoded
/// handoff behind the assertions.
#[cfg(target_os = "linux")]
#[test]
fn covered_ok_refused_handoff_queues_cleanup() {
    use std::sync::atomic::AtomicU64;
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
        let _newer = mode_take_generation(&epoch, &gate);
        match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
            ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
        }
    };
    let windows = native_windows();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert!(outcome.is_ok(), "refused handoff reports Ok, never an error");
    assert_eq!(epoch.load(Ordering::SeqCst), 6);
    // The caller routes this covered-Ok-nothing-queued shape through the
    // ONE shared finish: superseded by a gateless take, so no live gate
    // owns the visuals — uncover under the current generation.
    let mut recorded = Vec::new();
    finish_collapse_cover_with(
        true, 5, outcome.is_err(), false,
        epoch.load(Ordering::SeqCst), *gate.lock().unwrap(),
        &mut |cleanup| recorded.push(cleanup),
    );
    assert_eq!(recorded, vec![CoverCleanup::Current(6)]);
    // Disconnected-sender shape: the REAL gated handoff against a dead
    // worker bumps, publishes, and reports Disconnected — production
    // bookkeeping records not-queued (mirroring do_handoff minus the
    // app-bound cancel); the finish then plans against the live state.
    let epoch2 = AtomicU64::new(5);
    let gate2 = Mutex::new(None);
    let intents2 = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded2 = Mutex::new(true);
    let (tx2, rx2) = mpsc::sync_channel::<()>(1);
    drop(rx2);
    let mut queued2 = true;
    let mut handoff_dead = |kind: ModeRestore, expected: u64| -> bool {
        let attempted = match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx2, &epoch2, &gate2, expected, RestoreIntent::CollapseToBase, &intents2),
            ModeRestore::Plain => plain_handoff_if_expected(&tx2, &epoch2, &gate2, expected, RestoreIntent::CollapseToBase, &intents2),
        };
        match attempted {
            Some((_, queue)) => {
                queued2 = queue_reaches_worker(queue);
                queued2
            }
            None => false,
        }
    };
    let windows2 = native_windows();
    let mut set_resizable2 = |_: bool| Ok(());
    let mut set_compact_size2 = || Ok(());
    let mut request2 = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows2.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome2 = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch2, &expanded2,
        &mut set_resizable2, &mut set_compact_size2, &mut request2,
        &mut handoff_dead,
    );
    assert!(outcome2.is_ok());
    assert!(!queued2, "dead worker queues nothing");
    assert_eq!(epoch2.load(Ordering::SeqCst), 6);
    // Production runs its app-bound cancel (own-gate release) before the
    // shared finish; the finish then sees the post-cancel state —
    // gateless, epoch advanced, no visual owner — and uncovers.
    *gate2.lock().unwrap() = None;
    let mut recorded2 = Vec::new();
    finish_collapse_cover_with(
        true, 5, outcome2.is_err(), queued2,
        epoch2.load(Ordering::SeqCst), *gate2.lock().unwrap(),
        &mut |cleanup| recorded2.push(cleanup),
    );
    assert_eq!(recorded2, vec![CoverCleanup::Current(6)]);
    // Wire-error shape: errors propagate and the failed op owns cleanup.
    let mut request_err = |_: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "niri down"))
    };
    let mut handoff3 = |_: ModeRestore, _: u64| -> bool { panic!("no handoff on error") };
    let mut set_resizable3 = |_: bool| Ok(());
    let mut set_compact_size3 = || Ok(());
    let epoch3 = AtomicU64::new(5);
    let gate3 = Mutex::new(None);
    let _intents3 = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded3 = Mutex::new(true);
    let outcome3 = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch3, &expanded3,
        &mut set_resizable3, &mut set_compact_size3, &mut request_err,
        &mut handoff3,
    );
    assert!(outcome3.is_err(), "wire errors propagate, never stale-success");
    let mut recorded3 = Vec::new();
    finish_collapse_cover_with(
        true, 5, outcome3.is_err(), false,
        epoch3.load(Ordering::SeqCst), *gate3.lock().unwrap(),
        &mut |cleanup| recorded3.push(cleanup),
    );
    assert_eq!(recorded3, vec![CoverCleanup::Own(5)]);
    // Successful Sent/Coalesced handoffs queue NO cleanup callback — the
    // reveal owns visuals until settle. Real sender outcomes, not literals.
    let epoch4 = AtomicU64::new(5);
    let gate4 = Mutex::new(None);
    let intents4 = Mutex::new(None::<(u64, RestoreIntent)>);
    let (tx4, _rx4) = mpsc::sync_channel::<()>(1);
    let (_, queue4) = gated_handoff_if_expected(&tx4, &epoch4, &gate4, 5, RestoreIntent::PreserveCompact, &intents4).expect("fresh sends");
    assert_eq!(queue4, RestoreQueue::Sent);
    let mut recorded4 = Vec::new();
    finish_collapse_cover_with(
        true, 5, false, queue_reaches_worker(queue4),
        epoch4.load(Ordering::SeqCst), *gate4.lock().unwrap(),
        &mut |cleanup| recorded4.push(cleanup),
    );
    assert!(recorded4.is_empty(), "queued handoff owns visuals; no cleanup");
    let (_, queue5) = gated_handoff_if_expected(&tx4, &epoch4, &gate4, 6, RestoreIntent::PreserveCompact, &intents4).expect("coalesces while full");
    assert_eq!(queue5, RestoreQueue::Coalesced);
    let mut recorded5 = Vec::new();
    finish_collapse_cover_with(
        true, 6, false, queue_reaches_worker(queue5),
        epoch4.load(Ordering::SeqCst), *gate4.lock().unwrap(),
        &mut |cleanup| recorded5.push(cleanup),
    );
    assert!(recorded5.is_empty(), "coalesced handoff still reaches the worker; no cleanup");
}

/// Unit 20a2a: hidden collapse hands off plain through the same domain —
/// mode commits compact, no gate is ever published, and the epoch moves
/// exactly once for the successful transition.
#[cfg(target_os = "linux")]
#[test]
fn hidden_collapse_hands_off_plain_without_gate() {
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let mut kinds = Vec::new();
    let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
        kinds.push(kind);
        match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
            ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
        }
    };
    let windows = native_windows();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, false,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert_eq!(outcome, Ok(false));
    assert_eq!(*expanded.lock().unwrap(), false);
    assert_eq!(kinds, vec![ModeRestore::Plain]);
    assert_eq!(*gate.lock().unwrap(), None, "plain never publishes");
    assert_eq!(epoch.load(Ordering::SeqCst), 6);
}

/// Unit 20a2a: full seam with a competitor injected between our commit
/// and our handoff — the exact interleave the old order could not
/// survive. Our compare-and-handoff must refuse: the newer gate stays,
/// the epoch never moves past it, and we still report our committed
/// compact mode. Deterministic: the injection runs inside the handoff
/// step itself, no threads or sleeps.
#[cfg(target_os = "linux")]
#[test]
fn mode_handoff_never_steals_gate_published_after_commit() {
    let epoch = AtomicU64::new(5);
    let gate = Mutex::new(None);
    let intents = Mutex::new(None::<(u64, RestoreIntent)>);
    let expanded = Mutex::new(true);
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
        // Competing show lands first, then our handoff must refuse.
        let (show_job, _) = gated_restore_handoff(&tx, &epoch, &gate, RestoreIntent::PreserveCompact, &intents);
        assert_eq!(show_job, 6);
        match kind {
            ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
            ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch, &gate, expected, RestoreIntent::CollapseToBase, &intents).is_some(),
        }
    };
    let windows = native_windows();
    let mut set_resizable = |_: bool| Ok(());
    let mut set_compact_size = || Ok(());
    let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
        if wire == crate::niri::WINDOWS_REQUEST {
            Ok(windows.clone())
        } else {
            Ok(serde_json::json!("Handled"))
        }
    };
    let outcome = execute_mode_transition(
        true, false, 100, 5, true,
        &epoch, &expanded,
        &mut set_resizable, &mut set_compact_size, &mut request,
        &mut handoff,
    );
    assert_eq!(outcome, Ok(false), "our commit landed before the competitor");
    assert_eq!(*expanded.lock().unwrap(), false);
    assert_eq!(*gate.lock().unwrap(), Some(6), "newer gate retained");
    assert_eq!(epoch.load(Ordering::SeqCst), 6, "no bump past newer show");
}

#[cfg(target_os = "linux")]
#[test]
fn io_serializes_overlapping_mode_wire() {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    // Unit 20f: op1 collapse parks in fake wire under io; a racing take
    // publishes epoch 6; contender opB attempts wire and must wait; op1's
    // commit/handoff refuse stale and report live; opB enters only after
    // op1 releases. Channel barriers only — no sleeps. Every wait is
    // recv_timeout fail-closed and no spawned thread asserts, so one
    // failure can never hang the suite.
    const BOUND: Duration = Duration::from_secs(5);
    let io = Arc::new(Mutex::new(()));
    let epoch = Arc::new(AtomicU64::new(5));
    let gate: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let expanded = Arc::new(Mutex::new(true));
    let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let intent1 = Arc::new(Mutex::new(None::<(u64, RestoreIntent)>));
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (attempting_tx, attempting_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<CommandResult<bool>>();
    let windows = native_windows();
    let (io1, epoch1, gate1, expanded1, log1, intents1) =
        (Arc::clone(&io), Arc::clone(&epoch), Arc::clone(&gate), Arc::clone(&expanded), Arc::clone(&log), Arc::clone(&intent1));
    let op1 = std::thread::spawn(move || {
        let note = |s: &'static str| log1.lock().unwrap().push(s);
        let mut calls = 0u32;
        let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
            calls += 1;
            if calls == 1 {
                note("op1-wire-enter");
                entered_tx.send(()).unwrap_or(());
                if release_rx.recv_timeout(BOUND).is_err() {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "test barrier"));
                }
            }
            if wire == crate::niri::WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!("Handled"))
            }
        };
        let mut set_resizable = |_: bool| Ok(());
        let mut set_compact_size = || Ok(());
        let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
            match kind {
                ModeRestore::Gated => gated_handoff_if_expected(&tx, &epoch1, &gate1, expected, RestoreIntent::CollapseToBase, &intents1).is_some(),
                ModeRestore::Plain => plain_handoff_if_expected(&tx, &epoch1, &gate1, expected, RestoreIntent::CollapseToBase, &intents1).is_some(),
            }
        };
        // Mirrors the production transition closure: sequenced execute.
        let outcome = native_io_sequenced(&io1, &epoch1, 5, || {
            execute_mode_transition(
                true, false, 100, 5, true, &epoch1, &expanded1,
                &mut set_resizable, &mut set_compact_size, &mut request, &mut handoff,
            )
        })
        .unwrap_or_else(|| Ok(*expanded1.lock().unwrap()));
        note("op1-exit");
        done_tx.send(outcome).unwrap_or(());
    });
    entered_rx.recv_timeout(BOUND).expect("op1 parked in wire");
    // Production-bound (unit 20f1): the parked wire runs inside the real
    // transition under io — these SAME state locks must stay free.
    assert!(expanded.try_lock().is_ok(), "mode lock free while mode wire blocked");
    assert!(gate.try_lock().is_ok(), "gate free while mode wire blocked");
    assert_eq!(mode_take_generation(&epoch, &gate), 6, "racing take publishes");
    let (io2, epoch2, logb) = (Arc::clone(&io), Arc::clone(&epoch), Arc::clone(&log));
    let opb = std::thread::spawn(move || {
        logb.lock().unwrap().push("opB-attempt");
        attempting_tx.send(()).unwrap_or(());
        native_io_sequenced(&io2, &epoch2, 6, || {
            logb.lock().unwrap().push("opB-enter");
        });
    });
    attempting_rx.recv_timeout(BOUND).expect("contender at the gate");
    release_tx.send(()).expect("release op1");
    assert_eq!(done_rx.recv_timeout(BOUND).expect("op1 completes"), Ok(true));
    op1.join().expect("op1 joined");
    opb.join().expect("opB joined");
    assert_eq!(epoch.load(Ordering::SeqCst), 6, "refused handoff never bumps");
    assert_eq!(*expanded.lock().unwrap(), true, "stale op keeps previous mode");
    assert_eq!(
        *log.lock().unwrap(),
        vec!["op1-wire-enter", "opB-attempt", "op1-exit", "opB-enter"],
        "second mode enters wire only after first released"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn io_expand_wire_refuses_after_racing_take() {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    // Unit 20f, expand direction (false→true): parked wire, racing take
    // to 7, released op reports the live previous mode — commit and
    // handoff both refuse, no false atomicity from the epoch bump.
    const BOUND: Duration = Duration::from_secs(5);
    let io = Arc::new(Mutex::new(()));
    let epoch = Arc::new(AtomicU64::new(6));
    let gate: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let expanded = Arc::new(Mutex::new(false));
    let intentt = Arc::new(Mutex::new(None::<(u64, RestoreIntent)>));
    let (tx, _rx) = mpsc::sync_channel::<()>(1);
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<CommandResult<bool>>();
    let windows = native_windows();
    let (iot, epocht, gatet, expandedt, intentst) =
        (Arc::clone(&io), Arc::clone(&epoch), Arc::clone(&gate), Arc::clone(&expanded), Arc::clone(&intentt));
    let op = std::thread::spawn(move || {
        let mut calls = 0u32;
        let mut request = |wire: &str, _: Duration| -> std::io::Result<serde_json::Value> {
            calls += 1;
            if calls == 1 {
                entered_tx.send(()).unwrap_or(());
                if release_rx.recv_timeout(BOUND).is_err() {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "test barrier"));
                }
            }
            if wire == crate::niri::WINDOWS_REQUEST {
                Ok(windows.clone())
            } else {
                Ok(serde_json::json!("Handled"))
            }
        };
        let mut set_resizable = |_: bool| Ok(());
        let mut set_compact_size = || Ok(());
        let mut handoff = |kind: ModeRestore, expected: u64| -> bool {
            match kind {
                ModeRestore::Gated => gated_handoff_if_expected(&tx, &epocht, &gatet, expected, RestoreIntent::PreserveCompact, &intentst).is_some(),
                ModeRestore::Plain => plain_handoff_if_expected(&tx, &epocht, &gatet, expected, RestoreIntent::PreserveCompact, &intentst).is_some(),
            }
        };
        let outcome = native_io_sequenced(&iot, &epocht, 6, || {
            execute_mode_transition(
                false, true, 100, 6, true, &epocht, &expandedt,
                &mut set_resizable, &mut set_compact_size, &mut request, &mut handoff,
            )
        })
        .unwrap_or_else(|| Ok(*expandedt.lock().unwrap()));
        done_tx.send(outcome).unwrap_or(());
    });
    entered_rx.recv_timeout(BOUND).expect("op parked in wire");
    // Same production boundary as above: io holds no state lock.
    assert!(expanded.try_lock().is_ok(), "mode lock free while mode wire blocked");
    assert!(gate.try_lock().is_ok(), "gate free while mode wire blocked");
    assert_eq!(mode_take_generation(&epoch, &gate), 7);
    release_tx.send(()).expect("release op");
    assert_eq!(done_rx.recv_timeout(BOUND).expect("op completes"), Ok(false));
    op.join().expect("op joined");
    assert_eq!(epoch.load(Ordering::SeqCst), 7);
    assert_eq!(*expanded.lock().unwrap(), false);
}

#[cfg(target_os = "linux")]
#[test]
fn niri_offload_keeps_caller_moving_with_shapes() {
    // Deterministic caller progress through the REAL production seam:
    // mode work parks on a channel rendezvous while the caller acts,
    // then both bool and Err shapes round-trip. No sleeps; one bounded
    // channel wait as an anti-hang, never a fence.
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let pending = spawn_niri_mode_blocking(move || -> CommandResult<bool> {
        started_tx.send(()).expect("caller waits for start");
        release_rx.recv().expect("caller releases parked work");
        Ok(true)
    });
    started_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("mode work runs off the caller");
    // Reached while pool-thread work parks: the caller was never blocked.
    release_tx.send(()).expect("release");
    let done =
        tauri::async_runtime::block_on(async move { pending.await.map_err(err).unwrap() });
    assert_eq!(done, Ok(true));
    let pending_err =
        spawn_niri_mode_blocking(|| -> CommandResult<bool> { Err("niri: boom".to_owned()) });
    let failed =
        tauri::async_runtime::block_on(async move { pending_err.await.map_err(err).unwrap() });
    assert_eq!(failed, Err("niri: boom".to_owned()));
}

#[test]
fn shortcut_and_tray_open_place_the_panel_without_the_rose_when_it_is_hidden() {
    // `toggle_panel` (the shortcut) and the tray's Open both go through `show_panel`.
    assert_eq!(
        panel_placement(true, false, false, None),
        Placement::BesideDot
    );
    assert_eq!(panel_placement(true, false, true, None), Placement::Alone);
    // Full screen keeps its frame; native Wayland leaves placement to the compositor.
    assert_eq!(panel_placement(true, true, true, None), Placement::Keep);
    assert_eq!(panel_placement(true, true, false, None), Placement::Keep);
    assert_eq!(panel_placement(false, false, true, None), Placement::Keep);
}

#[test]
fn remembered_spot_never_overrides_the_visible_rose() {
    // Task 4: a visible rose always recomputes beside-the-Dot on every
    // reopen; a session-remembered spot only feeds the hidden `Alone`
    // path. This reaches the exact decision `show_panel` uses via
    // `place_panel`, whose first frame is placed before it maps.
    assert_eq!(
        panel_placement(true, false, false, Some((300, 200))),
        Placement::BesideDot
    );
    assert_eq!(
        panel_placement(true, false, true, Some((300, 200))),
        Placement::Alone
    );
    // Fullscreen and native-Wayland Keep still win over any saved spot.
    assert_eq!(
        panel_placement(true, true, false, Some((300, 200))),
        Placement::Keep
    );
    assert_eq!(
        panel_placement(false, false, false, Some((300, 200))),
        Placement::Keep
    );
    // No saved spot keeps the historical behavior.
    assert_eq!(
        panel_placement(true, false, false, None),
        Placement::BesideDot
    );
    assert_eq!(panel_placement(true, false, true, None), Placement::Alone);
}

#[test]
fn visible_rose_recalculates_beside_dot_task4() {
    // Task 4: a visible rose always recomputes beside-the-Dot on reopen;
    // a session-remembered spot never overrides it. Hidden always Alone.
    assert_eq!(
        panel_placement(true, false, false, Some((300, 200))),
        Placement::BesideDot
    );
    assert_eq!(
        panel_placement(true, false, true, Some((300, 200))),
        Placement::Alone
    );
    assert_eq!(panel_placement(true, false, true, None), Placement::Alone);
}

#[test]
fn early_launches_fold_with_fullscreen_precedence() {
    // T2-A: several launches racing setup replay as one request.
    // Fullscreen wins (the rarer, deliberate request, same rule as
    // `platform::launch_request` within one launch), then toggle, then show.
    assert_eq!(fold_launch_requests(&[]), None);
    assert_eq!(fold_launch_requests(&[LaunchRequest::Show]), Some(LaunchRequest::Show));
    assert_eq!(fold_launch_requests(&[LaunchRequest::Toggle]), Some(LaunchRequest::Toggle));
    assert_eq!(
        fold_launch_requests(&[LaunchRequest::Show, LaunchRequest::Toggle]),
        Some(LaunchRequest::Toggle)
    );
    assert_eq!(
        fold_launch_requests(&[LaunchRequest::Toggle, LaunchRequest::Show, LaunchRequest::Fullscreen]),
        Some(LaunchRequest::Fullscreen)
    );
    assert_eq!(fold_launch_requests(&[LaunchRequest::Fullscreen]), Some(LaunchRequest::Fullscreen));
}

#[test]
fn early_launches_queue_until_ready_then_replay_once() {
    // T2-A regression: a second launch arriving before `manage(Shell)`
    // must not touch Shell state (the login `state() called before
    // manage()` panic). Pre-ready requests queue; readiness replays the
    // fold exactly once and drains; post-ready requests dispatch now.
    let pending = PendingLaunches::new();
    assert_eq!(pending.route(LaunchRequest::Show), None);
    assert_eq!(pending.route(LaunchRequest::Toggle), None);
    assert_eq!(pending.pending_count(), 2);
    assert_eq!(pending.mark_ready_and_take(None), Some(LaunchRequest::Toggle));
    assert_eq!(pending.pending_count(), 0);
    assert_eq!(pending.mark_ready_and_take(None), None);
    assert_eq!(pending.route(LaunchRequest::Fullscreen), Some(LaunchRequest::Fullscreen));
    assert_eq!(pending.pending_count(), 0);
}

#[test]
fn own_initial_toggle_folds_with_queued_launches() {
    // T2-A: the setup-end replay combines the queued second-instance
    // requests with the app's own initial `--toggle`; quiet setup (no
    // queue, no own request) stays quiet, as today.
    let pending = PendingLaunches::new();
    assert_eq!(pending.route(LaunchRequest::Show), None);
    assert_eq!(
        pending.mark_ready_and_take(Some(LaunchRequest::Toggle)),
        Some(LaunchRequest::Toggle)
    );
    let pending = PendingLaunches::new();
    assert_eq!(pending.route(LaunchRequest::Fullscreen), None);
    assert_eq!(
        pending.mark_ready_and_take(Some(LaunchRequest::Toggle)),
        Some(LaunchRequest::Fullscreen)
    );
    let pending = PendingLaunches::new();
    assert_eq!(pending.mark_ready_and_take(None), None);
}

#[test]
fn concurrent_early_launches_are_never_lost() {
    // T2-A: the enqueue/ready handoff shares one lock, so concurrent
    // pre-ready launches cannot slip between the final drain and the ready
    // flip. Real threads, joined before readiness: fully deterministic.
    let pending = std::sync::Arc::new(PendingLaunches::new());
    let mut handles = Vec::new();
    for _ in 0..8 {
        let pending = pending.clone();
        handles.push(std::thread::spawn(move || {
            for _ in 0..25 {
                assert_eq!(pending.route(LaunchRequest::Toggle), None);
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(pending.pending_count(), 200);
    assert_eq!(pending.mark_ready_and_take(None), Some(LaunchRequest::Toggle));
    assert_eq!(pending.pending_count(), 0);
}

#[test]
fn tray_retry_only_for_a_missing_watcher() {
    // T2-B regression: the exact login failure — the KSNI watcher host
    // starts after the autostarted app, so registration reports
    // ServiceUnknown. Only that transient (plus ksni's no-host `WontShow`)
    // retries; anything else still aborts setup loudly.
    assert!(tray_watcher_transient("tray icon error: failed to register to the StatusNotifierWatcher: org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable"));
    assert!(tray_watcher_transient("tray icon error: no StatusNotifierHost exists"));
    assert!(!tray_watcher_transient("tray icon error: D-Bus connection error: connection failed"));
    assert!(!tray_watcher_transient("tray icon error: failed to create menu: invalid id"));
    assert!(!tray_watcher_transient(""));
}

#[test]
fn tray_retry_stays_bounded() {
    // T2-B: the retry must end on its own — success, a non-transient
    // error, or exhausting the attempts — never linger past shutdown.
    assert!((1..=48).contains(&TRAY_RETRY_ATTEMPTS));
    assert!(TRAY_RETRY_DELAY >= Duration::from_secs(1));
}
