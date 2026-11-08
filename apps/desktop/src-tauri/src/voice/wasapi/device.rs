//! The Win32 half of the Windows microphone: COM, the default capture endpoint, and its packets.

use super::format::{Converter, MixFormat, WAVEFORMATEX_BYTES};
use super::open_error;
use crate::voice::capture_thread::{failed_to_start, launch, pump, Ready};
use crate::voice::{Authorization, Microphone, Sink, Stream, VoiceError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// The shared-mode buffer, in 100 ns units: 200 ms.
const BUFFER_DURATION: i64 = 2_000_000;
/// How often the capture thread looks for packets; well inside the buffer.
const POLL: Duration = Duration::from_millis(10);
/// How long `open` waits for the capture thread to start the device.
const OPEN_WAIT: Duration = Duration::from_secs(5);

pub struct WindowsMicrophone;

impl Microphone for WindowsMicrophone {
    fn authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn request_authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        let stream = launch(move |closed, ready| capture(sink, closed, ready), OPEN_WAIT)?;
        Ok(Box::new(stream))
    }
}

fn windows_error(error: windows::core::Error) -> VoiceError {
    open_error(error.code().0 as u32, &error.message())
}

/// Ends COM on the capture thread, after the COM objects it owns are released.
struct Com;

impl Drop for Com {
    fn drop(&mut self) {
        // SAFETY: built only after CoInitializeEx succeeded on this thread, and dropped on it
        // after the COM interfaces declared later in `capture` were released.
        unsafe { CoUninitialize() };
    }
}

/// The mix format `GetMixFormat` allocated, freed with the COM allocator.
struct MixFormatMemory(*mut WAVEFORMATEX);

impl MixFormatMemory {
    /// The `WAVEFORMATEX`, and for `WAVE_FORMAT_EXTENSIBLE` the `cbSize` bytes after it.
    fn bytes(&self) -> &[u8] {
        // SAFETY: GetMixFormat returned a valid WAVEFORMATEX, at least its 18 bytes, in an
        // allocation that lives until this guard is dropped. Windows ignores `cbSize` for other
        // tags, so only an extensible format's `cbSize` bytes are read after the header.
        unsafe {
            let header = std::slice::from_raw_parts(self.0 as *const u8, WAVEFORMATEX_BYTES);
            if u16::from_le_bytes([header[0], header[1]]) != 0xFFFE {
                return header;
            }
            let extra = usize::from(u16::from_le_bytes([header[16], header[17]]));
            std::slice::from_raw_parts(self.0 as *const u8, WAVEFORMATEX_BYTES + extra)
        }
    }
}

impl Drop for MixFormatMemory {
    fn drop(&mut self) {
        // SAFETY: GetMixFormat allocated it with CoTaskMemAlloc, and nothing uses it after this.
        unsafe { CoTaskMemFree(Some(self.0 as *const std::ffi::c_void)) };
    }
}

/// Capture threads alive in this process (tests only): proves that closing ends the thread.
#[cfg(test)]
static CAPTURE_THREADS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
struct LiveCapture;

#[cfg(test)]
impl LiveCapture {
    fn new() -> Self {
        CAPTURE_THREADS.fetch_add(1, Ordering::SeqCst);
        LiveCapture
    }
}

#[cfg(test)]
impl Drop for LiveCapture {
    fn drop(&mut self) {
        CAPTURE_THREADS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The capture thread: starts the default capture endpoint, says whether that worked, then
/// delivers packets until the stream is closed or the device fails.
fn capture(sink: Sink, closed: Arc<AtomicBool>, ready: Ready) {
    #[cfg(test)]
    let _live = LiveCapture::new();
    // MTA: this thread pumps no window messages, which an STA needs, and the WASAPI interfaces
    // are free-threaded; the IAudioClient docs ask for an STA only on first use on Windows 8.
    // SAFETY: initializes COM for this thread only; `Com` uninitializes it on the same thread.
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        let _ = ready.send(Err(failed_to_start(error.message())));
        return;
    }
    let _com = Com;
    let (client, capture, format) = match start() {
        Ok(started) => started,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    // `open` gave up waiting: release the device at once.
    let gave_up = ready.send(Ok(())).is_err();
    let result = if gave_up {
        Ok(())
    } else {
        let mut converter = Converter::new(format);
        // SAFETY: `capture` is a live interface created on this COM thread and used only here.
        pump(
            || unsafe { capture.GetNextPacketSize() },
            || read_packet(&capture, format, &mut converter),
            &closed,
            |samples| sink.audio(samples),
            POLL,
        )
    };
    // SAFETY: `client` is a live interface created on this COM thread and used only here.
    unsafe {
        let _ = client.Stop();
    }
    // The device went away or failed while recording; a close is not a failure.
    if result.is_err() && !closed.load(Ordering::SeqCst) {
        sink.failed(&VoiceError::Interrupted.to_string());
    }
}

/// Opens the default capture endpoint in its own mix format and starts it.
fn start() -> Result<(IAudioClient, IAudioCaptureClient, MixFormat), VoiceError> {
    // SAFETY: COM calls on the capture thread after CoInitializeEx; the mix format stays
    // allocated until after Initialize has read it.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(windows_error)?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(windows_error)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(windows_error)?;
        let memory = MixFormatMemory(client.GetMixFormat().map_err(windows_error)?);
        let format = MixFormat::parse(memory.bytes())?;
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, 0, BUFFER_DURATION, 0, memory.0, None)
            .map_err(windows_error)?;
        let capture: IAudioCaptureClient = client.GetService().map_err(windows_error)?;
        client.Start().map_err(windows_error)?;
        Ok((client, capture, format))
    }
}

