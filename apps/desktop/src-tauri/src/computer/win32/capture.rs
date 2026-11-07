//! Monitor-under-pointer capture. No files, diagnostic pixels or global DPI changes.
use std::mem::size_of;
use windows::Win32::{Foundation::{GetLastError, POINT}, Graphics::{
    Dwm::{DwmFlush, DwmIsCompositionEnabled}, Gdi::*}, UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN}};
use super::{context::{error, point, Dpi, PixelRect}, identity, OwnWindows,
    super::{win, Capture, coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE},
        encode::{bgra_to_jpeg, JPEG_QUALITY}}};

const MAX_BITMAP_BYTES: usize = 64 * 1024 * 1024;

pub(super) fn composition_available() -> bool {
    // Both compositor availability and real exclusion support are required. A
    // missing build must not turn old WDA_MONITOR semantics into capture support.
    win::capture_exclusion_supported()
        && unsafe { DwmIsCompositionEnabled() }.is_ok_and(|value| value.as_bool())
}

pub fn pointer_location() -> Result<Point, String> {
    let _dpi = Dpi::enter()?;
    identity::normal_desktop()?;
    let mut at = POINT::default();
    unsafe { GetCursorPos(&mut at) }.map_err(|e| error("pointer query", e))?;
    Ok(Point { x: at.x as f64, y: at.y as f64 })
}

fn monitor_at(at: Point) -> Result<PixelRect, String> {
    let at = point(at)?;
    let monitor = unsafe { MonitorFromPoint(at, MONITOR_DEFAULTTONULL) };
    if monitor.0.is_null() { return Err("no monitor at physical coordinate".into()); }
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return Err(format!("monitor metadata unavailable (Win32 {})", unsafe { GetLastError() }.0));
    }
    let rect = PixelRect::from_rect(info.rcMonitor)?;
    if !rect.contains(at) { return Err("physical coordinate lies in a monitor gap".into()); }
    Ok(rect)
}

pub fn display_rect_at(at: Point) -> Result<PixelRect, String> {
    let _dpi = Dpi::enter()?;
    identity::normal_desktop()?;
    monitor_at(at)
}

pub(super) fn virtual_rect() -> Result<PixelRect, String> {
    // SAFETY: called inside scoped physical-pixel DPI context.
    let rect = unsafe { PixelRect { x: GetSystemMetrics(SM_XVIRTUALSCREEN),
        y: GetSystemMetrics(SM_YVIRTUALSCREEN), width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
        height: GetSystemMetrics(SM_CYVIRTUALSCREEN) } };
    if rect.width < 2 || rect.height < 2 { return Err("invalid virtual desktop geometry".into()); }
    Ok(rect)
}

fn bitmap_length(width: i32, height: i32) -> Result<usize, String> {
    if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
        return Err("monitor dimensions exceed capture limits".into());
    }
    (width as usize).checked_mul(height as usize).and_then(|pixels| pixels.checked_mul(4))
        .filter(|bytes| *bytes <= MAX_BITMAP_BYTES).ok_or_else(|| "monitor bitmap exceeds 64 MiB".into())
}

/// All native resources stay on the current thread and are released on every error.
struct BitmapDc {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: Option<HGDIOBJ>,
}
impl BitmapDc {
    fn new(width: i32, height: i32) -> Result<Self, String> {
        let mut dc = Self { screen: HDC::default(), memory: HDC::default(), bitmap: HBITMAP::default(), previous: None };
        dc.screen = unsafe { GetDC(None) };
        if dc.screen.is_invalid() { return Err("screen DC unavailable".into()); }
        dc.memory = unsafe { CreateCompatibleDC(Some(dc.screen)) };
        if dc.memory.is_invalid() { return Err("capture DC unavailable".into()); }
        dc.bitmap = unsafe { CreateCompatibleBitmap(dc.screen, width, height) };
        if dc.bitmap.is_invalid() { return Err("capture bitmap allocation failed".into()); }
        let previous = unsafe { SelectObject(dc.memory, HGDIOBJ(dc.bitmap.0)) };
        if previous.is_invalid() { return Err("capture bitmap selection failed".into()); }
        dc.previous = Some(previous);
        Ok(dc)
    }
    fn deselect(&mut self) -> Result<(), String> {
        if let Some(previous) = self.previous {
            let replaced = unsafe { SelectObject(self.memory, previous) };
            if replaced.is_invalid() { return Err("capture bitmap deselection failed".into()); }
            self.previous = None;
        }
        Ok(())
    }
}
impl Drop for BitmapDc {
    fn drop(&mut self) {
        // SAFETY: each handle is locally owned; restore original selection before
        // deletion. DeleteDC before DeleteObject also breaks selection on error paths.
        if let Some(previous) = self.previous.take() { unsafe { SelectObject(self.memory, previous) }; }
        if !self.memory.is_invalid() { let _ = unsafe { DeleteDC(self.memory) }; }
        if !self.bitmap.is_invalid() { let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) }; }
        if !self.screen.is_invalid() { unsafe { ReleaseDC(None, self.screen) }; }
    }
}

