//! The voice state machine: one recording at a time, between a `Microphone` and a `Recognizer`.
//!
//! Idle → Starting (permissions, locale, recognition, capture) → Recording → Stopping → Idle.
//! Cancel works in every state. Platform callbacks arrive on arbitrary threads through a
//! `Sink` bound to one recording, so results from an earlier recording are ignored. No
//! platform call or event is made while the state lock is held.

use super::{audio, locale, Authorization, Events, Microphone, Recognition, Recognizer, Stream, Transcript};
use super::{VoiceError, VoiceEvent, VoiceStatus};
use crate::computer::Clock;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

/// About 15 levels a second.
pub const LEVEL_INTERVAL_MS: u64 = 1_000 / 15;
/// How long `stop` waits for the final transcript before using the latest partial.
pub const FINAL_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Voice {
    inner: Arc<Inner>,
    final_timeout: Duration,
}

struct Inner {
    microphone: Arc<dyn Microphone>,
    recognizer: Arc<dyn Recognizer>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    changed: Condvar,
}

enum State {
    Idle { next: u64 },
    Starting { recording: u64, cancelled: bool, failure: Option<String> },
    Recording(Session),
    Stopping(Session),
}

struct Session {
    recording: u64,
    events: Events,
    stream: Option<Box<dyn Stream>>,
    feed: Arc<Mutex<Feed>>,
    transcript: String,
    final_text: Option<String>,
    last_level_ms: Option<u64>,
    /// The loudest chunk since the last level.
    peak: f32,
}

/// The recognition, closed once finished or cancelled so no audio follows `finish`.
struct Feed {
    recognition: Box<dyn Recognition>,
    open: bool,
}

impl Feed {
    fn push(&mut self, samples: &[f32]) {
        if self.open {
            self.recognition.feed(samples);
        }
    }

    fn finish(&mut self) {
        if self.open {
            self.open = false;
            self.recognition.finish();
        }
    }

    fn cancel(&mut self) {
        self.open = false;
        self.recognition.cancel();
    }
}

impl State {
    fn recording(&self) -> Option<u64> {
        match self {
            State::Idle { .. } => None,
            State::Starting { recording, .. } => Some(*recording),
            State::Recording(session) | State::Stopping(session) => Some(session.recording),
        }
    }

    fn idle(&self) -> State {
        State::Idle { next: self.recording().map_or(0, |n| n + 1) }
    }
}

