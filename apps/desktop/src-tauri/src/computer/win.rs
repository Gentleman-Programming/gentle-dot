//! Consumed Windows shell/alert capture fences and call-affinity recovery only.
//! The active Desktop, input and capture implementation is `win32`, not this module.
use super::ScreenshotsUnsupported;
use std::{ffi::c_void, ptr::null_mut, sync::atomic::{AtomicU64, AtomicUsize, Ordering}};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowDisplayAffinity, SetWindowDisplayAffinity,
    ShowWindow, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
const OWN_WINDOW_SHOWN: &str = "Gentle Dot's window could show in the screenshot, so it was not taken. Take another.";
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }

/// How many changes of this process's windows began or ended: one shown or hidden, let show in
/// captures again, or a dialog that could not be kept out of them, for its whole life.
static OWN_WINDOW_CHANGES: AtomicU64 = AtomicU64::new(0);
/// How many such changes are under way.
static OWN_WINDOWS_CHANGING: AtomicUsize = AtomicUsize::new(0);

const OWN_WINDOW_BUSY: &str =
    "A Gentle Dot window is opening, closing, or waiting for you, so no screenshot was taken. Take another in a moment.";

/// A change of this process's windows under way, from before it starts until after it ends (when
/// dropped). A capture that overlaps one in any way is not returned: either one is under way when
/// it starts, or the count moved by the time it ends. The order matters: a change is marked under
/// way before it is counted, and counted before it is no longer under way; a capture reads the
/// count before what is under way when it starts, and the other way round when it ends.
#[must_use]
pub(crate) struct WindowChange(());

impl WindowChange {
    pub(crate) fn begin() -> WindowChange {
        OWN_WINDOWS_CHANGING.fetch_add(1, Ordering::SeqCst);
        OWN_WINDOW_CHANGES.fetch_add(1, Ordering::SeqCst);
        WindowChange(())
    }
}

