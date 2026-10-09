//! The Linux microphone (S30.5): a command-line recorder that writes 16 kHz mono f32 PCM to its
//! standard output, read on a thread of its own. `parec` (PulseAudio, and PipeWire through
//! pipewire-pulse) is tried first, then `arecord` (ALSA). Linux has no microphone permission to
//! ask for. Compiled on every Unix so the tests run on macOS too; only Linux uses it.

use super::{Authorization, Microphone, Sink, Stream, VoiceError};
use std::io::{self, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Bytes per read: 512 samples, 32 ms.
const READ_BYTES: usize = 4 * 512;

pub struct PipeMicrophone {
    /// Candidate commands, each a program and its arguments, in order of preference.
    pub(crate) recorders: Vec<Vec<String>>,
}

impl PipeMicrophone {
    /// `parec`, then `arecord`, both asked for raw 16 kHz mono little-endian float.
    pub fn system() -> Self {
        let command = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect();
        PipeMicrophone {
            recorders: vec![
                command(&["parec", "--raw", "--format=float32le", "--rate=16000", "--channels=1", "--latency-msec=40"]),
                command(&["arecord", "-q", "-t", "raw", "-f", "FLOAT_LE", "-r", "16000", "-c", "1"]),
            ],
        }
    }

    pub fn with(recorders: Vec<Vec<String>>) -> Self {
        PipeMicrophone { recorders }
    }
}

/// Turns a byte stream into f32 samples, keeping a partial sample for the next chunk.
#[derive(Default)]
pub(crate) struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<f32> {
        self.pending.extend_from_slice(bytes);
        let (whole, _) = self.pending.as_chunks::<4>();
        let samples: Vec<f32> = whole.iter().map(|bytes| f32::from_le_bytes(*bytes)).collect();
        self.pending.drain(..samples.len() * 4);
        samples
    }
}

impl Microphone for PipeMicrophone {
    fn authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn request_authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        for recorder in &self.recorders {
            let Some((program, args)) = recorder.split_first() else { continue };
            let spawned = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
            let mut child = match spawned {
                Ok(child) => child,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(VoiceError::Failed(format!("The microphone could not start: {error}"))),
            };
            let Some(mut output) = child.stdout.take() else { continue };
            let closed = Arc::new(AtomicBool::new(false));
            let reading = closed.clone();
            let read = move || {
                let mut decoder = Decoder::default();
                let mut buffer = [0u8; READ_BYTES];
                loop {
                    match output.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            let samples = decoder.push(&buffer[..read]);
                            if !samples.is_empty() {
                                sink.audio(&samples);
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
                // The recorder ended without being closed: the device went away or failed.
                if !reading.load(Ordering::SeqCst) {
                    sink.failed(&VoiceError::Interrupted.to_string());
                }
            };
            if let Err(error) = std::thread::Builder::new().name("voice-recorder".into()).spawn(read) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(VoiceError::Failed(format!("The microphone could not start: {error}")));
            }
            return Ok(Box::new(PipeStream { child, closed }));
        }
        Err(VoiceError::NoRecorder)
    }
}

struct PipeStream {
    child: Child,
    closed: Arc<AtomicBool>,
}

impl Stream for PipeStream {
    fn close(&mut self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for PipeStream {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeRecognizer, Recorder};
    use crate::voice::{Authorization, Microphone, Voice, VoiceError};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn command(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn little_endian_floats_are_decoded_across_chunk_boundaries() {
        let bytes: Vec<u8> = [0.5f32, -0.25, 1.0].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&bytes[..3]), Vec::<f32>::new());
        assert_eq!(decoder.push(&bytes[3..9]), vec![0.5, -0.25]);
        assert_eq!(decoder.push(&bytes[9..]), vec![1.0]);
    }

    #[test]
    fn the_system_recorders_ask_for_16_khz_mono_float() {
        let recorders = PipeMicrophone::system().recorders;
        assert_eq!(recorders[0][0], "parec");
        assert!(recorders[0].contains(&"--format=float32le".to_string()));
        assert!(recorders[0].contains(&"--rate=16000".to_string()));
        assert!(recorders[0].contains(&"--channels=1".to_string()));
        assert_eq!(recorders[1], command(&["arecord", "-q", "-t", "raw", "-f", "FLOAT_LE", "-r", "16000", "-c", "1"]));
    }

    #[test]
    fn there_is_no_permission_to_ask_for() {
        let mic = PipeMicrophone::system();
        assert_eq!(mic.authorization(), Authorization::Authorized);
        assert_eq!(mic.request_authorization(), Authorization::Authorized);
    }

    fn voice(mic: PipeMicrophone) -> (Voice, Arc<FakeRecognizer>) {
        let recognizer = Arc::new(FakeRecognizer::granted());
        *recognizer.final_text.lock().unwrap() = Some("done".into());
        let voice = Voice::new(Arc::new(mic), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0))));
        (voice, recognizer)
    }

    #[test]
    fn the_first_recorder_found_streams_its_pcm_until_stopped() {
        // 1,600 zero samples, then silence while the recorder keeps running.
        let mic = PipeMicrophone::with(vec![
            command(&["gentle-dot-no-such-recorder"]),
            command(&["/bin/sh", "-c", "head -c 6400 /dev/zero; exec sleep 30"]),
        ]);
        let (voice, recognizer) = voice(mic);
        voice.start(None, Recorder::default().events()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while recognizer.log.lock().unwrap().fed.len() < 1_600 {
            assert!(Instant::now() < deadline, "the PCM arrives");
            std::thread::sleep(Duration::from_millis(5));
        }
        let stopped = Instant::now();
        assert_eq!(voice.stop().unwrap().text, "done");
        assert!(stopped.elapsed() < Duration::from_secs(5), "stop kills the recorder");
        assert_eq!(recognizer.log.lock().unwrap().fed.len(), 1_600);
    }

    #[test]
    fn a_recorder_that_ends_on_its_own_is_an_interruption() {
        // It ends a moment after starting, once the recording is up.
        let mic = PipeMicrophone::with(vec![command(&["/bin/sh", "-c", "head -c 64 /dev/zero; sleep 0.3"])]);
        let (voice, _) = voice(mic);
        let recorder = Recorder::default();
        voice.start(None, recorder.events()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let interrupted = crate::voice::VoiceEvent::Error(VoiceError::Interrupted.to_string());
        while !recorder.seen().contains(&interrupted) {
            assert!(Instant::now() < deadline, "the interruption is reported");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording), "the recording ended");
    }

    #[test]
    fn no_recorder_on_the_system_explains_what_to_install() {
        let mic = PipeMicrophone::with(vec![command(&["gentle-dot-no-such-recorder"])]);
        let (voice, _) = voice(mic);
        assert_eq!(voice.start(None, Recorder::default().events()), Err(VoiceError::NoRecorder));
        assert!(VoiceError::NoRecorder.to_string().contains("pulseaudio-utils"));
    }
}