/// Tears a session down outside the state lock.
fn discard(session: Session) {
    let Session { mut stream, feed, .. } = session;
    if let Some(stream) = stream.as_mut() {
        stream.close();
    }
    lock(&feed).cancel();
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn authorize(
    current: Authorization,
    request: impl FnOnce() -> Authorization,
    denied: VoiceError,
    restricted: VoiceError,
) -> Result<(), VoiceError> {
    let answer = if current == Authorization::NotDetermined { request() } else { current };
    match answer {
        Authorization::Authorized => Ok(()),
        Authorization::Restricted => Err(restricted),
        Authorization::Denied | Authorization::NotDetermined => Err(denied),
    }
}

/// The reason a permission blocks voice input, without prompting.
fn blocked(current: Authorization, denied: VoiceError, restricted: VoiceError) -> Option<VoiceError> {
    match current {
        Authorization::Denied => Some(denied),
        Authorization::Restricted => Some(restricted),
        Authorization::NotDetermined | Authorization::Authorized => None,
    }
}

impl Voice {
    pub fn new(microphone: Arc<dyn Microphone>, recognizer: Arc<dyn Recognizer>, clock: Arc<dyn Clock>) -> Self {
        let inner = Inner { microphone, recognizer, clock, state: Mutex::new(State::Idle { next: 0 }), changed: Condvar::new() };
        Voice { inner: Arc::new(inner), final_timeout: FINAL_TIMEOUT }
    }

    pub fn with_final_timeout(mut self, timeout: Duration) -> Self {
        self.final_timeout = timeout;
        self
    }

    /// Whether voice input can work, without prompting: a permission the user denied, or no
    /// recognizer for the user's locale, makes it unavailable. Unasked permissions are asked
    /// on the first `start`.
    pub fn status(&self) -> VoiceStatus {
        let (recognizer, microphone) = (&self.inner.recognizer, &self.inner.microphone);
        let reason = blocked(recognizer.authorization(), VoiceError::SpeechDenied, VoiceError::SpeechRestricted)
            .or_else(|| blocked(microphone.authorization(), VoiceError::MicrophoneDenied, VoiceError::MicrophoneRestricted))
            .or_else(|| locale::resolve(None, &recognizer.current_locale(), &recognizer.supported_locales()).err());
        match reason {
            Some(reason) => VoiceStatus::unavailable(reason.to_string()),
            None => VoiceStatus::available(),
        }
    }

    /// Starts recording, prompting for permissions first when they were never asked. Blocks
    /// while a prompt is open, so it runs off the main thread. `events` reach the caller.
    pub fn start(&self, requested: Option<&str>, events: Events) -> Result<(), VoiceError> {
        let recording = {
            let mut state = lock(&self.inner.state);
            let State::Idle { next } = *state else { return Err(VoiceError::Busy) };
            *state = State::Starting { recording: next, cancelled: false, failure: None };
            next
        };
        let sink = Sink { inner: Arc::downgrade(&self.inner), recording };
        let begun = self.prepare(requested, recording).and_then(|locale| {
            let mut recognition = self.inner.recognizer.begin(&locale, sink.clone())?;
            match self.inner.microphone.open(sink) {
                Ok(stream) => Ok((stream, recognition)),
                Err(error) => {
                    recognition.cancel();
                    Err(error)
                }
            }
        });
        let mut state = lock(&self.inner.state);
        let State::Starting { cancelled, failure, .. } = std::mem::replace(&mut *state, State::Idle { next: recording + 1 }) else {
            unreachable!("only start leaves Starting");
        };
        let (stream, recognition) = begun?;
        let feed = Arc::new(Mutex::new(Feed { recognition, open: true }));
        let session = Session {
            recording,
            events,
            stream: Some(stream),
            feed,
            transcript: String::new(),
            final_text: None,
            last_level_ms: None,
            peak: 0.0,
        };
        let refused = if cancelled { Some(VoiceError::Cancelled) } else { failure.map(VoiceError::Failed) };
        if let Some(error) = refused {
            drop(state);
            discard(session);
            return Err(error);
        }
        *state = State::Recording(session);
        Ok(())
    }

    /// Locale first (no point prompting without a recognizer), then Speech, then Microphone.
    fn prepare(&self, requested: Option<&str>, recording: u64) -> Result<String, VoiceError> {
        let (recognizer, microphone) = (&self.inner.recognizer, &self.inner.microphone);
        let locale = locale::resolve(requested, &recognizer.current_locale(), &recognizer.supported_locales())?;
        authorize(recognizer.authorization(), || recognizer.request_authorization(), VoiceError::SpeechDenied, VoiceError::SpeechRestricted)?;
        self.still_starting(recording)?;
        authorize(microphone.authorization(), || microphone.request_authorization(), VoiceError::MicrophoneDenied, VoiceError::MicrophoneRestricted)?;
        self.still_starting(recording)?;
        Ok(locale)
    }

    fn still_starting(&self, recording: u64) -> Result<(), VoiceError> {
        match *lock(&self.inner.state) {
            State::Starting { recording: r, cancelled: false, .. } if r == recording => Ok(()),
            _ => Err(VoiceError::Cancelled),
        }
    }

    /// Stops the microphone and resolves with the final transcript, or the latest partial when
    /// the recognizer does not answer within the timeout. Blocks, so it runs off the main thread.
    pub fn stop(&self) -> Result<Transcript, VoiceError> {
        let (recording, mut stream, feed) = {
            let mut state = lock(&self.inner.state);
            match std::mem::replace(&mut *state, State::Idle { next: 0 }) {
                State::Recording(mut session) => {
                    let taken = (session.recording, session.stream.take(), session.feed.clone());
                    *state = State::Stopping(session);
                    taken
                }
                State::Starting { recording, failure, .. } => {
                    // Stopping before the capture is up is a cancel with nothing said.
                    *state = State::Starting { recording, cancelled: true, failure };
                    return Ok(Transcript { text: String::new() });
                }
                other => {
                    let error = if matches!(other, State::Stopping(_)) { VoiceError::Stopping } else { VoiceError::NotRecording };
                    *state = other;
                    return Err(error);
                }
            }
        };
        if let Some(stream) = stream.as_mut() {
            stream.close();
        }
        lock(&feed).finish();

        let deadline = Instant::now() + self.final_timeout;
        let mut state = lock(&self.inner.state);
        loop {
            let State::Stopping(session) = &*state else { return Err(VoiceError::Cancelled) };
            if session.recording != recording {
                return Err(VoiceError::Cancelled);
            }
            let now = Instant::now();
            if session.final_text.is_some() || now >= deadline {
                break;
            }
            state = self.inner.changed.wait_timeout(state, deadline - now).map(|(s, _)| s).unwrap_or_else(|p| p.into_inner().0);
        }
        let idle = state.idle();
        let State::Stopping(session) = std::mem::replace(&mut *state, idle) else { unreachable!() };
        drop(state);
        let answered = session.final_text.is_some();
        let text = session.final_text.unwrap_or(session.transcript).trim().to_string();
        if !answered {
            lock(&feed).cancel();
        }
        Ok(Transcript { text })
    }

    /// Stops and discards. Harmless when idle; during a permission prompt the start is aborted.
    pub fn cancel(&self) -> Result<(), VoiceError> {
        let mut state = lock(&self.inner.state);
        match &mut *state {
            State::Idle { .. } => Ok(()),
            State::Starting { cancelled, .. } => {
                *cancelled = true;
                Ok(())
            }
            State::Recording(_) | State::Stopping(_) => {
                let idle = state.idle();
                let (State::Recording(session) | State::Stopping(session)) = std::mem::replace(&mut *state, idle) else {
                    unreachable!()
                };
                drop(state);
                self.inner.changed.notify_all();
                discard(session);
                Ok(())
            }
        }
    }
}

/// The platform's way back into one recording: audio from the microphone, results and failures
/// from the recognizer. Cheap to clone; calls for an earlier recording are ignored.
#[derive(Clone)]
pub struct Sink {
    inner: Weak<Inner>,
    recording: u64,
}

impl Sink {
    /// A chunk of `audio::SAMPLE_RATE` mono PCM: fed to the recognizer, and metered.
    pub fn audio(&self, samples: &[f32]) {
        let Some(inner) = self.inner.upgrade() else { return };
        let (feed, level) = {
            let mut state = lock(&inner.state);
            let State::Recording(session) = &mut *state else { return };
            if session.recording != self.recording {
                return;
            }
            session.peak = session.peak.max(audio::rms(samples));
            let now = inner.clock.now_ms();
            let due = session.last_level_ms.is_none_or(|last| now.saturating_sub(last) >= LEVEL_INTERVAL_MS);
            let level = due.then(|| {
                session.last_level_ms = Some(now);
                let level = audio::level(std::mem::take(&mut session.peak));
                (session.events.clone(), VoiceEvent::Level(level))
            });
            (session.feed.clone(), level)
        };
        if let Some((events, level)) = level {
            events(level);
        }
        lock(&feed).push(samples);
    }

    /// The text so far.
    pub fn partial(&self, text: &str) {
        self.update(|session| {
            session.transcript = text.to_string();
            Some(VoiceEvent::Partial(text.to_string()))
        });
    }

    /// The final text: it resolves `stop`, or waits for it.
    pub fn finished(&self, text: &str) {
        self.update(|session| {
            session.transcript = text.to_string();
            session.final_text = Some(text.to_string());
            None
        });
    }

    /// A failure. While recording it is reported and ends the recording; while stopping, `stop`
    /// resolves with the text so far (a recognizer that heard nothing reports an error).
    pub fn failed(&self, message: &str) {
        let Some(inner) = self.inner.upgrade() else { return };
        let mut state = lock(&inner.state);
        match &mut *state {
            State::Starting { recording, failure, .. } if *recording == self.recording => {
                failure.get_or_insert_with(|| message.to_string());
            }
            State::Stopping(session) if session.recording == self.recording => {
                if session.final_text.is_none() {
                    session.final_text = Some(session.transcript.clone());
                }
                drop(state);
                inner.changed.notify_all();
            }
            State::Recording(session) if session.recording == self.recording => {
                let idle = state.idle();
                let State::Recording(session) = std::mem::replace(&mut *state, idle) else { unreachable!() };
                drop(state);
                inner.changed.notify_all();
                (session.events)(VoiceEvent::Error(message.to_string()));
                discard(session);
            }
            _ => {}
        }
    }

    fn update(&self, change: impl FnOnce(&mut Session) -> Option<VoiceEvent>) {
        let Some(inner) = self.inner.upgrade() else { return };
        let (events, event) = {
            let mut state = lock(&inner.state);
            let (State::Recording(session) | State::Stopping(session)) = &mut *state else { return };
            if session.recording != self.recording {
                return;
            }
            (session.events.clone(), change(session))
        };
        inner.changed.notify_all();
        if let Some(event) = event {
            events(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeMicrophone, FakeRecognizer, Gate, Recorder};
    use crate::voice::{Authorization, Transcript, VoiceError, VoiceEvent, VoiceStatus};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use std::time::Duration;

    struct Rig {
        voice: Voice,
        mic: Arc<FakeMicrophone>,
        recognizer: Arc<FakeRecognizer>,
        clock: Arc<FakeClock>,
        recorder: Recorder,
    }

    fn rig(mic: FakeMicrophone, recognizer: FakeRecognizer) -> Rig {
        let (mic, recognizer) = (Arc::new(mic), Arc::new(recognizer));
        let clock = Arc::new(FakeClock(AtomicU64::new(1_000)));
        let voice = Voice::new(mic.clone(), recognizer.clone(), clock.clone()).with_final_timeout(Duration::from_millis(50));
        Rig { voice, mic, recognizer, clock, recorder: Recorder::default() }
    }

    fn granted() -> Rig {
        rig(FakeMicrophone::granted(), FakeRecognizer::granted())
    }

    impl Rig {
        fn start(&self) -> Result<(), VoiceError> {
            self.voice.start(None, self.recorder.events())
        }
    }

    #[test]
    fn status_is_available_when_permissions_are_granted_or_not_asked_yet() {
        assert_eq!(granted().voice.status(), VoiceStatus::available());
        let unasked = rig(
            FakeMicrophone::with(Authorization::NotDetermined, Authorization::Authorized),
            FakeRecognizer::with(Authorization::NotDetermined, Authorization::Authorized),
        );
        assert_eq!(unasked.voice.status(), VoiceStatus::available());
        assert_eq!(unasked.mic.log.lock().unwrap().requests + unasked.recognizer.log.lock().unwrap().requests, 0);
    }

    #[test]
    fn status_explains_a_denied_or_restricted_permission() {
        let speech = rig(FakeMicrophone::granted(), FakeRecognizer::with(Authorization::Denied, Authorization::Denied));
        assert_eq!(speech.voice.status(), VoiceStatus::unavailable(VoiceError::SpeechDenied.to_string()));
        let mic = rig(FakeMicrophone::with(Authorization::Restricted, Authorization::Restricted), FakeRecognizer::granted());
        assert_eq!(mic.voice.status(), VoiceStatus::unavailable(VoiceError::MicrophoneRestricted.to_string()));
    }

    #[test]
    fn status_explains_a_missing_recognizer_for_the_current_locale() {
        let mut recognizer = FakeRecognizer::granted();
        recognizer.current = "ja_JP".into();
        recognizer.supported = vec![];
        let rig = rig(FakeMicrophone::granted(), recognizer);
        assert_eq!(rig.voice.status(), VoiceStatus::unavailable("Speech recognition is not available for ja-JP."));
    }

    #[test]
    fn start_prompts_for_permissions_on_first_use_then_records() {
        let rig = rig(
            FakeMicrophone::with(Authorization::NotDetermined, Authorization::Authorized),
            FakeRecognizer::with(Authorization::NotDetermined, Authorization::Authorized),
        );
        rig.start().unwrap();
        assert_eq!(rig.recognizer.log.lock().unwrap().requests, 1);
        assert_eq!(rig.mic.log.lock().unwrap().requests, 1);
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1);
        assert_eq!(rig.recognizer.log.lock().unwrap().locales, vec!["en-US".to_string()]);
    }

    #[test]
    fn a_denied_prompt_fails_the_start_and_frees_the_slot() {
        let rig = rig(
            FakeMicrophone::with(Authorization::NotDetermined, Authorization::Denied),
            FakeRecognizer::granted(),
        );
        assert_eq!(rig.start(), Err(VoiceError::MicrophoneDenied));
        assert_eq!(rig.mic.log.lock().unwrap().opened, 0);
        *rig.mic.answer.lock().unwrap() = Authorization::Authorized;
        *rig.mic.authorization.lock().unwrap() = Authorization::NotDetermined;
        assert_eq!(rig.start(), Ok(()));
    }

    #[test]
    fn the_requested_locale_reaches_the_recognizer() {
        let rig = granted();
        rig.voice.start(Some("es_AR"), rig.recorder.events()).unwrap();
        assert_eq!(rig.recognizer.log.lock().unwrap().locales, vec!["es-ES".to_string()]);
    }

    #[test]
    fn only_one_recording_at_a_time() {
        let rig = granted();
        rig.start().unwrap();
        assert_eq!(rig.start(), Err(VoiceError::Busy));
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1);
    }

    #[test]
    fn partial_text_is_sent_while_recording() {
        let rig = granted();
        rig.start().unwrap();
        rig.recognizer.sink().partial("hello");
        rig.recognizer.sink().partial("hello there");
        assert_eq!(
            rig.recorder.seen(),
            vec![VoiceEvent::Partial("hello".into()), VoiceEvent::Partial("hello there".into())]
        );
    }

    #[test]
    fn stop_closes_the_microphone_and_resolves_with_the_final_transcript() {
        let rig = granted();
        *rig.recognizer.final_text.lock().unwrap() = Some(" Hello there. ".into());
        rig.start().unwrap();
        rig.recognizer.sink().partial("hello");
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "Hello there.".into() }));
        assert_eq!(rig.mic.log.lock().unwrap().closed, 1);
        assert_eq!(rig.recognizer.log.lock().unwrap().finished, 1);
        rig.start().unwrap();
    }

    #[test]
    fn stop_falls_back_to_the_latest_partial_when_no_final_arrives() {
        let rig = granted();
        rig.start().unwrap();
        rig.recognizer.sink().partial("almost done");
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "almost done".into() }));
        assert_eq!(rig.recognizer.log.lock().unwrap().cancelled, 1);
    }

    #[test]
    fn stop_without_a_recording_is_an_error() {
        assert_eq!(granted().voice.stop(), Err(VoiceError::NotRecording));
    }

    #[test]
    fn cancel_discards_the_recording_and_ignores_its_late_results() {
        let rig = granted();
        rig.start().unwrap();
        let old = rig.recognizer.sink();
        assert_eq!(rig.voice.cancel(), Ok(()));
        assert_eq!(rig.mic.log.lock().unwrap().closed, 1);
        assert_eq!(rig.recognizer.log.lock().unwrap().cancelled, 1);
        rig.start().unwrap();
        old.partial("from before");
        old.failed("canceled");
        assert!(rig.recorder.seen().is_empty());
        assert_eq!(rig.voice.cancel(), Ok(()));
        assert_eq!(rig.voice.cancel(), Ok(()), "cancelling when idle is harmless");
    }

    #[test]
    fn cancel_during_a_permission_prompt_aborts_the_start() {
        let gate = Arc::new(Gate::default());
        let mut mic = FakeMicrophone::with(Authorization::NotDetermined, Authorization::Authorized);
        mic.gate = Some(gate.clone());
        let rig = Arc::new(rig(mic, FakeRecognizer::granted()));
        let starting = {
            let rig = rig.clone();
            std::thread::spawn(move || rig.start())
        };
        while rig.mic.log.lock().unwrap().requests == 0 {
            std::thread::yield_now();
        }
        assert_eq!(rig.start(), Err(VoiceError::Busy));
        assert_eq!(rig.voice.cancel(), Ok(()));
        gate.release();
        assert_eq!(starting.join().unwrap(), Err(VoiceError::Cancelled));
        assert_eq!(rig.mic.log.lock().unwrap().opened, 0);
        rig.start().unwrap();
    }

    #[test]
    fn audio_reaches_the_recognizer_and_levels_are_throttled() {
        let rig = granted();
        rig.start().unwrap();
        let sink = rig.mic.sink();
        for _ in 0..10 {
            sink.audio(&[0.5; 160]);
            rig.clock.advance(10);
        }
        assert_eq!(rig.recognizer.log.lock().unwrap().fed.len(), 1_600);
        assert_eq!(rig.recorder.levels(), 2, "one level now, the next after 1/15 s");
        rig.clock.advance(LEVEL_INTERVAL_MS);
        sink.audio(&[0.0; 160]);
        let last = rig.recorder.seen().into_iter().rev().find_map(|event| match event {
            VoiceEvent::Level(level) => Some(level),
            _ => None,
        });
        assert!(last.unwrap() > 0.5, "the meter shows the loudest chunk since the last level");
    }

    #[test]
    fn no_audio_reaches_the_recognizer_after_stop() {
        let rig = granted();
        rig.start().unwrap();
        let sink = rig.mic.sink();
        rig.voice.stop().unwrap();
        sink.audio(&[0.5; 160]);
        assert!(rig.recognizer.log.lock().unwrap().fed.is_empty());
    }

    #[test]
    fn a_failure_while_recording_is_reported_and_ends_the_recording() {
        let rig = granted();
        rig.start().unwrap();
        rig.mic.sink().failed(&VoiceError::Interrupted.to_string());
        assert_eq!(rig.recorder.seen(), vec![VoiceEvent::Error("The microphone was interrupted.".into())]);
        assert_eq!(rig.mic.log.lock().unwrap().closed, 1);
        assert_eq!(rig.recognizer.log.lock().unwrap().cancelled, 1);
        assert_eq!(rig.voice.stop(), Err(VoiceError::NotRecording));
        rig.start().unwrap();
    }

    #[test]
    fn a_failure_while_stopping_resolves_with_the_text_so_far() {
        let rig = granted();
        *rig.recognizer.fail_on_finish.lock().unwrap() = Some("No speech detected".into());
        rig.start().unwrap();
        rig.recognizer.sink().partial("so far");
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "so far".into() }));
        assert!(rig.recorder.seen().iter().all(|event| !matches!(event, VoiceEvent::Error(_))));
    }

    #[test]
    fn a_microphone_that_cannot_open_cancels_the_recognition() {
        let rig = granted();
        *rig.mic.open_error.lock().unwrap() = Some(VoiceError::NoMicrophone);
        assert_eq!(rig.start(), Err(VoiceError::NoMicrophone));
        assert_eq!(rig.recognizer.log.lock().unwrap().cancelled, 1);
        *rig.mic.open_error.lock().unwrap() = None;
        rig.start().unwrap();
    }

    #[test]
    fn a_failure_reported_while_starting_fails_the_start() {
        let rig = granted();
        // The recognizer reports a failure before the capture is up (as Speech can, on its queue).
        let recognizer = rig.recognizer.clone();
        let mic = rig.mic.clone();
        *mic.open_error.lock().unwrap() = None;
        let voice = Voice::new(Arc::new(FailingOnOpen(mic, recognizer.clone())), recognizer.clone(), rig.clock.clone());
        assert_eq!(voice.start(None, rig.recorder.events()), Err(VoiceError::Failed("Siri and Dictation are disabled.".into())));
        assert_eq!(recognizer.log.lock().unwrap().cancelled, 1);
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
    }

    /// Opens the fake microphone after the recognition reported a failure.
    struct FailingOnOpen(Arc<FakeMicrophone>, Arc<FakeRecognizer>);

    impl crate::voice::Microphone for FailingOnOpen {
        fn authorization(&self) -> Authorization {
            self.0.authorization()
        }

        fn request_authorization(&self) -> Authorization {
            self.0.request_authorization()
        }

        fn open(&self, sink: Sink) -> Result<Box<dyn crate::voice::Stream>, VoiceError> {
            self.1.sink().failed("Siri and Dictation are disabled.");
            self.0.open(sink)
        }
    }
}
