//! The Windows desktop for computer control (S24 on Windows): input through `SendInput`, and
//! screenshots of the monitor under the pointer through GDI. Gentle Dot's own windows are
//! left out of captures by their display affinity (`WDA_EXCLUDEFROMCAPTURE`): the glow and the
//! dialogs always, the Dot and the panel while a session is active (Windows cannot leave a window
//! out of one capture only, and the user's own screenshots should still show them).
//!
//! Points are physical pixels of the virtual screen: the app is per-monitor DPI aware, so the
//! pointer, the monitors, and `SendInput` all use them.
//!
//! This is the input and capture part of the backend. Apps, UI Automation elements, and the
//! `Desktop` implementation come next; until then nothing outside this module calls it.

use super::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};
use super::encode::{bgra_to_jpeg, JPEG_QUALITY};
use super::winput::{checks_typing_target, releases, send_batches, settles, steps, Step, VirtualScreen};
use super::{Capture, InputEvent, MouseButton};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;
use std::time::Duration;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_TIMEOUT, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::DwmFlush;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC, GetMonitorInfoW, MonitorFromPoint,
    ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, EnumWindows, GetAncestor, GetCursorInfo, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo,
    GetIconInfo, GetSystemMetrics, GetWindowDisplayAffinity, GetWindowThreadProcessId, IsWindowVisible,
    SendMessageTimeoutW, SetWindowDisplayAffinity, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, GA_ROOT, GUITHREADINFO,
    ICONINFO, SMTO_ABORTIFHUNG, SM_CXCURSOR, SM_CXVIRTUALSCREEN, SM_CYCURSOR, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WM_NULL,
};

/// Pause between the events of one action, so apps see distinct presses (as on macOS).
const EVENT_GAP: Duration = Duration::from_millis(15);

/// How long the window in front may take to handle a key before the action stops (S4).
const CATCH_UP_MS: u32 = 2000;

const NOT_CAUGHT_UP: &str =
    "The app in front did not take the keys in time, so the rest was not sent. Take a screenshot to see what arrived.";

/// A monitor's rectangle in physical pixels of the virtual screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn virtual_screen() -> VirtualScreen {
    // SAFETY: plain queries.
    unsafe {
        VirtualScreen {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

pub fn pointer_location() -> Option<Point> {
    let mut at = POINT { x: 0, y: 0 };
    // SAFETY: `at` is a valid out-pointer.
    (unsafe { GetCursorPos(&mut at) } != 0).then(|| Point { x: f64::from(at.x), y: f64::from(at.y) })
}

/// The monitor showing `at`, or the nearest one.
pub fn monitor_at(at: Point) -> Option<MonitorFrame> {
    let point = POINT { x: at.x.round() as i32, y: at.y.round() as i32 };
    // SAFETY: plain query; `info` is a valid out-pointer whose size is set.
    unsafe {
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let RECT { left, top, right, bottom } = info.rcMonitor;
        Some(MonitorFrame { x: left, y: top, width: right - left, height: bottom - top })
    }
}

fn input(step: Step) -> INPUT {
    let mouse = |dx, dy, data: i32, flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as _, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let keyboard = |vk: u16, scan: u16, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    match step {
        Step::Move { x, y } => mouse(x, y, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
        Step::Button { button, down } => {
            let flags = match (button, down) {
                (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
            };
            mouse(0, 0, 0, flags)
        }
        Step::Wheel { horizontal, delta } => {
            mouse(0, 0, delta, if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL })
        }
        Step::Key { vk, down, extended } => {
            let mut flags = if down { 0 } else { KEYEVENTF_KEYUP };
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            keyboard(vk, 0, flags)
        }
        Step::Unicode { unit, down } => {
            keyboard(0, unit, KEYEVENTF_UNICODE | if down { 0 } else { KEYEVENTF_KEYUP })
        }
    }
}

fn send_batch(batch: &[Step]) -> Result<(), (usize, String)> {
    let records: Vec<INPUT> = batch.iter().copied().map(input).collect();
    // SAFETY: a contiguous array of valid INPUT records of the size passed.
    let sent = unsafe { SendInput(records.len() as u32, records.as_ptr(), size_of::<INPUT>() as i32) } as usize;
    if sent == records.len() {
        Ok(())
    } else {
        Err((sent, format!("Windows refused the input: {}", std::io::Error::last_os_error())))
    }
}

fn send(step: Step) -> Result<(), String> {
    send_batch(&[step]).map_err(|(_, error)| error)
}

/// Waits until the thread of the window in front handles messages again (S4). Keys queued while
/// it stalls reach it as other characters (a stalled Notepad turned "tres" into "eees"), so each
/// key waits for the previous one to be taken. A window that cannot be asked (another integrity
/// level) is not waited for; one that does not answer in time stops the action.
fn catch_up() -> Result<(), String> {
    // SAFETY: plain calls; `result` is a valid out-pointer.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return Ok(());
        }
        let mut result = 0;
        if SendMessageTimeoutW(window, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, CATCH_UP_MS, &mut result) == 0
            && GetLastError() == ERROR_TIMEOUT
        {
            return Err(NOT_CAUGHT_UP.into());
        }
    }
    Ok(())
}

/// The foreground root and the foreground thread's actual keyboard recipient. A failed query
/// is not a stable target, even when a later query also fails.
fn typing_windows() -> Option<(HWND, HWND)> {
    // SAFETY: plain queries; `info` is a valid out-pointer with its size set.
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return None;
        }
        let root = GetAncestor(foreground, GA_ROOT);
        let thread = GetWindowThreadProcessId(foreground, null_mut());
        let mut info: GUITHREADINFO = zeroed();
        info.cbSize = size_of::<GUITHREADINFO>() as u32;
        if root.is_null() || thread == 0 || GetGUIThreadInfo(thread, &mut info) == 0 {
            return None;
        }
        Some((root, info.hwndFocus))
    }
}