/// One packet, copied out and converted before its buffer goes back to WASAPI.
fn read_packet(
    capture: &IAudioCaptureClient,
    format: MixFormat,
    converter: &mut Converter,
) -> windows::core::Result<Vec<f32>> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0u32;
    let mut flags = 0u32;
    // SAFETY: valid out-pointers; the buffer stays ours until ReleaseBuffer below.
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
    let samples = if silent {
        converter.silence(frames as usize)
    } else {
        // SAFETY: non-null, and in the mix format the stream was initialized with, each of the
        // `frames` frames is `block_align` bytes, valid until ReleaseBuffer; read before that.
        let bytes = unsafe { std::slice::from_raw_parts(data as *const u8, frames as usize * format.block_align) };
        converter.packet(bytes)
    };
    // SAFETY: returns exactly the frames GetBuffer handed out; `samples` no longer borrows them.
    unsafe { capture.ReleaseBuffer(frames)? };
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeRecognizer, Recorder};
    use crate::voice::Voice;
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;
    use std::time::Instant;

    /// The hardware tests count `CAPTURE_THREADS`, so they take turns.
    static HARDWARE: Mutex<()> = Mutex::new(());

    #[test]
    fn there_is_no_prompt_for_desktop_apps() {
        assert_eq!(WindowsMicrophone.authorization(), Authorization::Authorized);
        assert_eq!(WindowsMicrophone.request_authorization(), Authorization::Authorized);
    }

    /// Records the real default microphone for a moment and keeps nothing.
    #[test]
    #[ignore = "uses the real default microphone; run explicitly on a Windows machine with one, \
                with --test-threads=1 (they also take turns with each other)"]
    fn the_default_microphone_streams_16_khz_until_stopped_and_releases_the_device() {
        let _turn = HARDWARE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let recognizer = Arc::new(FakeRecognizer::granted());
        *recognizer.final_text.lock().unwrap() = Some("done".into());
        let voice = Voice::new(Arc::new(WindowsMicrophone), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0))));
        for round in 0..2 {
            let started = Instant::now();
            voice.start(None, Recorder::default().events()).unwrap();
            while recognizer.log.lock().unwrap().fed.len() < 8_000 {
                assert!(started.elapsed() < Duration::from_secs(5), "round {round}: half a second of audio arrives");
                std::thread::sleep(Duration::from_millis(10));
            }
            let elapsed = started.elapsed().as_secs_f64();
            let fed = recognizer.log.lock().unwrap().fed.len() as f64;
            // Converted to 16 kHz: at most what that rate delivers in the time it took.
            assert!(fed <= 16_000.0 * elapsed + 3_200.0, "round {round}: {fed} samples in {elapsed:.2} s");
            let stopping = Instant::now();
            assert_eq!(voice.stop().unwrap().text, "done");
            assert!(stopping.elapsed() < Duration::from_secs(2), "round {round}: stop releases the capture");
            recognizer.log.lock().unwrap().fed.clear();
        }
        // Shared mode allows overlapping clients, so reopening shows the device still works, not
        // that the first capture let go; the joined thread and `cancel_ends_the_capture_thread` do.
        voice.start(None, Recorder::default().events()).unwrap();
        voice.cancel().unwrap();
    }

    #[test]
    #[ignore = "uses the real default microphone; run explicitly on a Windows machine with one, \
                with --test-threads=1 (they also take turns with each other)"]
    fn cancel_ends_the_capture_thread() {
        let _turn = HARDWARE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let recognizer = Arc::new(FakeRecognizer::granted());
        let voice = Voice::new(Arc::new(WindowsMicrophone), recognizer, Arc::new(FakeClock(AtomicU64::new(0))));
        let threads = || CAPTURE_THREADS.load(Ordering::SeqCst);
        let before = threads();
        voice.start(None, Recorder::default().events()).unwrap();
        assert_eq!(threads(), before + 1, "one capture thread while recording");
        voice.cancel().unwrap();
        assert_eq!(threads(), before, "cancel waits for the capture thread to end");
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
    }
}
