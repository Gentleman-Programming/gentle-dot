//! Physical-pixel Windows geometry; native/UI ordering remains on the owning UI thread.
use super::*;
use crate::computer::{glow::{self, Frame}, win32,
    working::{WorkingEvent, WORKING_EVENT}};

fn frame(rect: win32::PixelRect) -> Frame {
    Frame { x: f64::from(rect.x), y: f64::from(rect.y),
        width: f64::from(rect.width), height: f64::from(rect.height) }
}
fn display(at: computer::coords::Point) -> Option<Frame> {
    win32::display_rect_at(at).ok().map(frame)
}
fn focused() -> Option<Frame> { win32::focused_frame().ok().map(frame) }

pub(super) fn build(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = tauri::WebviewWindowBuilder::new(app, super::super::GLOW_WINDOW,
        tauri::WebviewUrl::App("index.html?surface=glow".into()))
        .title(super::super::GLOW_TITLE)
        .inner_size(1.0, 1.0).position(0.0, 0.0)
        .transparent(true).decorations(false).always_on_top(true)
        .resizable(false).skip_taskbar(true).shadow(false)
        .focused(false).focusable(false).visible(false)
        .build().map_err(|_| "Windows glow could not be created")?;
    window.set_ignore_cursor_events(true).map_err(|_| "Windows glow cannot be click-through")?;
    // Webview transparency renders the existing visible rings. No alpha-zero native
    // transparency trick or affinity readback is treated as capture exclusion proof.
    Ok(window)
}

fn cover(window: &tauri::WebviewWindow, frame: Frame) -> Result<(), String> {
    if ![frame.x, frame.y, frame.width, frame.height].iter().all(|v| v.is_finite())
        || frame.width <= 0.0 || frame.height <= 0.0 {
        return Err("Windows glow geometry unavailable".into());
    }
    // Win32 provider geometry is GLOBAL PHYSICAL pixels, including negative origins.
    let position = tauri::PhysicalPosition::new(frame.x as i32, frame.y as i32);
    let size = tauri::PhysicalSize::new(frame.width as u32, frame.height as u32);
    // Move FIRST so a per-monitor DPI transition cannot rescale a size set on the
    // previous monitor. Refuse mismatched geometry instead of silently drawing elsewhere.
    window.set_position(position).map_err(|_| "Windows glow position unavailable")?;
    window.set_size(size).map_err(|_| "Windows glow size unavailable")?;
    if window.outer_position().map_err(|_| "Windows glow position unreadable")? != position
        || window.inner_size().map_err(|_| "Windows glow size unreadable")? != size {
        return Err("Windows glow did not retain the controlled display geometry".into());
    }
    Ok(())
}

fn logical(mut event: glow::GlowEvent, scale: f64) -> Result<glow::GlowEvent, String> {
    if !scale.is_finite() || scale <= 0.0 { return Err("Windows glow scale unavailable".into()); }
    // Provider events are physical monitor-local pixels; the WebView draws CSS pixels.
    event.x /= scale;
    event.y /= scale;
    event.to_x = event.to_x.map(|value| value / scale);
    event.to_y = event.to_y.map(|value| value / scale);
    event.width = event.width.map(|value| value / scale);
    event.height = event.height.map(|value| value / scale);
    Ok(event)
}

fn emit_working(app: &AppHandle, operation: u64, active: bool) -> Result<(), String> {
    app.emit_to(super::super::GLOW_WINDOW, WORKING_EVENT,
        WorkingEvent { active, operation_id: operation }).map_err(|_| "Windows working event unavailable".into())
}