/// Posts `event` with a short gap between steps (surrogate pairs form one batch), waiting after
/// key releases or a complete pair for the window in front to take it. Text is bound to the
/// window in front and its keyboard focus when it starts, and stops when either changes. A
/// failure releases the keys and buttons left pressed by the successfully sent prefix before
/// reporting the error. Binding keys to the recipient the shared guard approved (`post_typed`)
/// needs the app identities of the apps part of this backend, so it comes with it.
pub fn post(event: &InputEvent) -> Result<(), String> {
    const CHANGED: &str = "The app receiving the keys changed while typing, so the rest was not sent.";
    let typing_target = matches!(event, InputEvent::Text(_)).then(typing_windows);
    let plan = steps(event, &virtual_screen())?;
    let mut done = 0;
    for batch in send_batches(&plan) {
        let changed = checks_typing_target(&batch[0])
            && typing_target.is_some_and(|target| target.is_none() || typing_windows() != target);
        let failed = if changed {
            Some((done, CHANGED.to_string()))
        } else {
            match send_batch(batch) {
                Err((sent, error)) => Some((done + sent, error)),
                Ok(()) => {
                    // No sleep or catch_up inside a surrogate pair's single SendInput call.
                    std::thread::sleep(EVENT_GAP);
                    if settles(batch.last().unwrap()) {
                        catch_up().err().map(|error| (done + batch.len(), error))
                    } else {
                        None
                    }
                }
            }
        };
        if let Some((sent, error)) = failed {
            for release in releases(&plan[..sent]) {
                let _ = send(release);
            }
            return Err(error);
        }
        done += batch.len();
    }
    Ok(())
}

/// The GDI objects of one capture, released in reverse whatever happens.
struct Canvas {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut c_void,
}

impl Canvas {
    /// A top-down 32-bit BGRA bitmap of `width × height`, selected into a memory context.
    fn new(width: u32, height: u32) -> Result<Canvas, String> {
        // SAFETY: GDI calls with valid arguments; every handle is checked and released by Drop.
        unsafe {
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("cannot read the screen".into());
            }
            let mut canvas = Canvas { screen, memory: null_mut(), bitmap: null_mut(), previous: null_mut(), bits: null_mut() };
            canvas.memory = CreateCompatibleDC(screen);
            if canvas.memory.is_null() {
                return Err("cannot prepare the screenshot".into());
            }
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                // Negative: rows top to bottom, as the JPEG encoder reads them.
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            canvas.bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &mut canvas.bits, null_mut(), 0);
            if canvas.bitmap.is_null() || canvas.bits.is_null() {
                return Err("cannot prepare the screenshot bitmap".into());
            }
            let previous = SelectObject(canvas.memory, canvas.bitmap);
            // HGDI_ERROR is -1; without the bitmap selected the pixels read would not be the capture.
            if previous.is_null() || previous as isize == -1 {
                return Err("cannot prepare the screenshot bitmap".into());
            }
            canvas.previous = previous;
            Ok(canvas)
        }
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        // SAFETY: each handle was created above and is released once.
        unsafe {
            if !self.previous.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            ReleaseDC(null_mut(), self.screen);
        }
    }
}

