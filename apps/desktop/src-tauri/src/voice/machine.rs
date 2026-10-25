//! The voice state machine: one recording at a time, between a `Microphone` and a `Recognizer`.
//!
//! Idle → Starting (permissions, locale, recognition, capture) → Recording → Stopping → Idle.
//! Cancel works in every state. Platform callbacks arrive on arbitrary threads through a
//! `Sink` bound to one recording, so results from an earlier recording are ignored. No
//! platform call or event is made while the state lock is held.
//!
//! While nothing records, the machine can hold the wake word's listener on the same capture
//! (`arm`, S2); a recording takes the microphone from it, and the note the wake word starts ends
//! itself by energy (`start_woken`, S6).

use super::wake::WakeWord;
use super::{audio, locale, AudioSink, Authorization, Events, Listener, Microphone, NativeAudio, Recognition, Recognizer, Stream, Transcript};
use super::{VoiceError, VoiceEvent, VoiceStatus};
use crate::computer::Clock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

/// About 15 levels a second.
pub const LEVEL_INTERVAL_MS: u64 = 1_000 / 15;
/// How long `stop` waits for the final transcript before using the latest partial.
pub const FINAL_TIMEOUT: Duration = Duration::from_secs(3);

/// Where speech starts on the note the wake word started (S6). Measured with the app's own
/// meter on this machine: speech sits around -27 dBFS (rms 0.045) and room silence around
/// -55 dBFS (rms 0.0018), so -44 dBFS (rms 0.006) sits between them with about 17 dB of margin
/// on the loud side and 11 dB on the quiet one. A fixed threshold is enough here: the note is
/// recorded in one room, and the cost of guessing wrong is a note that ends early or late.
pub const SPEECH_RMS: f32 = 0.006;
/// Silence that ends a wake-word note, counted only after the speaker has been heard.
pub const SILENCE_MS: u64 = 1_500;
/// Speech a wake-word note needs before silence can end it, so a pause right after the wake word
/// does not cut the sentence.
pub const MIN_SPEECH_MS: u64 = 1_000;
/// The hard cap on a wake-word note, the same one the panel's own recordings get.
pub const MAX_RECORDING_MS: u64 = 60_000;

/// What an armed listener reports (S30.7), on a thread of its own.
#[derive(Debug, Clone, PartialEq)]
pub enum ListenEvent {
    Detected(super::wake::Detection),
    /// A wake-word note heard `SILENCE_MS` of silence after speech, or reached the hard cap (S6).
    Silent,
}

/// Where the wake word's findings go; called from any thread, never from the audio thread.
pub type ListenEvents = Arc<dyn Fn(ListenEvent) + Send + Sync>;

#[derive(Clone)]
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
    /// Ids the listener's audio is checked against, so audio from a closed listener is ignored.
    next_listen: AtomicU64,
}

enum State {
    /// Nothing is recording. `armed` is the wake word's listener, when one is waiting.
    Idle { next: u64, armed: Option<Armed> },
    Starting { recording: u64, cancelled: bool, failure: Option<String> },
    Recording(Session),
    Stopping(Session),
}

/// Waiting for the wake word on an open capture, so the detector reads the microphone the app
/// already has instead of opening a second one (S2).
struct Armed {
    id: u64,
    /// `None` while the capture opens: a recording must not start on top of it.
    stream: Option<Box<dyn Stream>>,
    /// Reset when the listener is disarmed, so the next note never starts with old audio in it.
    wake: Arc<dyn WakeWord>,
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
    /// Set only for the note the wake word started (S6): it ends itself, and says so here.
    woken: Option<Woken>,
}

/// A note the wake word started: it reports its own end, and the machine cuts it by energy.
struct Woken {
    listen: ListenEvents,
    stop: AutoStop,
}

/// Energy over the same stream (S6): speech and silence, in milliseconds of audio heard.
struct AutoStop {
    speech_ms: u64,
    silence_ms: u64,
    heard_ms: u64,
    fired: bool,
}

