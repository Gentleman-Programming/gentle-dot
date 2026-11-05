//! The Windows microphone: the default capture endpoint through WASAPI, in shared mode. WASAPI
//! converts the device's format to the 16 kHz mono f32 the recognizers consume
//! (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`), so the samples go to the sink as they arrive. A
//! thread of its own owns the COM objects for the whole capture and polls for packets.
//!
//! Desktop apps get no microphone prompt on Windows: the system's privacy switch ("Let desktop
//! apps access your microphone") either allows every desktop app or none, and a blocked capture
//! fails with `E_ACCESSDENIED` when it opens.

use super::{audio, Authorization, Microphone, Sink, Stream, VoiceError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

/// `WAVE_FORMAT_IEEE_FLOAT` (mmreg.h).
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// The shared-mode buffer, in 100 ns units: 200 ms.
const BUFFER_DURATION: i64 = 2_000_000;
/// How often the capture thread looks for packets; well inside the buffer.
const POLL: Duration = Duration::from_millis(10);
/// How long `open` waits for the capture thread to start the device.
const OPEN_WAIT: Duration = Duration::from_secs(5);

// HRESULTs that tell the user something they can act on.
const E_ACCESSDENIED: u32 = 0x8007_0005;
/// `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`: no capture endpoint at all.
const E_NOTFOUND: u32 = 0x8007_0490;
const AUDCLNT_E_DEVICE_INVALIDATED: u32 = 0x8889_0004;

pub struct WindowsMicrophone;

/// The format asked of WASAPI: `audio::SAMPLE_RATE` mono 32-bit float.
pub(crate) fn capture_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: 1,
        nSamplesPerSec: audio::SAMPLE_RATE,
        nAvgBytesPerSec: audio::SAMPLE_RATE * 4,
        nBlockAlign: 4,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

/// What a failure to open the capture means to the user.
pub(crate) fn open_error(code: u32, message: &str) -> VoiceError {
    match code {
        E_ACCESSDENIED => VoiceError::MicrophoneDenied,
        E_NOTFOUND | AUDCLNT_E_DEVICE_INVALIDATED => VoiceError::NoMicrophone,
        _ => VoiceError::Failed(format!("The microphone could not start: {message}")),
    }
}

fn failed_to_start(error: impl std::fmt::Display) -> VoiceError {
    VoiceError::Failed(format!("The microphone could not start: {error}"))
}

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

type Ready = mpsc::Sender<Result<(), VoiceError>>;

/// Runs `run` on the capture thread and waits up to `wait` for it to say whether the device
/// started. Windows can block inside device activation or start indefinitely, so a timeout does
/// not wait for the thread: it closes the stream and stops listening, and the thread, once
/// Windows returns, finds nobody waiting, stops the device, and ends without capturing.
fn launch(run: impl FnOnce(Arc<AtomicBool>, Ready) + Send + 'static, wait: Duration) -> Result<WasapiStream, VoiceError> {
    let closed = Arc::new(AtomicBool::new(false));
    let (ready, started) = mpsc::channel();
    let flag = closed.clone();
    let thread = std::thread::Builder::new()
        .name("voice-wasapi".into())
        .spawn(move || run(flag, ready))
        .map_err(failed_to_start)?;
    let mut stream = WasapiStream { closed, thread: Some(thread) };
    match started.recv_timeout(wait) {
        Ok(Ok(())) => Ok(stream),
        Ok(Err(error)) => {
            stream.close();
            Err(error)
        }
        Err(_) => {
            stream.closed.store(true, Ordering::SeqCst);
            drop(stream.thread.take());
            drop(started);
            Err(failed_to_start("the audio device did not answer"))
        }
    }
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
    // SAFETY: initializes COM for this thread only; `Com` uninitializes it on the same thread.
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        let _ = ready.send(Err(failed_to_start(error.message())));
        return;
    }
    let _com = Com;
    let (client, capture) = match start() {
        Ok(started) => started,
        Err(error) => {
            let _ = ready.send(Err(open_error(error.code().0 as u32, &error.message())));
            return;
        }
    };
    // `open` gave up waiting: release the device at once.
    let gave_up = ready.send(Ok(())).is_err();
    let result = if gave_up {
        Ok(())
    } else {
        // SAFETY: `capture` is a live interface created on this COM thread and used only here.
        pump(|| unsafe { capture.GetNextPacketSize() }, || read_packet(&capture), &closed, |samples| sink.audio(samples), POLL)
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

fn start() -> windows::core::Result<(IAudioClient, IAudioCaptureClient)> {
    // SAFETY: COM calls on the capture thread after CoInitializeEx; the format outlives Initialize.
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let format = capture_format();
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            BUFFER_DURATION,
            0,
            &format,
            None,
        )?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok((client, capture))
    }
}