impl Drop for WindowChange {
    fn drop(&mut self) {
        OWN_WINDOW_CHANGES.fetch_add(1, Ordering::SeqCst);
        OWN_WINDOWS_CHANGING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The count a capture compares with when it ends, or why it cannot start.
pub(super) fn capture_baseline() -> Result<u64, String> {
    let changes = OWN_WINDOW_CHANGES.load(Ordering::SeqCst);
    if OWN_WINDOWS_CHANGING.load(Ordering::SeqCst) > 0 {
        return Err(OWN_WINDOW_BUSY.into());
    }
    Ok(changes)
}

/// Whether no change of our windows overlapped the capture that started at `baseline`.
pub(super) fn unchanged_since(baseline: u64) -> bool {
    OWN_WINDOWS_CHANGING.load(Ordering::SeqCst) == 0 && OWN_WINDOW_CHANGES.load(Ordering::SeqCst) == baseline
}

/// Leaves a window of this process out of screenshots, or lets it show in them again.
pub fn set_capture_excluded(hwnd: *mut c_void, excluded: bool) -> Result<(), String> {
    let affinity = if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    // Letting a window show again is a change a capture under way must see, whatever its result.
    let _change = (!excluded).then(WindowChange::begin);
    // SAFETY: a plain call on a window handle of this process.
    if unsafe { SetWindowDisplayAffinity(hwnd, affinity) } != 0 {
        Ok(())
    } else {
        Err(format!("cannot change whether it shows in screenshots: {}", std::io::Error::last_os_error()))
    }
}

// Main-thread show/hide callers serialize these entries. Keep the original value, including
// WDA_MONITOR, rather than assuming every window started at WDA_NONE. Showing releases an entry;
// the owning call's restore phase releases its remainder, including a user-hidden Dot.
// A newer hide takes ownership without losing the original affinity; delayed older restores
// cannot release it. Failed dispatch restores affinity directly without showing the window.
// If native restoration fails, owner None retains the original for the next show (after showing)
// or hide (adopt, never read the still-excluded value). Logical keys bound this to one record
// per Dot/panel for the process lifetime, never per recyclable HWND or failed call.
static CALL_AFFINITIES: std::sync::Mutex<Vec<(Option<u64>, (super::working::Part, u32))>> = std::sync::Mutex::new(Vec::new());
// The Dot and panel are created once and live until process exit. Record their handles on
// the main thread at creation; worker cleanup must never query Tauri while holding our lock.
static CALL_DOT: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
static CALL_PANEL: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

// An exhaustive match, so a new Part fails to compile here instead of indexing out of bounds.
fn call_slot(part: super::working::Part) -> &'static std::sync::OnceLock<usize> {
    match part {
        super::working::Part::Dot => &CALL_DOT,
        super::working::Part::Panel => &CALL_PANEL,
    }
}

// Strict on purpose: ignoring a second creation would keep the old handle, so calls would hide
// and exclude a window that no longer exists while the new one stays in screenshots.
pub fn record_call_window(part: super::working::Part, hwnd: HWND) {
    call_slot(part).set(hwnd as usize).expect("call window is created only once");
}

fn call_window(part: super::working::Part) -> Option<usize> {
    call_slot(part).get().copied()
}

fn call_handles() -> super::capture_order::CallHandles {
    super::capture_order::CallHandles {
        dot: call_window(super::working::Part::Dot),
        panel: call_window(super::working::Part::Panel),
    }
}

/// Exclude before hiding. If exclusion fails, still hide, then put this window back and fail
/// preparation: Working has not yet recorded it as hidden and cannot restore it on that error.
/// The failed call therefore never reaches capture, and no persistent failure poisons later calls.
pub fn hide_for_call(part: super::working::Part, operation: u64) -> Result<(), String> {
    let hwnd = call_window(part).ok_or_else(|| format!("window {part:?} is missing"))? as HWND;
    let _change = WindowChange::begin();
    let mut saved = CALL_AFFINITIES.lock().unwrap_or_else(|error| error.into_inner());
    let result = super::capture_order::hide(|| {
        if let Some((owner, _)) = saved.iter_mut().find(|(_, (window, _))| *window == part) {
            set_capture_excluded(hwnd, true)?;
            *owner = Some(operation);
            return Ok(());
        }
        let mut previous = 0;
        // SAFETY: a query on our window with a valid out-pointer.
        if unsafe { GetWindowDisplayAffinity(hwnd, &mut previous) } == 0 {
            return Err(format!("cannot read its capture affinity: {}", std::io::Error::last_os_error()));
        }
        set_capture_excluded(hwnd, true)?;
        saved.push((Some(operation), (part, previous)));
        Ok(())
    }, || {
        // SAFETY: a call on this process's window.
        unsafe { ShowWindow(hwnd, SW_HIDE) };
    });
    drop(saved);
    if let Err(error) = result {
        show_without_activating(hwnd);
        return Err(format!("{OWN_WINDOW_SHOWN} {error}"));
    }
    Ok(())
}

fn restore_call_affinity(hwnd: HWND) {
    let mut saved = CALL_AFFINITIES.lock().unwrap_or_else(|error| error.into_inner());
    let Some(index) = super::capture_order::current_window(&saved, hwnd as usize, call_handles()) else { return };
    let previous = saved[index].1.1;
    // This function is called only inside the showing WindowChange, after ShowWindow. Restoring
    // even a nonzero affinity must count as a change, so an overlapping capture cannot be accepted.
    // SAFETY: a call on this process's window, restoring the value read before the call.
    if unsafe { SetWindowDisplayAffinity(hwnd, previous) } != 0 {
        saved.remove(index);
    } else {
        eprintln!("gentle-dot: a window may stay out of screenshots: {}", std::io::Error::last_os_error());
    }
}

/// End the serialized call's affinity ownership after its eligible windows have been shown.
/// Remaining windows were left hidden by the user (or their show/affinity restore failed).
/// Read the recorded handles only; native failures retain ownerless recovery values.
pub fn finish_call_affinities(operation: u64) {
    let _change = WindowChange::begin();
    let mut saved = CALL_AFFINITIES.lock().unwrap_or_else(|error| error.into_inner());
    super::capture_order::release(&mut saved, operation, |(part, previous)| {
        let Some(hwnd) = call_window(part) else { return true };
        // SAFETY: the current handle of our logical window. This API requires process
        // ownership, not the window's thread, so dispatch failure can restore it directly.
        let restored = unsafe { SetWindowDisplayAffinity(hwnd as HWND, previous) } != 0;
        if !restored {
            eprintln!("gentle-dot: a window may stay out of screenshots: {}", std::io::Error::last_os_error());
        }
        restored
    });
}

/// Main-thread dispatch failed: leave windows hidden but restore their original affinity
/// inside WindowChange. The owner filter protects a newer hide; failures keep recovery values.
pub fn abandon_call_affinities(operation: u64) {
    finish_call_affinities(operation);
}

pub fn show_without_activating(hwnd: *mut c_void) {
    let _change = WindowChange::begin();
    super::capture_order::show(|| {
        // SAFETY: a call on this process's window.
        unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    }, || restore_call_affinity(hwnd));
}

pub fn hide_window(hwnd: *mut c_void) {
    let _change = WindowChange::begin();
    // SAFETY: a call on this process's window.
    unsafe { ShowWindow(hwnd, SW_HIDE) };
}

pub fn show_window(hwnd: *mut c_void) {
    let _change = WindowChange::begin();
    super::capture_order::show(|| {
        // SAFETY: a call on this process's window.
        unsafe { ShowWindow(hwnd, SW_SHOW) };
    }, || restore_call_affinity(hwnd));
}

/// The first build that can leave a window out of captures (`WDA_EXCLUDEFROMCAPTURE`): Windows
/// 10 version 2004.
const CAPTURE_EXCLUSION_BUILD: u32 = 19041;

/// This system's build number. The registry says it as it is; `GetVersionEx` answers what the
/// app's manifest names.
fn windows_build() -> Option<u32> {
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let value = wide("CurrentBuildNumber");
    let mut buffer = vec![0u16; 64];
    let mut bytes = (buffer.len() * 2) as u32;
    // SAFETY: the buffer's size in bytes is passed and updated.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, null_mut(),
            buffer.as_mut_ptr() as *mut c_void, &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    let units = &buffer[..(bytes as usize / 2).min(buffer.len())];
    String::from_utf16_lossy(units).trim_end_matches('\0').trim().parse().ok()
}

/// Why screenshots cannot leave Gentle Dot's windows out, or `None` when they can. A build that
/// cannot be read counts as unable too: before Windows 10 version 2004 the exclusion does not
/// fail, it just leaves a black box (`WDA_MONITOR`), so a failed exclusion cannot be relied on to
/// say so.
fn capture_exclusion_unsupported(build: Option<u32>) -> Option<ScreenshotsUnsupported> {
    match build {
        None => Some(ScreenshotsUnsupported::UnknownVersion),
        Some(build) if build < CAPTURE_EXCLUSION_BUILD => Some(ScreenshotsUnsupported::TooOld),
        Some(_) => None,
    }
}

pub(super) fn capture_exclusion_reason() -> Option<ScreenshotsUnsupported> {
    capture_exclusion_unsupported(windows_build())
}
pub(super) fn capture_exclusion_supported() -> bool {
    capture_exclusion_reason().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Retain the target's build-boundary contract without probing this machine or
    // constructing the removed alternative Desktop implementation.
    #[test]
    fn screenshots_need_windows_10_2004() {
        assert_eq!(capture_exclusion_unsupported(Some(19040)), Some(ScreenshotsUnsupported::TooOld));
        assert_eq!(capture_exclusion_unsupported(Some(19041)), None);
        assert_eq!(capture_exclusion_unsupported(Some(26100)), None);
        assert_eq!(capture_exclusion_unsupported(None), Some(ScreenshotsUnsupported::UnknownVersion));
    }

    #[test]
    fn a_capture_our_window_could_show_in_says_so() {
        assert_eq!(OWN_WINDOW_SHOWN, "Gentle Dot's window could show in the screenshot, so it was not taken. Take another.");
    }

    // Retained helper fences only: no capture, desktop input or real HWND. The
    // removed backend's restore_affinity route is now the consumed call finalizer.
    #[test]
    fn captures_notice_windows_changed_meanwhile() {
        let change = WindowChange::begin();
        assert_eq!(capture_baseline(), Err(OWN_WINDOW_BUSY.to_string()));
        drop(change);
        let baseline = capture_baseline().expect("nothing under way");
        drop(WindowChange::begin());
        assert!(!unchanged_since(baseline));
        let baseline = capture_baseline().expect("nothing under way");
        let change = WindowChange::begin();
        assert!(!unchanged_since(baseline));
        drop(change);
        let routes: [(&str, &dyn Fn()); 5] = [
            ("let show again", &|| { let _ = set_capture_excluded(null_mut(), false); }),
            ("call restoration", &|| finish_call_affinities(u64::MAX)),
            ("shown", &|| show_window(null_mut())),
            ("shown without activation", &|| show_without_activating(null_mut())),
            ("hidden", &|| hide_window(null_mut())),
        ];
        for (what, route) in routes {
            let baseline = capture_baseline().expect("nothing under way");
            route();
            assert!(!unchanged_since(baseline), "{what}");
            assert!(capture_baseline().is_ok(), "{what} ended");
        }
        let baseline = capture_baseline().expect("nothing under way");
        let _ = set_capture_excluded(null_mut(), true);
        assert!(unchanged_since(baseline));
    }
}
