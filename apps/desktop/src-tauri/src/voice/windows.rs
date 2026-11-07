//! Windows capture-thread and PCM foundation, shared by the WASAPI adapter.
//!
//! `wasapi` owns default-endpoint negotiation and packet release. This module owns COM
//! apartment lifetime, bounded polling, shutdown and conversion into the existing Sink.
//! No device is opened until the application's user-initiated recording calls open.

use super::audio::{CapturePcm, PcmEncoding};
use super::{Sink, Stream, VoiceError};
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// Not Send or Sync: COM objects and their apartment must stay on the capture thread.
struct Apartment(PhantomData<Rc<()>>);

impl Apartment {
    fn enter() -> Result<Self, VoiceError> {
        // SAFETY: called only on our newly created capture thread, balanced by Drop for both
        // S_OK and S_FALSE. Failed initialization must not call CoUninitialize.
        let result = unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32) };
        if result < 0 {
            return Err(VoiceError::Failed(format!("Microphone COM initialization failed (0x{:08X}).", result as u32)));
        }
        Ok(Self(PhantomData))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: this guard cannot leave the thread that initialized COM.
        unsafe { CoUninitialize() };
    }
}

/// Safe packet-to-Sink bridge. The WASAPI adapter must supply exactly `frames * block_align`
/// bytes while its packet is held, or None for AUDCLNT_BUFFERFLAGS_SILENT, then release it.
pub(crate) struct PacketSink {
    pcm: CapturePcm,
    sink: Sink,
}

impl PacketSink {
    pub(crate) fn new(sink: Sink, rate: u32, channels: u16, encoding: PcmEncoding) -> Result<Self, VoiceError> {
        let pcm = CapturePcm::new(rate, channels, encoding).map_err(|error| VoiceError::Failed(error.into()))?;
        Ok(Self { pcm, sink })
    }

    pub(crate) fn packet(&mut self, bytes: Option<&[u8]>, frames: u32) -> Result<(), VoiceError> {
        let samples = self.pcm.packet(bytes, frames).map_err(|error| VoiceError::Failed(error.into()))?;
        if !samples.is_empty() {
            self.sink.audio(&samples);
        }
        Ok(())
    }
}

/// Thread-local backend seam. Implementations need not be Send: create ALL interfaces in
/// `open`, never before spawning. Drop must release resources even after a partial start or
/// panic; `stop` reports normal shutdown errors. Poll must be nonblocking and bounded (drain
/// only a bounded number of WASAPI packets per call), so close can interrupt a busy device.
pub(crate) trait Capture {
    fn start(&mut self) -> Result<(), VoiceError>;
    fn poll(&mut self, sink: &Sink) -> Result<(), VoiceError>;
    fn stop(&mut self) -> Result<(), VoiceError>;
}

/// Only a channel and a join handle cross threads; no COM pointer or interface does.
pub(crate) struct CaptureThread {
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureThread {
    pub(crate) fn start<C, F>(sink: Sink, open: F) -> Result<Self, VoiceError>
    where
        C: Capture + 'static,
        F: FnOnce() -> Result<C, VoiceError> + Send + 'static,
    {
        let (stop, stopping) = mpsc::channel();
        let (ready, started) = mpsc::sync_channel(1);
        let thread = thread::Builder::new().name("voice-wasapi".into()).spawn(move || {
            // Unwinding drops the backend before its apartment. Report only after releasing
            // both: Sink::failed may synchronously close/drop this very stream.
            let mut announced = false;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _apartment = Apartment::enter()?;
                let mut capture = open()?;
                capture.start()?;
                if ready.send(Ok(())).is_err() {
                    return capture.stop();
                }
                announced = true;
                let recording = Self::record(&mut capture, &sink, stopping);
                let stopped = capture.stop();
                recording.and(stopped)
            })).unwrap_or_else(|_| Err(VoiceError::Failed("The microphone capture thread panicked.".into())));
            if let Err(error) = result {
                // Before startup, return the error to open; afterward report interruption.
                if announced {
                    sink.failed(&error.to_string());
                } else {
                    let _ = ready.send(Err(error));
                }
            }
        }).map_err(|error| VoiceError::Failed(format!("The microphone thread could not start: {error}")))?;
        match started.recv() {
            Ok(Ok(())) => Ok(Self { stop: Some(stop), thread: Some(thread) }),
            result => {
                drop(stop);
                let _ = thread.join();
                Err(result.ok().and_then(Result::err).unwrap_or_else(|| {
                    VoiceError::Failed("The microphone thread ended before starting.".into())
                }))
            }
        }
    }

    fn record<C: Capture>(capture: &mut C, sink: &Sink, stopping: Receiver<()>) -> Result<(), VoiceError> {
        loop {
            match stopping.recv_timeout(Duration::from_millis(10)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
                Err(RecvTimeoutError::Timeout) => capture.poll(sink)?,
            }
        }
    }
}