/// Delivers waiting packets, then sleeps a poll, until the stream is closed. The flag is checked
/// before every packet, so a device that always has another one ready cannot keep the capture
/// going after a close.
fn pump<E>(
    mut waiting: impl FnMut() -> Result<u32, E>,
    mut read: impl FnMut() -> Result<Vec<f32>, E>,
    closed: &AtomicBool,
    mut deliver: impl FnMut(&[f32]),
    poll: Duration,
) -> Result<(), E> {
    while !closed.load(Ordering::SeqCst) {
        while !closed.load(Ordering::SeqCst) && waiting()? > 0 {
            let samples = read()?;
            if !samples.is_empty() {
                deliver(&samples);
            }
        }
        std::thread::sleep(poll);
    }
    Ok(())
}

/// One packet, copied out before its buffer goes back to WASAPI. Each frame is one f32 (mono).
fn read_packet(capture: &IAudioCaptureClient) -> windows::core::Result<Vec<f32>> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0u32;
    let mut flags = 0u32;
    // SAFETY: valid out-pointers; the buffer stays ours until ReleaseBuffer below.
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
    let samples = if silent {
        vec![0.0; frames as usize]
    } else {
        // SAFETY: non-null, and with the 32-bit float mono format each of the `frames` frames is one
        // aligned f32 in a buffer valid until ReleaseBuffer; it is copied out before that.
        unsafe { std::slice::from_raw_parts(data as *const f32, frames as usize) }.to_vec()
    };
    // SAFETY: returns exactly the frames GetBuffer handed out; `samples` no longer borrows them.
    unsafe { capture.ReleaseBuffer(frames)? };
    Ok(samples)
}

