//! The local model backend (S30.5): NVIDIA Parakeet TDT 0.6B v3 (int8) through sherpa-onnx's
//! offline transducer recognizer, on the CPU. Parakeet is not streaming: a recognition keeps the
//! recording's PCM and decodes it once `finish` is called, on a thread of its own, then answers
//! through `Sink::finished`. There are no partials. It detects the language itself (25 European
//! languages), so the locale is ignored, and it needs no Speech Recognition permission.
//!
//! The loaded model (about 0.7 GB in memory) is shared by recordings: loading starts in the
//! background when a recording begins, so it overlaps the speaking, and the model is dropped
//! after `IDLE_UNLOAD` without use, or when the files are removed (`release`).

use super::audio::SAMPLE_RATE;
use super::{Authorization, Recognition, Recognizer, Sink, VoiceError};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// sherpa-onnx's name for NeMo transducers such as Parakeet TDT.
pub const MODEL_TYPE: &str = "nemo_transducer";
/// Five minutes at 16 kHz; later audio is dropped.
pub const MAX_SAMPLES: usize = SAMPLE_RATE as usize * 300;
/// How long `stop` waits for a transcript: a cold load plus decoding a long recording.
pub const DECODE_TIMEOUT: Duration = Duration::from_secs(60);
/// An unused model is dropped after this long.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(300);
/// The locale Parakeet reports: it picks the language from the audio.
const AUTO: &str = "auto";

/// Decoding threads: up to four, leaving the rest of the machine alone.
pub fn threads() -> i32 {
    std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, 4) as i32
}

/// The recognizer configuration for a model directory holding the release's int8 files.
pub fn config(dir: &Path, threads: i32) -> OfflineRecognizerConfig {
    let path = |name: &str| Some(dir.join(name).display().to_string());
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: path("encoder.int8.onnx"),
        decoder: path("decoder.int8.onnx"),
        joiner: path("joiner.int8.onnx"),
    };
    config.model_config.tokens = path("tokens.txt");
    config.model_config.model_type = Some(MODEL_TYPE.into());
    config.model_config.provider = Some("cpu".into());
    config.model_config.num_threads = threads;
    config.model_config.debug = false;
    config.decoding_method = Some("greedy_search".into());
    config.feat_config.sample_rate = SAMPLE_RATE as i32;
    config.feat_config.feature_dim = 80;
    config
}

/// A loaded model: 16 kHz mono PCM in, text out. Blocks while decoding.
pub trait Engine: Send + Sync {
    fn transcribe(&self, samples: &[f32]) -> Result<String, String>;
}

/// Where the installed model is, if it is.
pub type Locate = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;
/// Loads the model in a directory. Slow (seconds), so never on the main thread.
pub type Loader = Arc<dyn Fn(&Path) -> Result<Arc<dyn Engine>, String> + Send + Sync>;

struct Sherpa(OfflineRecognizer);

impl Engine for Sherpa {
    fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let stream = self.0.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.0.decode(&stream);
        stream.get_result().map(|result| result.text).ok_or_else(|| "The local voice model returned no result.".into())
    }
}