impl Stream for CaptureThread {
    fn close(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            // A failure/event callback can tear down its own stream. Never join ourselves;
            // the worker owns its resources and will finish releasing them on return.
            if thread.thread().id() != thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for CaptureThread {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeMicrophone, FakeRecognizer, Recorder};
    use crate::voice::Voice;
    use std::sync::{Arc, Mutex};
    use std::sync::atomic::AtomicU64;

    struct InMemoryCapture(Rc<()>, Arc<Mutex<Vec<&'static str>>>);

    impl Capture for InMemoryCapture {
        fn start(&mut self) -> Result<(), VoiceError> {
            self.1.lock().unwrap().push("start");
            Ok(())
        }
        fn poll(&mut self, _: &Sink) -> Result<(), VoiceError> { Ok(()) }
        fn stop(&mut self) -> Result<(), VoiceError> {
            self.1.lock().unwrap().push("stop");
            Ok(())
        }
    }

    impl Drop for InMemoryCapture {
        fn drop(&mut self) {
            assert_eq!(Rc::strong_count(&self.0), 1);
            self.1.lock().unwrap().push("drop");
        }
    }

    #[test]
    fn setup_errors_return_without_claiming_a_running_stream() {
        let microphone = Arc::new(FakeMicrophone::granted());
        let voice = Voice::new(microphone.clone(), Arc::new(FakeRecognizer::granted()), Arc::new(FakeClock(AtomicU64::new(0))));
        voice.start(None, Recorder::default().events()).unwrap();
        let result = CaptureThread::start::<InMemoryCapture, _>(microphone.sink(), || {
            Err(VoiceError::NoMicrophone)
        });
        assert!(matches!(result, Err(VoiceError::NoMicrophone)));
        voice.cancel().unwrap();
    }

    #[test]
    fn failed_start_drops_thread_local_capture_before_returning() {
        struct FailedStart(Arc<Mutex<bool>>, Rc<()>);
        impl Capture for FailedStart {
            fn start(&mut self) -> Result<(), VoiceError> { Err(VoiceError::NoMicrophone) }
            fn poll(&mut self, _: &Sink) -> Result<(), VoiceError> { unreachable!() }
            fn stop(&mut self) -> Result<(), VoiceError> { unreachable!() }
        }
        impl Drop for FailedStart {
            fn drop(&mut self) {
                assert_eq!(Rc::strong_count(&self.1), 1);
                *self.0.lock().unwrap() = true;
            }
        }
        let microphone = Arc::new(FakeMicrophone::granted());
        let voice = Voice::new(microphone.clone(), Arc::new(FakeRecognizer::granted()), Arc::new(FakeClock(AtomicU64::new(0))));
        voice.start(None, Recorder::default().events()).unwrap();
        let dropped = Arc::new(Mutex::new(false));
        let observed = dropped.clone();
        let result = CaptureThread::start(microphone.sink(), move || {
            Ok(FailedStart(observed, Rc::new(())))
        });
        assert!(matches!(result, Err(VoiceError::NoMicrophone)));
        assert!(*dropped.lock().unwrap());
        voice.cancel().unwrap();
    }

    #[test]
    fn packets_deliver_only_16k_mono_to_the_sink() {
        let microphone = Arc::new(FakeMicrophone::granted());
        let recognizer = Arc::new(FakeRecognizer::granted());
        let voice = Voice::new(microphone.clone(), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0))));
        voice.start(None, Recorder::default().events()).unwrap();
        let mut packets = PacketSink::new(microphone.sink(), 48_000, 2, PcmEncoding::Signed16).unwrap();
        packets.packet(Some(&[0, 64, 0, 0].repeat(3)), 3).unwrap();
        packets.packet(None, 3).unwrap();
        assert_eq!(recognizer.log.lock().unwrap().fed, vec![0.25, 0.0]);
        voice.cancel().unwrap();
    }

    #[test]
    fn close_is_idempotent_and_joins_thread_local_cleanup() {
        let microphone = Arc::new(FakeMicrophone::granted());
        let voice = Voice::new(microphone.clone(), Arc::new(FakeRecognizer::granted()), Arc::new(FakeClock(AtomicU64::new(0))));
        voice.start(None, Recorder::default().events()).unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let opened = log.clone();
        let mut stream = CaptureThread::start(microphone.sink(), move || {
            Ok(InMemoryCapture(Rc::new(()), opened))
        }).unwrap();
        stream.close();
        stream.close();
        drop(stream);
        assert_eq!(*log.lock().unwrap(), ["start", "stop", "drop"]);
        voice.cancel().unwrap();
    }
}