impl AutoStop {
    fn new() -> Self {
        AutoStop { speech_ms: 0, silence_ms: 0, heard_ms: 0, fired: false }
    }

    /// Counts one chunk and answers whether the note is over, once and only once.
    fn accept(&mut self, samples: &[f32]) -> bool {
        let chunk_ms = samples.len() as u64 * 1_000 / u64::from(audio::SAMPLE_RATE);
        self.heard_ms += chunk_ms;
        if audio::rms(samples) >= SPEECH_RMS {
            self.speech_ms += chunk_ms;
            self.silence_ms = 0;
        } else if self.speech_ms >= MIN_SPEECH_MS {
            self.silence_ms += chunk_ms;
        }
        let due = self.heard_ms >= MAX_RECORDING_MS || self.silence_ms >= SILENCE_MS;
        if due && !self.fired {
            self.fired = true;
            return true;
        }
        false
    }
}

/// The recognition, closed once finished or cancelled so no audio follows `finish`.
struct Feed {
    recognition: Box<dyn Recognition>,
    open: bool,
}

impl Feed {
    /// The device's own buffer when the recognition takes it, else the 16 kHz stream.
    fn push(&mut self, samples: &[f32], native: Option<&NativeAudio>) {
        if !self.open {
            return;
        }
        match native {
            Some(native) if self.recognition.wants_native() => self.recognition.feed_native(native),
            _ if !samples.is_empty() => self.recognition.feed(samples),
            _ => {}
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
        // Nothing is recording, and the listener that made room for the recording stays disarmed:
        // whoever wants it back arms it again (the app, once the note is delivered).
        State::Idle { next: self.recording().map_or(0, |n| n + 1), armed: None }
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

/// Releases a listener's capture and its detector state, outside the state lock.
fn close_listener(armed: Option<Armed>) {
    if let Some(armed) = armed {
        armed.wake.reset();
        if let Some(mut stream) = armed.stream {
            stream.close();
        }
    }
}

/// Whether the listener `id` is still the one waiting: an id the machine dropped hears nothing.
fn armed(inner: &Inner, id: u64) -> bool {
    matches!(&*lock(&inner.state), State::Idle { armed: Some(armed), .. } if armed.id == id && armed.stream.is_some())
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
        let inner = Inner {
            microphone,
            recognizer,
            clock,
            state: Mutex::new(State::Idle { next: 0, armed: None }),
            changed: Condvar::new(),
            next_listen: AtomicU64::new(0),
        };
        Voice { inner: Arc::new(inner), final_timeout: FINAL_TIMEOUT }
    }

    /// Waits for the wake word on the microphone's own capture (S2), reporting through `events`.
    /// Only while idle: a recording owns the microphone, and a second listener would open it
    /// twice.
    pub fn arm(&self, wake: Arc<dyn WakeWord>, events: ListenEvents) -> Result<(), VoiceError> {
        let id = self.inner.next_listen.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = lock(&self.inner.state);
            let State::Idle { armed, .. } = &mut *state else { return Err(VoiceError::Busy) };
            if armed.is_some() {
                return Err(VoiceError::Busy);
            }
            *armed = Some(Armed { id, stream: None, wake: wake.clone() });
        }
        let opened = self.inner.microphone.open(AudioSink::Listener(self.listener(id, wake, events)));
        let mut state = lock(&self.inner.state);
        match opened {
            Ok(stream) => match &mut *state {
                State::Idle { armed: Some(armed), .. } if armed.id == id => {
                    armed.stream = Some(stream);
                    Ok(())
                }
                // Disarmed or taken over while the capture was opening: the recording keeps the
                // microphone, and this stream goes away without ever running beside it.
                _ => {
                    drop(state);
                    let mut stream = stream;
                    stream.close();
                    Err(VoiceError::Cancelled)
                }
            },
            Err(error) => {
                if matches!(&*state, State::Idle { armed: Some(armed), .. } if armed.id == id) {
                    let idle = state.idle();
                    *state = idle;
                }
                Err(error)
            }
        }
    }

    /// Stops waiting for the wake word; harmless when it is not listening.
    pub fn disarm(&self) {
        let armed = {
            let mut state = lock(&self.inner.state);
            let State::Idle { armed, .. } = &mut *state else { return };
            armed.take()
        };
        close_listener(armed);
    }

    /// The detector's end of the capture: it runs on the audio thread, so it only matches, and
    /// the handler gets its own thread (`ListenEvent` is never fired from the audio thread).
    fn listener(&self, id: u64, wake: Arc<dyn WakeWord>, events: ListenEvents) -> Listener {
        let inner = Arc::downgrade(&self.inner);
        Arc::new(move |samples: &[f32]| {
            let Some(inner) = inner.upgrade() else { return };
            // Outside the lock: matching must never wait for a command, and a command must never
            // wait for the detector.
            if !armed(&inner, id) {
                return;
            }
            let Some(detection) = wake.accept(samples) else { return };
            if !armed(&inner, id) {
                return;
            }
            let events = events.clone();
            // The handler starts a note, which can prompt for a permission: never here.
            std::thread::spawn(move || events(ListenEvent::Detected(detection)));
        })
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
        let reason = recognizer
            .availability()
            .err()
            .or_else(|| blocked(recognizer.authorization(), VoiceError::SpeechDenied, VoiceError::SpeechRestricted))
            .or_else(|| blocked(microphone.authorization(), VoiceError::MicrophoneDenied, VoiceError::MicrophoneRestricted))
            .or_else(|| locale::resolve(None, &recognizer.current_locale(), &recognizer.supported_locales()).err());
        match reason {
            Some(reason) => VoiceStatus::unavailable(reason.to_string()),
            None => VoiceStatus::available(),
        }
    }

    /// Starts recording, prompting for permissions first when they were never asked. Blocks
    /// while a prompt is open, so it runs off the main thread. `events` reach the caller. The
    /// wake word's listener is dropped first: two captures never overlap (S2).
    pub fn start(&self, requested: Option<&str>, events: Events) -> Result<(), VoiceError> {
        self.begin(requested, events, None)
    }

    /// Starts the note the wake word asked for (S3): the same path as the panel's button, plus
    /// the automatic stop, which reports through `listen` (S6).
    pub fn start_woken(&self, requested: Option<&str>, events: Events, listen: ListenEvents) -> Result<(), VoiceError> {
        self.begin(requested, events, Some(Woken { listen, stop: AutoStop::new() }))
    }

    fn begin(&self, requested: Option<&str>, events: Events, woken: Option<Woken>) -> Result<(), VoiceError> {
        self.disarm();
        let (recording, previous) = {
            let mut state = lock(&self.inner.state);
            let State::Idle { next, armed } = &mut *state else { return Err(VoiceError::Busy) };
            // A listener still opening would open the device a second time.
            if armed.as_ref().is_some_and(|armed| armed.stream.is_none()) {
                return Err(VoiceError::Busy);
            }
            // An arm that landed since `disarm` is closed outside the lock, not dropped in it.
            let previous = armed.take();
            let next = *next;
            *state = State::Starting { recording: next, cancelled: false, failure: None };
            (next, previous)
        };
        close_listener(previous);
        let sink = Sink { inner: Arc::downgrade(&self.inner), recording };
        let begun = self.prepare(requested, recording).and_then(|locale| {
            let mut recognition = self.inner.recognizer.begin(&locale, sink.clone())?;
            match self.inner.microphone.open(AudioSink::Recording(sink)) {
                Ok(stream) => Ok((stream, recognition)),
                Err(error) => {
                    recognition.cancel();
                    Err(error)
                }
            }
        });
        let mut state = lock(&self.inner.state);
        let State::Starting { cancelled, failure, .. } = std::mem::replace(&mut *state, State::Idle { next: recording + 1, armed: None }) else {
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
            woken,
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

    /// Availability and locale first (no point prompting without a recognizer), then Speech,
    /// then Microphone.
    fn prepare(&self, requested: Option<&str>, recording: u64) -> Result<String, VoiceError> {
        let (recognizer, microphone) = (&self.inner.recognizer, &self.inner.microphone);
        recognizer.availability()?;
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
    /// the recognizer does not answer within the timeout (the recognition's own, when it sets
    /// one, else the machine's). Blocks, so it runs off the main thread.
    pub fn stop(&self) -> Result<Transcript, VoiceError> {
        let (recording, mut stream, feed) = {
            let mut state = lock(&self.inner.state);
            match std::mem::replace(&mut *state, State::Idle { next: 0, armed: None }) {
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
        let timeout = {
            let mut feed = lock(&feed);
            feed.finish();
            feed.recognition.final_timeout().unwrap_or(self.final_timeout)
        };

        let deadline = Instant::now() + timeout;
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
        self.capture(samples, None);
    }

    /// The same, with the device's own buffer it came from: a recognition that wants it gets
    /// the buffer instead of the samples (S30.6); the meter still follows the samples, which
    /// may be empty while the resampler fills its first period.
    pub fn audio_native(&self, samples: &[f32], native: &NativeAudio) {
        self.capture(samples, Some(native));
    }

    fn capture(&self, samples: &[f32], native: Option<&NativeAudio>) {
        let Some(inner) = self.inner.upgrade() else { return };
        let (feed, level, silent) = {
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
            // The automatic stop is only for the note the wake word started (S6).
            let silent = session.woken.as_mut().and_then(|woken| {
                woken.stop.accept(samples).then(|| woken.listen.clone())
            });
            (session.feed.clone(), level, silent)
        };
        if let Some((events, level)) = level {
            events(level);
        }
        if let Some(listen) = silent {
            // Stopping the note waits for the final transcript: never on the audio thread.
            std::thread::spawn(move || listen(ListenEvent::Silent));
        }
        lock(&feed).push(samples, native);
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
    use crate::voice::fake::{FakeClock, FakeMicrophone, FakeNative, FakeRecognizer, Gate, Listenings, Recorder};
    use crate::voice::wake::FakeWake;
    use crate::voice::{Authorization, Detection, ListenEvent, Transcript, VoiceError, VoiceEvent, VoiceStatus};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use std::time::Duration;

    struct Rig {
        voice: Voice,
        mic: Arc<FakeMicrophone>,
        recognizer: Arc<FakeRecognizer>,
        clock: Arc<FakeClock>,
        recorder: Recorder,
        listenings: Listenings,
    }

    fn rig(mic: FakeMicrophone, recognizer: FakeRecognizer) -> Rig {
        let (mic, recognizer) = (Arc::new(mic), Arc::new(recognizer));
        let clock = Arc::new(FakeClock(AtomicU64::new(1_000)));
        let voice = Voice::new(mic.clone(), recognizer.clone(), clock.clone()).with_final_timeout(Duration::from_millis(50));
        Rig { voice, mic, recognizer, clock, recorder: Recorder::default(), listenings: Listenings::default() }
    }

    fn granted() -> Rig {
        rig(FakeMicrophone::granted(), FakeRecognizer::granted())
    }

    impl Rig {
        fn start(&self) -> Result<(), VoiceError> {
            self.voice.start(None, self.recorder.events())
        }

        fn listen(&self, wake: &Arc<FakeWake>) -> Result<(), VoiceError> {
            self.voice.arm(wake.clone(), self.listenings.events())
        }

        /// Feeds the microphone's tap: 10 ms chunks of a constant level, so rms == `level`.
        fn feed(&self, level: f32, ms: u64) {
            let sink = self.mic.sink();
            for _ in 0..(ms / 10) {
                sink.audio(&[level; 160]);
            }
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
    fn a_recognition_that_wants_native_audio_gets_the_device_buffers_instead_of_the_16k_stream() {
        let mut recognizer = FakeRecognizer::granted();
        recognizer.native = true;
        let rig = rig(FakeMicrophone::granted(), recognizer);
        rig.start().unwrap();
        let sink = rig.mic.sink();
        let buffer = FakeNative { rate: 48_000, frames: 480 };
        sink.audio_native(&[0.5; 160], &buffer);
        sink.audio_native(&[0.5; 160], &buffer);
        let log = rig.recognizer.log.lock().unwrap();
        assert_eq!(log.native, vec![buffer.clone(), buffer]);
        assert!(log.fed.is_empty(), "the 16 kHz stream is not fed as well");
        assert_eq!(rig.recorder.levels(), 1, "the meter still follows the 16 kHz stream");
    }

    #[test]
    fn the_16k_stream_feeds_a_recognition_that_does_not_want_native_audio() {
        let rig = granted();
        rig.start().unwrap();
        rig.mic.sink().audio_native(&[0.25; 160], &FakeNative { rate: 48_000, frames: 480 });
        let log = rig.recognizer.log.lock().unwrap();
        assert_eq!(log.fed, vec![0.25; 160]);
        assert!(log.native.is_empty());
    }

    #[test]
    fn without_device_buffers_a_recognition_that_wants_them_gets_the_16k_stream() {
        let mut recognizer = FakeRecognizer::granted();
        recognizer.native = true;
        let rig = rig(FakeMicrophone::granted(), recognizer);
        rig.start().unwrap();
        rig.mic.sink().audio(&[0.25; 160]);
        assert_eq!(rig.recognizer.log.lock().unwrap().fed.len(), 160);
    }

    #[test]
    fn a_device_buffer_with_no_16k_samples_yet_still_reaches_a_native_recognition() {
        let mut recognizer = FakeRecognizer::granted();
        recognizer.native = true;
        let rig = rig(FakeMicrophone::granted(), recognizer);
        rig.start().unwrap();
        rig.mic.sink().audio_native(&[], &FakeNative { rate: 48_000, frames: 2 });
        assert_eq!(rig.recognizer.log.lock().unwrap().native.len(), 1);
    }

    #[test]
    fn no_device_buffers_reach_the_recognizer_after_stop() {
        let mut recognizer = FakeRecognizer::granted();
        recognizer.native = true;
        let rig = rig(FakeMicrophone::granted(), recognizer);
        rig.start().unwrap();
        let sink = rig.mic.sink();
        rig.voice.stop().unwrap();
        sink.audio_native(&[0.5; 160], &FakeNative { rate: 48_000, frames: 480 });
        assert!(rig.recognizer.log.lock().unwrap().native.is_empty());
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

        fn open(&self, sink: crate::voice::AudioSink) -> Result<Box<dyn crate::voice::Stream>, VoiceError> {
            self.1.sink().failed("Siri and Dictation are disabled.");
            self.0.open(sink)
        }
    }

    /// Speech at -26 dBFS: above `SPEECH_RMS` with room to spare, as measured on this machine.
    const SPEECH: f32 = 0.05;

    #[test]
    fn the_listener_owns_the_microphone_until_a_recording_takes_it() {
        let rig = granted();
        let wake = Arc::new(FakeWake::default());
        rig.listen(&wake).unwrap();
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1);
        assert_eq!(rig.listen(&wake), Err(VoiceError::Busy), "one listener at a time");
        assert_eq!(rig.start(), Ok(()));
        let log = rig.mic.log.lock().unwrap();
        assert_eq!((log.closed, log.opened), (1, 2), "the listener is closed before the recording opens");
        drop(log);
        assert_eq!(wake.resets(), 1, "the detector drops what it had buffered");
    }

    #[test]
    fn arming_is_refused_while_recording() {
        let rig = granted();
        rig.start().unwrap();
        let wake = Arc::new(FakeWake::default());
        assert_eq!(rig.listen(&wake), Err(VoiceError::Busy));
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1, "no second capture is opened");
    }

    #[test]
    fn a_detection_is_reported_once_and_off_the_audio_thread() {
        let rig = granted();
        let wake = Arc::new(FakeWake::default());
        rig.listen(&wake).unwrap();
        wake.detect(0.51);
        for _ in 0..3 {
            rig.mic.sink().audio(&[0.01; 160]);
        }
        let seen = rig.listenings.wait_for(1);
        assert_eq!(seen, vec![ListenEvent::Detected(Detection { name: "oye-dot".into(), score: 0.51 })]);
        assert_eq!(wake.heard(), 480, "every chunk reached the detector");
        assert_ne!(rig.listenings.threads()[0], std::thread::current().id(), "the handler gets its own thread");
    }

    #[test]
    fn a_disarmed_listener_hears_nothing_and_can_be_armed_again() {
        let rig = granted();
        let wake = Arc::new(FakeWake::default());
        rig.listen(&wake).unwrap();
        rig.voice.disarm();
        assert_eq!(rig.mic.log.lock().unwrap().closed, 1);
        let heard = wake.heard();
        // Audio that arrives after the capture was closed is ignored, not matched.
        rig.mic.sink().audio(&[0.1; 160]);
        assert_eq!(wake.heard(), heard);
        assert!(rig.listenings.settle().is_empty());
        rig.listen(&wake).unwrap();
        assert_eq!(rig.mic.log.lock().unwrap().opened, 2);
    }

    #[test]
    fn the_wake_word_waits_again_once_a_recording_ends() {
        let rig = granted();
        let wake = Arc::new(FakeWake::default());
        rig.listen(&wake).unwrap();
        rig.start().unwrap();
        rig.voice.stop().unwrap();
        assert_eq!(rig.listen(&wake), Ok(()), "a finished recording leaves the listener disarmed");
        assert_eq!(rig.mic.log.lock().unwrap().opened, 3);
    }

    #[test]
    fn a_woken_note_is_not_cut_before_a_second_of_speech() {
        let rig = granted();
        rig.voice.start_woken(None, rig.recorder.events(), rig.listenings.events()).unwrap();
        rig.feed(SPEECH, 900);
        rig.feed(0.0, 5_000);
        assert!(rig.listenings.settle().is_empty(), "a pause right after the phrase cannot cut the note");
        assert_eq!(rig.voice.stop().map(|transcript| transcript.text), Ok(String::new()));
    }

    #[test]
    fn a_woken_note_is_cut_after_silence_that_follows_speech() {
        let rig = granted();
        rig.voice.start_woken(None, rig.recorder.events(), rig.listenings.events()).unwrap();
        rig.feed(SPEECH, 1_000);
        rig.feed(0.0, 1_490);
        assert!(rig.listenings.settle().is_empty(), "the cut waits for a second and a half of silence");
        rig.feed(0.0, 20);
        assert_eq!(rig.listenings.wait_for(1), vec![ListenEvent::Silent]);
        rig.feed(0.0, 1_000);
        assert_eq!(rig.listenings.settle().len(), 1, "the cut happens once");
    }

    #[test]
    fn a_button_note_never_stops_itself() {
        let rig = granted();
        rig.start().unwrap();
        rig.feed(SPEECH, 2_000);
        rig.feed(0.0, 10_000);
        assert!(rig.listenings.settle().is_empty(), "the automatic stop is only for the wake word's note");
    }

    #[test]
    fn a_woken_note_still_stops_at_the_hard_cap() {
        let rig = granted();
        rig.voice.start_woken(None, rig.recorder.events(), rig.listenings.events()).unwrap();
        // Speech without a pause: nothing but the cap ends this note.
        rig.feed(SPEECH, MAX_RECORDING_MS + 100);
        assert_eq!(rig.listenings.wait_for(1), vec![ListenEvent::Silent]);
    }
}