/// Draws the pointer where it is and at the screenshot's scale (macOS captures show it too).
fn draw_pointer(canvas: &Canvas, frame: MonitorFrame, width: u32, height: u32) {
    // SAFETY: `info` and `icon` are valid out-pointers; the icon's bitmaps are released.
    unsafe {
        let mut info: CURSORINFO = zeroed();
        info.cbSize = size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut info) == 0 || info.flags & CURSOR_SHOWING == 0 || info.hCursor.is_null() {
            return;
        }
        let mut icon: ICONINFO = zeroed();
        let (hot_x, hot_y) = if GetIconInfo(info.hCursor, &mut icon) != 0 {
            for bitmap in [icon.hbmMask, icon.hbmColor] {
                if !bitmap.is_null() {
                    DeleteObject(bitmap);
                }
            }
            (icon.xHotspot as i32, icon.yHotspot as i32)
        } else {
            (0, 0)
        };
        let scale = |offset: i32, length: i32, size: u32| (i64::from(offset) * i64::from(size) / i64::from(length.max(1))) as i32;
        let (cursor_w, cursor_h) = (GetSystemMetrics(SM_CXCURSOR), GetSystemMetrics(SM_CYCURSOR));
        let (draw_w, draw_h) = (scale(cursor_w, frame.width, width).max(1), scale(cursor_h, frame.height, height).max(1));
        let x = scale(info.ptScreenPos.x - frame.x, frame.width, width) - scale(hot_x, frame.width, width);
        let y = scale(info.ptScreenPos.y - frame.y, frame.height, height) - scale(hot_y, frame.height, height);
        DrawIconEx(canvas.memory, x, y, info.hCursor, draw_w, draw_h, 0, null_mut(), DI_NORMAL);
    }
}

/// A screenshot of the monitor under the pointer, downscaled to `MAX_LONG_EDGE`, Gentle Dot's
/// windows excluded.
pub fn capture() -> Result<Capture, String> {
    exclude_own_windows()?;
    let pointer = pointer_location().ok_or("cannot read the pointer position")?;
    let frame = monitor_at(pointer).ok_or("no display under the pointer")?;
    if frame.width <= 0 || frame.height <= 0 {
        return Err("the display under the pointer has no size".into());
    }
    let (width, height) = fit_long_edge(frame.width as u32, frame.height as u32, MAX_LONG_EDGE);
    let canvas = Canvas::new(width, height)?;
    // SAFETY: both contexts are valid; the bitmap holds `width × height` 32-bit pixels.
    let bytes = unsafe {
        SetStretchBltMode(canvas.memory, HALFTONE);
        SetBrushOrgEx(canvas.memory, 0, 0, null_mut());
        let copied = StretchBlt(
            canvas.memory, 0, 0, width as i32, height as i32,
            canvas.screen, frame.x, frame.y, frame.width, frame.height,
            SRCCOPY | CAPTUREBLT,
        );
        if copied == 0 {
            return Err(format!("cannot take the screenshot: {}", std::io::Error::last_os_error()));
        }
        draw_pointer(&canvas, frame, width, height);
        GdiFlush();
        std::slice::from_raw_parts(canvas.bits as *const u8, width as usize * height as usize * 4).to_vec()
    };
    drop(canvas);
    let data = bgra_to_jpeg(&bytes, width, height, width as usize * 4, JPEG_QUALITY)?;
    let origin = Point { x: f64::from(frame.x), y: f64::from(frame.y) };
    let geometry = ScreenshotGeometry::for_display(origin, f64::from(frame.width), width, height);
    Ok(Capture { data, mime_type: "image/jpeg", geometry })
}

/// The process that created `hwnd`, or 0.
fn window_pid(hwnd: HWND) -> i32 {
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out-pointer.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid as i32
}

/// Keeps a window out of every screenshot and screen capture, this helper's included.
pub fn exclude_from_capture(hwnd: *mut c_void) -> Result<(), String> {
    set_capture_excluded(hwnd, true)
}

/// Makes sure no visible window of this process shows in the capture about to be taken: the
/// session's own exclusion is applied later on the main thread, so it is not relied on here. A
/// window newly excluded is out of the picture after the next composition (`DwmFlush`).
fn exclude_own_windows() -> Result<(), String> {
    unsafe extern "system" fn collect(hwnd: HWND, state: LPARAM) -> i32 {
        // SAFETY: `state` is the vector passed below, alive for the whole enumeration.
        unsafe { (*(state as *mut Vec<HWND>)).push(hwnd) };
        1
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only appends to `handles`, which outlives the call.
    unsafe { EnumWindows(Some(collect), &mut handles as *mut Vec<HWND> as LPARAM) };
    let own = std::process::id() as i32;
    let mut changed = false;
    for hwnd in handles {
        // SAFETY: plain queries on a window handle (a vanished window just reads as hidden).
        if window_pid(hwnd) != own || unsafe { IsWindowVisible(hwnd) } == 0 {
            continue;
        }
        let mut affinity = 0u32;
        // SAFETY: `affinity` is a valid out-pointer.
        if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) } == 0 || affinity != WDA_EXCLUDEFROMCAPTURE {
            set_capture_excluded(hwnd, true).map_err(|e| format!("Gentle Dot's window would show in the screenshot: {e}"))?;
            changed = true;
        }
    }
    if changed {
        // SAFETY: a plain call; it waits for the next composition.
        unsafe { DwmFlush() };
    }
    Ok(())
}