pub(super) fn capture(own: &OwnWindows) -> Result<Capture, String> {
    // alert::WindowChange also covers a dialog that opens AND closes between our
    // visibility fences. Keep all existing hidden-window checks as well.
    let baseline = win::capture_baseline()?;
    let _dpi = Dpi::enter()?;
    identity::normal_desktop()?;
    own.verify_capture_hidden()?;
    if !composition_available() { return Err("desktop composition unavailable".into()); }
    // SAFETY: one native compositor barrier, not a retry/sleep loop. Its underlying
    // driver latency is not a cancellation guarantee; T3 must keep preparation alive.
    unsafe { DwmFlush() }.map_err(|e| error("capture composition barrier", e))?;
    own.verify_capture_hidden()?;
    let frame = monitor_at(pointer_location()?)?;
    let length = bitmap_length(frame.width, frame.height)?;
    let mut dc = BitmapDc::new(frame.width, frame.height)?;
    unsafe { BitBlt(dc.memory, 0, 0, frame.width, frame.height, Some(dc.screen),
        frame.x, frame.y, SRCCOPY | CAPTUREBLT) }.map_err(|e| error("screen copy", e))?;
    // GetDIBits requires that the bitmap NOT be selected into a DC.
    dc.deselect()?;
    let mut pixels = vec![0u8; length];
    let mut info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: frame.width,
        biHeight: -frame.height, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0,
        biSizeImage: length as u32, ..Default::default()
    }, ..Default::default() };
    // SAFETY: top-down 32-bit uncompressed BGRX, checked full output allocation. Alpha
    // is ignored by the existing BGRA encoder, so undefined GDI X bytes are never used.
    let lines = unsafe { GetDIBits(dc.screen, dc.bitmap, 0, frame.height as u32,
        Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS) };
    if lines != frame.height { return Err(format!("screen readback returned {lines}/{} rows", frame.height)); }
    own.verify_capture_hidden()?;
    identity::normal_desktop()?;
    let (width, height) = fit_long_edge(frame.width as u32, frame.height as u32, MAX_LONG_EDGE);
    // GDI's fourth channel is undefined. Make it opaque before any RGBA resampling;
    // no alpha-aware filter may turn valid RGB into dark/transparent pixels.
    for pixel in pixels.chunks_exact_mut(4) { pixel[3] = 255; }
    let source = image::RgbaImage::from_raw(frame.width as u32, frame.height as u32, pixels)
        .ok_or("invalid capture pixel allocation")?;
    // Resize treats the four components independently: BGRX stays BGRX.
    let resized = image::imageops::resize(&source, width, height, image::imageops::FilterType::Triangle);
    let data = bgra_to_jpeg(resized.as_raw(), width, height, width as usize * 4, JPEG_QUALITY)?;
    own.verify_capture_hidden()?;
    if !win::unchanged_since(baseline) {
        return Err("A Gentle Dot window changed during capture; screenshot discarded.".into());
    }
    Ok(Capture { data, mime_type: "image/jpeg", geometry: ScreenshotGeometry::for_display(
        Point { x: frame.x as f64, y: frame.y as f64 }, frame.width as f64, width, height) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_limits_are_checked_before_gdi() {
        assert_eq!(bitmap_length(1920, 1080).unwrap(), 1920 * 1080 * 4);
        assert!(bitmap_length(-1, 1080).is_err());
        assert!(bitmap_length(16384, 16384).is_err());
        assert!(bitmap_length(i32::MAX, i32::MAX).is_err());
    }
}