struct WasapiStream {
    closed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Stream for WasapiStream {
    fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // A failure reported from the capture thread closes the stream on that same thread
            // (the machine discards the recording there); it is already on its way out.
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for WasapiStream {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeRecognizer, Recorder};
    use crate::voice::{Voice, VoiceError};
    use std::sync::atomic::AtomicU64;
    use std::time::Instant;

    #[test]
    fn wasapi_converts_to_16_khz_mono_float() {
        let format = capture_format();
        let (tag, channels, rate, bytes, align, bits, extra) = (
            format.wFormatTag,
            format.nChannels,
            format.nSamplesPerSec,
            format.nAvgBytesPerSec,
            format.nBlockAlign,
            format.wBitsPerSample,
            format.cbSize,
        );
        assert_eq!((tag, channels, rate, bytes, align, bits, extra), (3, 1, 16_000, 64_000, 4, 32, 0));
    }

    #[test]
    fn open_failures_say_what_the_user_can_do() {
        assert_eq!(open_error(0x8007_0005, "denied"), VoiceError::MicrophoneDenied);
        assert_eq!(open_error(0x8007_0490, "none"), VoiceError::NoMicrophone);
        assert_eq!(open_error(0x8889_0004, "gone"), VoiceError::NoMicrophone);
        assert_eq!(
            open_error(0x8889_0008, "Unsupported format"),
            VoiceError::Failed("The microphone could not start: Unsupported format".into())
        );
    }

    #[test]
    fn there_is_no_prompt_for_desktop_apps() {
        assert_eq!(WindowsMicrophone.authorization(), Authorization::Authorized);
        assert_eq!(WindowsMicrophone.request_authorization(), Authorization::Authorized);
    }

    #[test]
    fn a_close_ends_capture_even_while_packets_keep_arriving() {
        let closed = Arc::new(AtomicBool::new(false));
        let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (done, finished) = mpsc::channel();
        let (flag, count) = (closed.clone(), delivered.clone());
        std::thread::spawn(move || {
            // Another packet is always ready, as when delivery keeps up with the device only just.
            let result = pump(
                || Ok::<u32, ()>(1),
                || Ok(vec![0.25; 160]),
                &flag,
                |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
                Duration::from_millis(1),
            );
            let _ = done.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while delivered.load(Ordering::SeqCst) < 10 {
            assert!(Instant::now() < deadline, "packets flow");
            std::thread::yield_now();
        }
        closed.store(true, Ordering::SeqCst);
        assert_eq!(finished.recv_timeout(Duration::from_secs(2)), Ok(Ok(())), "the close ends the capture");
        let after = delivered.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(delivered.load(Ordering::SeqCst), after, "nothing is delivered once the capture ended");
    }

    #[test]
    fn a_device_that_never_answers_times_out_without_waiting_for_windows() {
        let (outcome, observed) = mpsc::channel();
        let started = Instant::now();
        let result = launch(
            move |closed, ready| {
                // Windows is still activating the device when the wait runs out.
                std::thread::sleep(Duration::from_millis(600));
                let nobody_waiting = ready.send(Ok(())).is_err();
                let _ = outcome.send((nobody_waiting, closed.load(Ordering::SeqCst)));
            },
            Duration::from_millis(50),
        );
        assert!(started.elapsed() < Duration::from_millis(400), "the timeout does not wait for Windows");
        assert_eq!(
            result.err(),
            Some(VoiceError::Failed("The microphone could not start: the audio device did not answer".into()))
        );
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(3)),
            Ok((true, true)),
            "the late thread finds nobody waiting and the stream closed, so it stops the device without capturing"
        );
    }

    #[test]
    fn a_start_failure_is_returned_once_the_thread_ended() {
        let ended = Arc::new(AtomicBool::new(false));
        let flag = ended.clone();
        let result = launch(
            move |_, ready| {
                let _ = ready.send(Err(VoiceError::NoMicrophone));
                std::thread::sleep(Duration::from_millis(50));
                flag.store(true, Ordering::SeqCst);
            },
            Duration::from_secs(2),
        );
        assert_eq!(result.err(), Some(VoiceError::NoMicrophone));
        assert!(ended.load(Ordering::SeqCst), "open waits for the failed capture thread to end");
    }

    #[test]
    fn closing_or_dropping_waits_for_the_capture_thread_and_closing_twice_is_harmless() {
        for drop_it in [false, true] {
            let ended = Arc::new(AtomicBool::new(false));
            let flag = ended.clone();
            let mut stream = launch(
                move |closed, ready| {
                    let _ = ready.send(Ok(()));
                    while !closed.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    std::thread::sleep(Duration::from_millis(30));
                    flag.store(true, Ordering::SeqCst);
                },
                Duration::from_secs(2),
            )
            .unwrap();
            if drop_it {
                drop(stream);
            } else {
                stream.close();
                stream.close();
            }
            assert!(ended.load(Ordering::SeqCst), "drop={drop_it}: the thread ended before close returned");
        }
    }

    /// Records the real default microphone for a moment and keeps nothing.
    #[test]
    #[ignore = "uses the real default microphone; run explicitly on a Windows machine with one"]
    fn the_default_microphone_streams_16_khz_until_stopped_and_releases_the_device() {
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
    #[ignore = "uses the real default microphone; run explicitly on a Windows machine with one"]
    fn cancel_ends_the_capture_thread() {
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
