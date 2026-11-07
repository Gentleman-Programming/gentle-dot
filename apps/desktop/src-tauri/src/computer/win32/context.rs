//! Current-thread native context. No process-wide DPI policy or COM interface handoff.
use std::{marker::PhantomData, rc::Rc};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND, POINT},
    UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
};
use super::super::coords::Point;

pub(super) fn error(operation: &str, error: windows::core::Error) -> String {
    // Never format a provider's message: it may contain labels or process paths.
    format!("{operation} failed (HRESULT 0x{:08x})", error.code().0 as u32)
}

pub(super) struct Dpi {
    previous: DPI_AWARENESS_CONTEXT,
    _thread: PhantomData<Rc<()>>,
}
impl Dpi {
    pub fn enter() -> Result<Self, String> {
        // SAFETY: thread-local policy, restored on this same thread by Drop.
        let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err("per-monitor physical-pixel DPI context unavailable".into());
        }
        Ok(Self { previous, _thread: PhantomData })
    }
}
impl Drop for Dpi {
    fn drop(&mut self) {
        // SAFETY: saved by a successful enter; this guard cannot cross threads.
        unsafe { SetThreadDpiAwarenessContext(self.previous) };
    }
}

pub(super) struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: only constructed for a successfully opened owned kernel handle.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub(super) fn hwnd(value: usize) -> HWND {
    HWND(value as *mut core::ffi::c_void)
}

pub(super) fn point(at: Point) -> Result<POINT, String> {
    fn coordinate(n: f64) -> Result<i32, String> {
        if !n.is_finite() || n.round() < i32::MIN as f64 || n.round() > i32::MAX as f64 {
            return Err("coordinates must be finite physical pixels in the i32 range".into());
        }
        Ok(n.round() as i32)
    }
    Ok(POINT { x: coordinate(at.x)?, y: coordinate(at.y)? })
}

/// A rectangle in global physical pixels; negative monitor origins are valid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl PixelRect {
    pub(super) fn from_rect(rect: windows::Win32::Foundation::RECT) -> Result<Self, String> {
        let width = rect.right.checked_sub(rect.left).filter(|n| *n > 0);
        let height = rect.bottom.checked_sub(rect.top).filter(|n| *n > 0);
        Ok(Self { x: rect.left, y: rect.top,
            width: width.ok_or("invalid native rectangle width")?,
            height: height.ok_or("invalid native rectangle height")? })
    }
    pub(super) fn contains(&self, at: POINT) -> bool {
        let (x, y) = (i64::from(at.x) - i64::from(self.x), i64::from(at.y) - i64::from(self.y));
        x >= 0 && y >= 0 && x < i64::from(self.width) && y < i64::from(self.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coordinates_reject_nonfinite_and_overflow_but_keep_negative_origins() {
        assert!(point(Point { x: f64::NAN, y: 1.0 }).is_err());
        assert!(point(Point { x: i32::MAX as f64 + 1.0, y: 1.0 }).is_err());
        assert_eq!(point(Point { x: -1919.6, y: -300.0 }).unwrap().x, -1920);
    }
}