pub(super) fn run(runtime: Arc<Runtime>, window: tauri::WebviewWindow,
    messages: std::sync::mpsc::Receiver<Overlay>) -> Result<(), String> {
    std::thread::Builder::new().name("computer-windows-glow".into()).spawn(move || {
        for message in messages {
            match message {
                Overlay::Session(_queued_active) => {
                    let rt = runtime.clone();
                    let window = window.clone();
                    if runtime.app.run_on_main_thread(move || {
                        // Never replay stale Session(true) after Stop. Capture owns its
                        // temporary suspension; no queued mark/session may show through it.
                        if rt.available() && rt.control.is_active(SystemClock.now_ms()) {
                            if !rt.capturing.load(Ordering::Acquire) {
                                if show_without_focus(&window).is_err() { rt.fail(); }
                                if !rt.available() || !rt.control.is_active(SystemClock.now_ms())
                                    || rt.capturing.load(Ordering::Acquire) { let _ = window.hide(); }
                            }
                        } else {
                            let _ = window.hide();
                            let operation = rt.operation.load(Ordering::Acquire);
                            if operation != 0 { let _ = emit_working(&rt.app, operation, false); }
                        }
                    }).is_err() { runtime.fail(); }
                }
                Overlay::Working { operation, reply } => {
                    // UIA/monitor work stays here, never on the UI/STA thread.
                    let geometry = win32::pointer_location().and_then(win32::display_rect_at).map(frame);
                    let rt = runtime.clone();
                    let window = window.clone();
                    let queued = runtime.app.run_on_main_thread(move || {
                        let result = (|| {
                            rt.require_operation()?;
                            if !rt.working.is_current(operation) || rt.capturing.load(Ordering::Acquire) {
                                return Err("Windows working operation already ended or capture is active".into());
                            }
                            rt.operation.store(operation, Ordering::Release);
                            cover(&window, geometry?)?;
                            show_without_focus(&window)?;
                            // Recheck after UI calls that may reenter the event loop.
                            if !rt.control.is_active(SystemClock.now_ms()) || !rt.working.is_current(operation) {
                                let _ = window.hide();
                                return Err("Windows working operation stopped".into());
                            }
                            emit_working(&rt.app, operation, true)
                        })();
                        let _ = reply.send(result);
                    });
                    if queued.is_err() { runtime.fail(); }
                }
                Overlay::WorkingEnd(operation) => {
                    let rt = runtime.clone();
                    if runtime.app.run_on_main_thread(move || {
                        // An old end cannot clear rings for a newer operation.
                        if rt.operation.load(Ordering::Acquire) == operation {
                            let _ = emit_working(&rt.app, operation, false);
                        }
                    }).is_err() { runtime.fail(); }
                }
                Overlay::Mark(mark) => {
                    if !runtime.control.is_active(SystemClock.now_ms()) { continue; }
                    let Some((geometry, event)) = glow::place(mark, display, focused) else { continue };
                    let rt = runtime.clone();
                    let window = window.clone();
                    if runtime.app.run_on_main_thread(move || {
                        if !rt.available() || !rt.control.is_active(SystemClock.now_ms())
                            || rt.capturing.load(Ordering::Acquire) || rt.working_operation() { return; }
                        // Marks are best effort. Never move active Working rings onto
                        // a different display just to highlight the focused element.
                        if cover(&window, geometry).and_then(|()| show_without_focus(&window)).is_err() {
                            rt.fail();
                            return;
                        }
                        if rt.available() && rt.control.is_active(SystemClock.now_ms())
                            && !rt.capturing.load(Ordering::Acquire) && !rt.working_operation() {
                            let scaled = window.scale_factor().map_err(|_| "Windows glow scale unreadable".into())
                                .and_then(|scale| logical(event, scale));
                            if let Ok(event) = scaled {
                                let _ = rt.app.emit_to(super::super::GLOW_WINDOW, super::super::GLOW_EVENT, event);
                            }
                        } else { let _ = window.hide(); }
                    }).is_err() { runtime.fail(); }
                }
            }
        }
        runtime.fail();
    }).map(|_| ()).map_err(|_| "Windows glow worker could not start".into())
}

// AUTHORED_UNEXECUTED: geometry conversion only; no native DPI/focus proof.
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_renderer_marks_convert_physical_pixels_to_css_pixels() {
        let event = glow::GlowEvent { kind: glow::GlowKind::Drag, x: 150.0, y: 300.0,
            to_x: Some(600.0), to_y: Some(450.0), width: Some(90.0), height: Some(120.0) };
        let value = logical(event, 1.5).unwrap();
        assert_eq!((value.x, value.y, value.to_x, value.to_y), (100.0, 200.0, Some(400.0), Some(300.0)));
        assert_eq!((value.width, value.height), (Some(60.0), Some(80.0)));
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] { assert!(logical(event, scale).is_err()); }
    }
    #[test]
    fn monitor_frames_keep_negative_physical_origins_without_logical_rescaling() {
        let value = frame(win32::PixelRect { x: -1920, y: -300, width: 1920, height: 1080 });
        assert_eq!((value.x, value.y, value.width, value.height), (-1920.0, -300.0, 1920.0, 1080.0));
    }
}