/// Loads Parakeet with sherpa-onnx.
pub fn load(dir: &Path) -> Result<Arc<dyn Engine>, String> {
    OfflineRecognizer::create(&config(dir, threads()))
        .map(|recognizer| Arc::new(Sherpa(recognizer)) as Arc<dyn Engine>)
        .ok_or_else(|| "The local voice model could not be loaded. Remove it and download it again.".into())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The shared loaded model.
struct Cache {
    loader: Loader,
    slot: Mutex<Option<(PathBuf, Arc<dyn Engine>)>>,
    /// Bumped on every use, so an idle timer knows whether the model was used since.
    uses: AtomicU64,
}

impl Cache {
    /// The model in `dir`, loading it (once) if needed; concurrent callers wait for one load.
    /// Each use restarts the idle countdown.
    fn get(self: &Arc<Self>, dir: &Path, idle: Duration) -> Result<Arc<dyn Engine>, String> {
        self.uses.fetch_add(1, Ordering::SeqCst);
        let engine = {
            let mut slot = lock(&self.slot);
            match slot.as_ref() {
                Some((loaded, engine)) if loaded == dir => engine.clone(),
                _ => {
                    // Another model's memory goes before the next one loads.
                    *slot = None;
                    let engine = (self.loader)(dir)?;
                    *slot = Some((dir.to_path_buf(), engine.clone()));
                    engine
                }
            }
        };
        self.unload_when_idle(idle);
        Ok(engine)
    }

    fn release(&self) {
        *lock(&self.slot) = None;
    }

    /// Drops the model after `idle` unless it is used again before.
    fn unload_when_idle(self: &Arc<Self>, idle: Duration) {
        let mark = self.uses.load(Ordering::SeqCst);
        let cache = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("voice-model-idle".into()).spawn(move || {
            std::thread::sleep(idle);
            if let Some(cache) = cache.upgrade() {
                if cache.uses.load(Ordering::SeqCst) == mark {
                    cache.release();
                }
            }
        });
    }
}

/// The Parakeet recognizer, present when the model is installed.
pub struct Parakeet {
    locate: Locate,
    cache: Arc<Cache>,
    idle: Duration,
}

impl Parakeet {
    pub fn new(locate: Locate, loader: Loader) -> Self {
        let cache = Cache { loader, slot: Mutex::new(None), uses: AtomicU64::new(0) };
        Parakeet { locate, cache: Arc::new(cache), idle: IDLE_UNLOAD }
    }

    pub fn with_idle(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    pub fn installed(&self) -> bool {
        (self.locate)().is_some()
    }

    /// Whether the model is in memory.
    pub fn loaded(&self) -> bool {
        lock(&self.cache.slot).is_some()
    }

    /// Drops the loaded model (its files were removed). A decode in flight keeps its copy.
    pub fn release(&self) {
        self.cache.release();
    }
}

impl Recognizer for Parakeet {
    fn availability(&self) -> Result<(), VoiceError> {
        if self.installed() {
            Ok(())
        } else {
            Err(VoiceError::NoModel)
        }
    }

    fn authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn request_authorization(&self) -> Authorization {
        Authorization::Authorized
    }

    fn current_locale(&self) -> String {
        AUTO.into()
    }

    fn supported_locales(&self) -> Vec<String> {
        vec![AUTO.into()]
    }

    fn begin(&self, _locale: &str, sink: Sink) -> Result<Box<dyn Recognition>, VoiceError> {
        let dir = (self.locate)().ok_or(VoiceError::NoModel)?;
        // Load while the user speaks; `finish` waits for this load instead of starting another.
        let (cache, warm, idle) = (self.cache.clone(), dir.clone(), self.idle);
        let _ = std::thread::Builder::new().name("voice-model-load".into()).spawn(move || {
            if let Err(error) = cache.get(&warm, idle) {
                eprintln!("gentle-dot: {error}");
            }
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        Ok(Box::new(ParakeetRecognition {
            dir,
            sink,
            cache: self.cache.clone(),
            idle: self.idle,
            samples: Samples::default(),
            cancelled,
        }))
    }
}

/// The recording so far, capped at `MAX_SAMPLES`.
#[derive(Default)]
pub(crate) struct Samples(Vec<f32>);

impl Samples {
    pub(crate) fn push(&mut self, samples: &[f32]) {
        let room = MAX_SAMPLES.saturating_sub(self.0.len());
        self.0.extend_from_slice(&samples[..samples.len().min(room)]);
    }

    pub(crate) fn take(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.0)
    }
}

struct ParakeetRecognition {
    dir: PathBuf,
    sink: Sink,
    cache: Arc<Cache>,
    idle: Duration,
    samples: Samples,
    cancelled: Arc<AtomicBool>,
}

impl Recognition for ParakeetRecognition {
    fn feed(&mut self, samples: &[f32]) {
        self.samples.push(samples);
    }

    fn finish(&mut self) {
        let samples = self.samples.take();
        let (dir, sink, cache, idle, cancelled) =
            (self.dir.clone(), self.sink.clone(), self.cache.clone(), self.idle, self.cancelled.clone());
        let decode = move || {
            let result = cache.get(&dir, idle).and_then(|engine| {
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(None);
                }
                engine.transcribe(&samples).map(Some)
            });
            match result {
                Ok(Some(text)) => sink.finished(text.trim()),
                Ok(None) => {}
                Err(error) => {
                    eprintln!("gentle-dot: {error}");
                    sink.failed(&error);
                }
            }
        };
        if let Err(error) = std::thread::Builder::new().name("voice-model-decode".into()).spawn(decode) {
            // `finish` runs while stopping, where a failure only resolves `stop`.
            self.sink.failed(&format!("The local voice model could not start: {error}"));
        }
    }

    fn cancel(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.samples.take();
    }

    fn final_timeout(&self) -> Option<Duration> {
        Some(DECODE_TIMEOUT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeMicrophone, Gate, Recorder};
    use crate::voice::{Authorization, Recognizer, Transcript, Voice, VoiceError, VoiceStatus};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn the_config_points_at_the_int8_transducer_files_of_the_model_dir() {
        let dir = Path::new("/models/parakeet-tdt-0.6b-v3-int8");
        let config = config(dir, 3);
        let model = &config.model_config;
        let path = |name: &str| Some(dir.join(name).display().to_string());
        assert_eq!(model.transducer.encoder, path("encoder.int8.onnx"));
        assert_eq!(model.transducer.decoder, path("decoder.int8.onnx"));
        assert_eq!(model.transducer.joiner, path("joiner.int8.onnx"));
        assert_eq!(model.tokens, path("tokens.txt"));
        assert_eq!(model.model_type.as_deref(), Some("nemo_transducer"));
        assert_eq!(MODEL_TYPE, "nemo_transducer");
        assert_eq!(model.provider.as_deref(), Some("cpu"));
        assert_eq!(model.num_threads, 3);
        assert!(!model.debug);
        assert_eq!(config.decoding_method.as_deref(), Some("greedy_search"));
        assert_eq!(config.feat_config.sample_rate, 16_000);
        assert_eq!(config.feat_config.feature_dim, 80);
    }

    #[test]
    fn decoding_uses_a_few_threads() {
        assert!((1..=4).contains(&threads()));
    }

    /// Transcribes to "<n> samples", once the gate (if any) opens, recording the thread.
    struct FakeEngine {
        gate: Option<Arc<Gate>>,
        threads: Arc<Mutex<Vec<std::thread::ThreadId>>>,
    }

    impl Engine for FakeEngine {
        fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
            self.threads.lock().unwrap().push(std::thread::current().id());
            if let Some(gate) = &self.gate {
                gate.wait();
            }
            Ok(format!(" {} samples ", samples.len()))
        }
    }

    struct Setup {
        installed: Arc<AtomicBool>,
        loads: Arc<AtomicUsize>,
        dirs: Arc<Mutex<Vec<PathBuf>>>,
        threads: Arc<Mutex<Vec<std::thread::ThreadId>>>,
        fail_load: Arc<AtomicBool>,
        gate: Option<Arc<Gate>>,
    }

    impl Setup {
        fn new(gate: Option<Arc<Gate>>) -> Self {
            Setup {
                installed: Arc::new(AtomicBool::new(true)),
                loads: Arc::default(),
                dirs: Arc::default(),
                threads: Arc::default(),
                fail_load: Arc::default(),
                gate,
            }
        }

        fn parakeet(&self) -> Parakeet {
            let installed = self.installed.clone();
            let locate: Locate = Arc::new(move || installed.load(Ordering::SeqCst).then(|| PathBuf::from("/models/p")));
            let (loads, dirs, threads, fail, gate) =
                (self.loads.clone(), self.dirs.clone(), self.threads.clone(), self.fail_load.clone(), self.gate.clone());
            let loader: Loader = Arc::new(move |dir: &Path| {
                loads.fetch_add(1, Ordering::SeqCst);
                dirs.lock().unwrap().push(dir.to_path_buf());
                if fail.load(Ordering::SeqCst) {
                    return Err("The local voice model could not be loaded.".into());
                }
                Ok(Arc::new(FakeEngine { gate: gate.clone(), threads: threads.clone() }) as Arc<dyn Engine>)
            });
            Parakeet::new(locate, loader)
        }
    }

    fn voice(parakeet: Arc<Parakeet>) -> (Voice, Arc<FakeMicrophone>) {
        let mic = Arc::new(FakeMicrophone::granted());
        let clock = Arc::new(FakeClock(AtomicU64::new(0)));
        (Voice::new(mic.clone(), parakeet, clock).with_final_timeout(Duration::from_millis(50)), mic)
    }

    fn wait_until(what: &str, check: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn it_needs_no_speech_permission_and_detects_the_language_itself() {
        let parakeet = Setup::new(None).parakeet();
        assert_eq!(parakeet.authorization(), Authorization::Authorized);
        assert_eq!(parakeet.request_authorization(), Authorization::Authorized);
        assert_eq!(parakeet.availability(), Ok(()));
        let locales = parakeet.supported_locales();
        assert_eq!(crate::voice::locale::resolve(Some("es-AR"), &parakeet.current_locale(), &locales), Ok("auto".into()));
    }

    #[test]
    fn without_the_model_it_is_unavailable() {
        let setup = Setup::new(None);
        setup.installed.store(false, Ordering::SeqCst);
        let parakeet = Arc::new(setup.parakeet());
        assert!(!parakeet.installed());
        assert_eq!(parakeet.availability(), Err(VoiceError::NoModel));
        let (voice, _) = voice(parakeet);
        assert_eq!(voice.status(), VoiceStatus::unavailable(VoiceError::NoModel.to_string()));
        assert_eq!(voice.start(None, Recorder::default().events()), Err(VoiceError::NoModel));
    }

    #[test]
    fn stop_decodes_the_recorded_pcm_off_the_calling_thread() {
        let gate = Arc::new(Gate::default());
        let setup = Setup::new(Some(gate.clone()));
        let (voice, mic) = voice(Arc::new(setup.parakeet()));
        let recorder = Recorder::default();
        voice.start(None, recorder.events()).unwrap();
        mic.sink().audio(&[0.1; 1_600]);
        mic.sink().audio(&[0.2; 800]);

        let voice = Arc::new(voice);
        let stopping = {
            let voice = voice.clone();
            std::thread::spawn(move || (std::thread::current().id(), voice.stop()))
        };
        wait_until("the decoder", || !setup.threads.lock().unwrap().is_empty());
        // Decoding outlives the default final timeout (50 ms here): stop keeps waiting for it.
        std::thread::sleep(Duration::from_millis(150));
        gate.release();
        let (stop_thread, result) = stopping.join().unwrap();
        assert_eq!(result, Ok(Transcript { text: "2400 samples".into() }));
        assert_ne!(setup.threads.lock().unwrap()[0], stop_thread, "decoding runs on its own thread");
        assert!(recorder.seen().iter().all(|e| !matches!(e, crate::voice::VoiceEvent::Partial(_))), "no partials");
    }

    #[test]
    fn the_model_is_loaded_once_when_recording_starts_and_reused() {
        let setup = Setup::new(None);
        let parakeet = Arc::new(setup.parakeet());
        let (voice, mic) = voice(parakeet.clone());
        for _ in 0..2 {
            voice.start(None, Recorder::default().events()).unwrap();
            mic.sink().audio(&[0.0; 160]);
            assert_eq!(voice.stop(), Ok(Transcript { text: "160 samples".into() }));
        }
        assert_eq!(setup.loads.load(Ordering::SeqCst), 1);
        assert_eq!(setup.dirs.lock().unwrap().as_slice(), [PathBuf::from("/models/p")]);
        assert!(parakeet.loaded());

        parakeet.release();
        assert!(!parakeet.loaded());
        voice.start(None, Recorder::default().events()).unwrap();
        voice.stop().unwrap();
        assert_eq!(setup.loads.load(Ordering::SeqCst), 2, "released models load again");
    }

    #[test]
    fn an_idle_model_is_unloaded() {
        let setup = Setup::new(None);
        let parakeet = Arc::new(setup.parakeet().with_idle(Duration::from_millis(30)));
        let (voice, _) = voice(parakeet.clone());
        voice.start(None, Recorder::default().events()).unwrap();
        voice.stop().unwrap();
        assert!(parakeet.loaded());
        wait_until("the idle unload", || !parakeet.loaded());
    }

    #[test]
    fn a_model_that_cannot_load_resolves_stop_without_text() {
        let setup = Setup::new(None);
        setup.fail_load.store(true, Ordering::SeqCst);
        let (voice, mic) = voice(Arc::new(setup.parakeet()));
        voice.start(None, Recorder::default().events()).unwrap();
        mic.sink().audio(&[0.0; 160]);
        assert_eq!(voice.stop(), Ok(Transcript { text: String::new() }));
    }

    #[test]
    fn cancel_discards_the_recording_without_decoding_it() {
        let setup = Setup::new(None);
        let (voice, mic) = voice(Arc::new(setup.parakeet()));
        voice.start(None, Recorder::default().events()).unwrap();
        mic.sink().audio(&[0.0; 160]);
        voice.cancel().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        assert!(setup.threads.lock().unwrap().is_empty());
    }

    #[test]
    fn recordings_are_capped() {
        let mut samples = Samples::default();
        samples.push(&vec![0.0; MAX_SAMPLES - 10]);
        samples.push(&[0.0; 25]);
        assert_eq!(samples.take().len(), MAX_SAMPLES);
        assert_eq!(MAX_SAMPLES, 16_000 * 300, "five minutes at 16 kHz");
    }

    /// Decodes a short WAV with the real model. Run with
    /// `GENTLE_DOT_PARAKEET_DIR=<dir with the four files> cargo test -- --ignored real_parakeet`;
    /// `GENTLE_DOT_PARAKEET_WAV` picks the clip (default `<dir>/test_wavs/en.wav`).
    #[test]
    #[ignore = "needs the real Parakeet model (about 640 MB)"]
    fn real_parakeet_decodes_a_wav() {
        let Some(dir) = std::env::var_os("GENTLE_DOT_PARAKEET_DIR").map(PathBuf::from) else {
            eprintln!("GENTLE_DOT_PARAKEET_DIR is not set; skipping");
            return;
        };
        let wav = std::env::var_os("GENTLE_DOT_PARAKEET_WAV")
            .map(PathBuf::from)
            .unwrap_or_else(|| dir.join("test_wavs/en.wav"));
        let wave = sherpa_onnx::Wave::read(&wav.display().to_string()).expect("a readable WAV");
        // The release's clips are 24 kHz; the microphone delivers 16 kHz, so resample like it.
        let pcm = crate::voice::audio::Resampler::new(f64::from(wave.sample_rate())).process(wave.samples());
        let started = std::time::Instant::now();
        let engine = load(&dir).expect("the model loads");
        let loaded = started.elapsed();
        let text = engine.transcribe(&pcm).expect("a transcript");
        eprintln!("loaded in {loaded:?}, decoded in {:?}: {text}", started.elapsed() - loaded);
        assert!(!text.trim().is_empty());
    }
}
