//! Fakes for the voice tests: a microphone and a recognizer that record what the machine asks
//! of them and let a test play the platform's side (audio, results, failures).

use super::{Authorization, Events, Microphone, NativeAudio, Recognition, Recognizer, Sink, Stream, VoiceError, VoiceEvent};
use crate::computer::Clock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// Blocks a permission prompt until the test answers it.
#[derive(Default)]
pub struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }

    pub fn wait(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }
}

#[derive(Default)]
pub struct MicLog {
    pub requests: usize,
    pub opened: usize,
    pub closed: usize,
    pub sink: Option<Sink>,
}

pub struct FakeMicrophone {
    pub authorization: Mutex<Authorization>,
    /// What a prompt answers.
    pub answer: Mutex<Authorization>,
    pub gate: Option<Arc<Gate>>,
    pub open_error: Mutex<Option<VoiceError>>,
    pub log: Arc<Mutex<MicLog>>,
}

impl FakeMicrophone {
    pub fn granted() -> Self {
        FakeMicrophone {
            authorization: Mutex::new(Authorization::Authorized),
            answer: Mutex::new(Authorization::Authorized),
            gate: None,
            open_error: Mutex::new(None),
            log: Arc::default(),
        }
    }

    pub fn with(authorization: Authorization, answer: Authorization) -> Self {
        let mic = FakeMicrophone::granted();
        *mic.authorization.lock().unwrap() = authorization;
        *mic.answer.lock().unwrap() = answer;
        mic
    }

    /// The sink of the latest capture, to play the audio thread.
    pub fn sink(&self) -> Sink {
        self.log.lock().unwrap().sink.clone().expect("the microphone was opened")
    }
}

impl Microphone for FakeMicrophone {
    fn authorization(&self) -> Authorization {
        *self.authorization.lock().unwrap()
    }

    fn request_authorization(&self) -> Authorization {
        self.log.lock().unwrap().requests += 1;
        if let Some(gate) = &self.gate {
            gate.wait();
        }
        let answer = *self.answer.lock().unwrap();
        *self.authorization.lock().unwrap() = answer;
        answer
    }

    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        if let Some(error) = self.open_error.lock().unwrap().clone() {
            return Err(error);
        }
        let mut log = self.log.lock().unwrap();
        log.opened += 1;
        log.sink = Some(sink);
        Ok(Box::new(FakeStream { log: self.log.clone() }))
    }
}

struct FakeStream {
    log: Arc<Mutex<MicLog>>,
}

impl Stream for FakeStream {
    fn close(&mut self) {
        self.log.lock().unwrap().closed += 1;
    }
}

#[derive(Default)]
pub struct RecognitionLog {
    pub requests: usize,
    pub locales: Vec<String>,
    pub fed: Vec<f32>,
    /// Device buffers, for a recognition that takes them.
    pub native: Vec<FakeNative>,
    pub finished: usize,
    pub cancelled: usize,
    pub sink: Option<Sink>,
}

pub struct FakeRecognizer {
    pub authorization: Mutex<Authorization>,
    pub answer: Mutex<Authorization>,
    pub current: String,
    pub supported: Vec<String>,
    /// Delivered through the sink when the recognition is finished; none plays a recognizer
    /// that never answers.
    pub final_text: Mutex<Option<String>>,
    /// Reported as a failure when the recognition is finished.
    pub fail_on_finish: Mutex<Option<String>>,
    /// Plays a recognizer that takes the device's own audio (as Apple Speech does).
    pub native: bool,
    pub log: Arc<Mutex<RecognitionLog>>,
}

impl FakeRecognizer {
    pub fn granted() -> Self {
        FakeRecognizer {
            authorization: Mutex::new(Authorization::Authorized),
            answer: Mutex::new(Authorization::Authorized),
            current: "en_US".into(),
            supported: vec!["en-US".into(), "es-ES".into(), "es-MX".into()],
            final_text: Mutex::new(None),
            fail_on_finish: Mutex::new(None),
            native: false,
            log: Arc::default(),
        }
    }

    pub fn with(authorization: Authorization, answer: Authorization) -> Self {
        let recognizer = FakeRecognizer::granted();
        *recognizer.authorization.lock().unwrap() = authorization;
        *recognizer.answer.lock().unwrap() = answer;
        recognizer
    }

    pub fn sink(&self) -> Sink {
        self.log.lock().unwrap().sink.clone().expect("a recognition began")
    }
}

impl Recognizer for FakeRecognizer {
    fn authorization(&self) -> Authorization {
        *self.authorization.lock().unwrap()
    }

    fn request_authorization(&self) -> Authorization {
        self.log.lock().unwrap().requests += 1;
        let answer = *self.answer.lock().unwrap();
        *self.authorization.lock().unwrap() = answer;
        answer
    }

    fn current_locale(&self) -> String {
        self.current.clone()
    }

    fn supported_locales(&self) -> Vec<String> {
        self.supported.clone()
    }

    fn begin(&self, locale: &str, sink: Sink) -> Result<Box<dyn Recognition>, VoiceError> {
        let mut log = self.log.lock().unwrap();
        log.locales.push(locale.into());
        log.sink = Some(sink.clone());
        let final_text = self.final_text.lock().unwrap().clone();
        let failure = self.fail_on_finish.lock().unwrap().clone();
        Ok(Box::new(FakeRecognition { log: self.log.clone(), sink, final_text, failure, native: self.native }))
    }
}

struct FakeRecognition {
    log: Arc<Mutex<RecognitionLog>>,
    sink: Sink,
    final_text: Option<String>,
    failure: Option<String>,
    native: bool,
}

impl Recognition for FakeRecognition {
    fn feed(&mut self, samples: &[f32]) {
        self.log.lock().unwrap().fed.extend_from_slice(samples);
    }

    fn wants_native(&self) -> bool {
        self.native
    }

    fn feed_native(&mut self, audio: &NativeAudio) {
        let buffer = audio.downcast_ref::<FakeNative>().expect("the fake microphone's buffer");
        self.log.lock().unwrap().native.push(buffer.clone());
    }

    fn finish(&mut self) {
        self.log.lock().unwrap().finished += 1;
        if let Some(text) = &self.final_text {
            self.sink.finished(text);
        }
        if let Some(message) = &self.failure {
            self.sink.failed(message);
        }
    }

    fn cancel(&mut self) {
        self.log.lock().unwrap().cancelled += 1;
    }
}

/// A device buffer, as a microphone that captures at its own rate would pass it along.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeNative {
    pub rate: u32,
    pub frames: usize,
}

/// Collects the events a webview would receive.
#[derive(Default, Clone)]
pub struct Recorder(pub Arc<Mutex<Vec<VoiceEvent>>>);

impl Recorder {
    pub fn events(&self) -> Events {
        let seen = self.0.clone();
        Arc::new(move |event| seen.lock().unwrap().push(event))
    }

    pub fn seen(&self) -> Vec<VoiceEvent> {
        self.0.lock().unwrap().clone()
    }

    pub fn levels(&self) -> usize {
        self.seen().iter().filter(|event| matches!(event, VoiceEvent::Level(_))).count()
    }
}

pub struct FakeClock(pub AtomicU64);

impl FakeClock {
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn sleep_ms(&self, ms: u64) {
        self.advance(ms);
    }
}