/// Leaves a window of this process out of screenshots, or lets it show in them again.
pub fn set_capture_excluded(hwnd: *mut c_void, excluded: bool) -> Result<(), String> {
    let affinity = if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    // SAFETY: a plain call on a window handle of this process.
    if unsafe { SetWindowDisplayAffinity(hwnd, affinity) } != 0 {
        Ok(())
    } else {
        Err(format!("cannot change whether it shows in screenshots: {}", std::io::Error::last_os_error()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn per_monitor_aware() {
        use windows_sys::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        // SAFETY: plain call; the app itself is already per-monitor aware.
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    }

    #[test]
    fn each_step_becomes_the_input_record_windows_expects() {
        let mouse = |step| {
            let record = input(step);
            assert_eq!(record.r#type, INPUT_MOUSE);
            // SAFETY: `input` wrote the mouse member for a mouse step.
            let mi = unsafe { record.Anonymous.mi };
            (mi.dx, mi.dy, mi.mouseData as i32, mi.dwFlags)
        };
        let keyboard = |step| {
            let record = input(step);
            assert_eq!(record.r#type, INPUT_KEYBOARD);
            // SAFETY: `input` wrote the keyboard member for a key step.
            let ki = unsafe { record.Anonymous.ki };
            (ki.wVk, ki.wScan, ki.dwFlags)
        };
        assert_eq!(
            mouse(Step::Move { x: 10, y: 65535 }),
            (10, 65535, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
        );
        assert_eq!(mouse(Step::Button { button: MouseButton::Left, down: true }), (0, 0, 0, MOUSEEVENTF_LEFTDOWN));
        assert_eq!(mouse(Step::Button { button: MouseButton::Left, down: false }), (0, 0, 0, MOUSEEVENTF_LEFTUP));
        assert_eq!(mouse(Step::Button { button: MouseButton::Right, down: true }), (0, 0, 0, MOUSEEVENTF_RIGHTDOWN));
        assert_eq!(mouse(Step::Button { button: MouseButton::Right, down: false }), (0, 0, 0, MOUSEEVENTF_RIGHTUP));
        assert_eq!(mouse(Step::Wheel { horizontal: false, delta: -240 }), (0, 0, -240, MOUSEEVENTF_WHEEL));
        assert_eq!(mouse(Step::Wheel { horizontal: true, delta: 120 }), (0, 0, 120, MOUSEEVENTF_HWHEEL));
        assert_eq!(keyboard(Step::Key { vk: 0x41, down: true, extended: false }), (0x41, 0, 0));
        assert_eq!(
            keyboard(Step::Key { vk: 0x25, down: false, extended: true }),
            (0x25, 0, KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY)
        );
        assert_eq!(keyboard(Step::Unicode { unit: 0xD83E, down: true }), (0, 0xD83E, KEYEVENTF_UNICODE));
        assert_eq!(
            keyboard(Step::Unicode { unit: 0xDD80, down: false }),
            (0, 0xDD80, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        );
    }

    #[test]
    #[ignore = "interactive Windows desktop: run in the user's own session"]
    fn a_screenshot_is_a_jpeg_of_the_monitor_under_the_pointer() {
        per_monitor_aware();
        let capture = capture().unwrap();
        let frame = monitor_at(pointer_location().unwrap()).unwrap();
        let image = image::load_from_memory_with_format(&capture.data, image::ImageFormat::Jpeg).unwrap().to_rgb8();
        assert_eq!((image.width(), image.height()), (capture.geometry.image_width, capture.geometry.image_height));
        assert!(image.width().max(image.height()) <= MAX_LONG_EDGE);
        assert_eq!(capture.geometry.origin, Point { x: f64::from(frame.x), y: f64::from(frame.y) });
        let first = *image.get_pixel(0, 0);
        assert!(image.pixels().any(|p| *p != first), "a real desktop is not one flat color");
    }

    #[test]
    #[ignore = "interactive Windows desktop: run in the user's own session"]
    fn a_move_lands_on_the_pixel_asked_for_and_the_pointer_is_put_back() {
        per_monitor_aware();
        let start = pointer_location().unwrap();
        let frame = monitor_at(start).unwrap();
        let target = Point { x: f64::from(frame.x + frame.width / 3), y: f64::from(frame.y + frame.height / 3) };
        post(&InputEvent::Move(target)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let landed = pointer_location().unwrap();
        post(&InputEvent::Move(start)).unwrap();
        assert!((landed.x - target.x).abs() <= 1.0 && (landed.y - target.y).abs() <= 1.0, "{landed:?} != {target:?}");
    }
