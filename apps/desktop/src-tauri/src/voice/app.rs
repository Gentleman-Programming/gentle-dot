//! The app side of voice input (S30.1, L88) and of the optional local model (S30.5): the
//! `voice_*` commands and the `voice://*` events. Recording events go only to the webview that
//! started the recording; `voice://model` events go to the panel. On macOS, Apple Speech records
//! until the local model is installed; on Linux, the local model is the only engine; elsewhere
//! `voice_status` answers "unavailable" and the other recording commands fail. Every command
//! runs on a blocking thread: starting may wait on a permission prompt, stopping waits for the
//! final transcript, and removing the model deletes files.

use super::engine::{fallback_engine, Preferred};
use super::model::{HttpFetcher, ModelError, ModelEvent, ModelEvents, ModelManager, ModelSpec, ModelStatus, MODEL_EVENT};
use super::parakeet::{self, Loader, Locate, Parakeet};
use super::wake::{self, Chime, WakeWord};
use super::{ListenEvent, ListenEvents};
use super::{Events, Transcript, Voice, VoiceError, VoiceEvent, VoiceStatus, UNSUPPORTED};
use crate::computer::SystemClock;
use crate::config::DesktopConfig;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// The commands, as registered in `build.rs` and granted to the panel.
pub const COMMANDS: [&str; 10] = [
    "voice_status",
    "voice_start",
    "voice_stop",
    "voice_cancel",
    "voice_model_status",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_remove",
    "wake_word_status",
    "wake_word_set",
];

/// Voice input, when this platform has a backend, and the wake word that listens on the same
/// microphone (S30.7).
pub struct VoiceInput {
    voice: Option<Voice>,
    wake: Option<Wake>,
}

impl VoiceInput {
    pub fn new(voice: Voice) -> Self {
        VoiceInput { voice: Some(voice), wake: None }
    }

    pub fn unsupported() -> Self {
        VoiceInput { voice: None, wake: None }
    }

    fn voice(&self) -> Result<&Voice, VoiceError> {
        self.voice.as_ref().ok_or(VoiceError::Unsupported)
    }

    pub fn status(&self) -> VoiceStatus {
        self.voice().map_or_else(|_| VoiceStatus::unavailable(UNSUPPORTED), Voice::status)
    }

    /// Starting a recording drops the wake word's listener (one capture at a time, S2); once the
    /// recording is over it waits for the phrase again, unless the user turned it off.
    pub fn start(&self, locale: Option<&str>, events: Events) -> Result<(), VoiceError> {
        let started = self.voice()?.start(locale, events);
        self.listen_again();
        started
    }

    pub fn stop(&self) -> Result<Transcript, VoiceError> {
        let stopped = self.voice()?.stop();
        self.listen_again();
        stopped
    }

    pub fn cancel(&self) -> Result<(), VoiceError> {
        let cancelled = self.voice()?.cancel();
        self.listen_again();
        cancelled
    }

    fn listen_again(&self) {
        if let Some(wake) = &self.wake {
            wake.resume();
        }
    }

    /// `{enabled, available, reason?}`.
    pub fn wake_status(&self) -> WakeStatus {
        self.wake.as_ref().map_or_else(|| WakeStatus::unavailable(UNSUPPORTED), Wake::status)
    }

    /// Turns the detector on or off now and saves the flag (S1). On without a reference is
    /// refused with the reason: never silently. Off with no backend at all is still saved, so
    /// the panel's switch keeps its position here.
    pub fn wake_set(&self, enabled: bool) -> Result<WakeStatus, String> {
        self.wake.as_ref().ok_or_else(|| UNSUPPORTED.to_string())?.set(enabled)
    }
}

/// The `wake_word_status` reply: `{enabled, available, reason?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WakeStatus {
    pub enabled: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WakeStatus {
    fn unavailable(reason: impl Into<String>) -> Self {
        WakeStatus { enabled: false, available: false, reason: Some(reason.into()) }
    }
}

/// How the reference file becomes a detector; a test swaps in a scripted one.
type Load = Arc<dyn Fn(&Path) -> Result<Arc<dyn WakeWord>, String> + Send + Sync>;

/// The wake word (S30.7, S1-S7): the saved flag, the reference it needs, and the log every match
/// and every failure is appended to (S5).
///
/// A detection is handled off the audio thread (the machine spawns one), starts the recording the
/// panel's button starts (S3) and ends it by energy (S6); every transcript and event reaches the
/// panel window, which sends it the way it sends one it stopped itself.
#[derive(Clone)]
pub struct Wake {
    inner: Arc<WakeInner>,
    /// Whether this build has a detector at all, and how its reference becomes one.
    detector: Option<Load>,
    /// The pip that tells the speaker the note started (S30.7).
    chime: Arc<dyn Chime>,
}

struct WakeInner {
    voice: Option<Voice>,
    /// `<data dir>/config.json`, where the flag lives (S1).
    config_file: PathBuf,
    /// `<data dir>/wake-word/hey-dot.rpw` (S4).
    model: PathBuf,
    /// `<data dir>/wake-word.log` (S5).
    log: PathBuf,
    events: Events,
    enabled: Mutex<bool>,
}

impl Wake {
    pub fn new(voice: Option<Voice>, config: &DesktopConfig, events: Events) -> Self {
        let wake = Wake {
            inner: Arc::new(WakeInner {
                voice,
                config_file: config.data_dir.join("config.json"),
                model: wake::model_path(&config.data_dir),
                log: config.data_dir.join("wake-word.log"),
                events,
                enabled: Mutex::new(false),
            }),
            detector: cfg!(target_os = "macos").then(|| Arc::new(open_model) as Load),
            chime: wake::platform_chime(),
        };
        // The phrase was "oye dot" before this build: an installation that already has its
        // reference keeps working instead of being asked for the file again (S4).
        if wake::adopt_legacy(&config.data_dir).is_some() {
            wake.log("adopted", serde_json::json!({ "from": wake::LEGACY_MODEL_FILE, "to": wake::MODEL_FILE }));
        }
        wake
    }

    /// A scripted pip, so the rule that it fires once per note is tested on every platform.
    #[cfg(test)]
    fn with_chime(mut self, chime: Arc<dyn Chime>) -> Self {
        self.chime = chime;
        self
    }

    /// A scripted detector, so the rules around it are tested on every platform.
    #[cfg(test)]
    fn with_detector(mut self, load: Load) -> Self {
        self.detector = Some(load);
        self
    }

    /// `{enabled, available, reason?}`: `reason` is what stops it listening here, which is the
    /// panel's tooltip when the switch cannot be used (S1).
    pub fn status(&self) -> WakeStatus {
        let enabled = self.enabled();
        match self.reason() {
            None => WakeStatus { enabled, available: true, reason: None },
            Some(reason) => WakeStatus { enabled, available: false, reason: Some(reason) },
        }
    }

    fn enabled(&self) -> bool {
        *self.inner.enabled.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_enabled(&self, enabled: bool) {
        *self.inner.enabled.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = enabled;
    }

    /// Why nothing can listen here: no detector on this platform, or no reference file (S4).
    fn reason(&self) -> Option<String> {
        if self.inner.voice.is_none() || self.detector.is_none() {
            return Some(UNSUPPORTED.to_string());
        }
        if !self.inner.model.is_file() {
            return Some(wake::missing(&self.inner.model));
        }
        None
    }

    /// Turns the detector on or off, applying it now and saving the flag in `config.json` (S1).
    /// On without the reference fails with the reason before anything is written.
    pub fn set(&self, enabled: bool) -> Result<WakeStatus, String> {
        if enabled {
            if let Some(reason) = self.reason() {
                return Err(reason);
            }
            let voice = self.inner.voice.clone().ok_or_else(|| UNSUPPORTED.to_string())?;
            self.listen(&voice).map_err(|error| error.to_string())?;
        } else {
            self.disarm();
        }
        crate::config::save_wake_word(&self.inner.config_file, enabled)?;
        self.set_enabled(enabled);
        Ok(self.status())
    }

    /// Applies the flag read at startup (S1), logging why it cannot listen instead of doing
    /// nothing (S5).
    pub fn startup(&self, enabled: bool) {
        if !enabled {
            return;
        }
        match self.reason() {
            Some(reason) => self.log("failed", serde_json::json!({ "reason": reason })),
            None => {
                self.set_enabled(true);
                self.resume();
            }
        }
    }

    /// Waits for the phrase on the microphone the app already has (S2): a fresh detector, so the
    /// audio of the last note cannot match the next one.
    fn listen(&self, voice: &Voice) -> Result<(), VoiceError> {
        let load = self.detector.as_ref().ok_or(VoiceError::Unsupported)?;
        let detector = load(&self.inner.model).map_err(VoiceError::Failed)?;
        voice.arm(detector, self.listen_events())
    }

    fn disarm(&self) {
        if let Some(voice) = &self.inner.voice {
            voice.disarm();
        }
    }

    /// Waits for the phrase again after a recording, which always disarms the listener.
    fn resume(&self) {
        let Some(voice) = self.inner.voice.clone() else { return };
        if !self.enabled() || self.reason().is_some() {
            return;
        }
        match self.listen(&voice) {
            // A note still running keeps the microphone; its own end resumes the detector.
            Ok(()) | Err(VoiceError::Busy) | Err(VoiceError::Cancelled) => {}
            Err(error) => self.log("failed", serde_json::json!({ "reason": error.to_string() })),
        }
    }

    /// The machine fires these off the audio thread; nothing here may run on it either, because
    /// starting a recording can prompt for a permission and stopping waits for the transcript.
    fn handle(&self, event: ListenEvent) {
        match event {
            ListenEvent::Detected(detection) => {
                self.log("detected", serde_json::json!({ "score": detection.score, "model": detection.name }));
                if let Err(error) = self.record() {
                    self.log("failed", serde_json::json!({ "reason": error }));
                }
            }
            ListenEvent::Silent => self.stop(),
        }
    }

    /// Starts the note through the path the panel's button uses (S3): the same `Voice::start`,
    /// the same `voice://*` events, plus the automatic stop (S6).
    fn record(&self) -> Result<(), String> {
        let voice = self.inner.voice.clone().ok_or_else(|| UNSUPPORTED.to_string())?;
        voice
            .start_woken(None, self.panel_events(), self.listen_events())
            .map_err(|error| error.to_string())?;
        // The panel did not press anything, so a short system pip says the note is running (S3),
        // and it is the only sound: the automatic stop is silent.
        self.chime.note_started();
        // The panel did not press anything, so it needs to know a note is running (S3).
        (self.inner.events)(VoiceEvent::Started);
        Ok(())
    }

    /// Ends a note the detector started: the transcript reaches the panel in the same shape as
    /// the `voice_stop` reply, so the panel sends it the way it sends one it stopped (S3).
    fn stop(&self) {
        if let Some(voice) = &self.inner.voice {
            match voice.stop() {
                Ok(transcript) if !transcript.text.is_empty() => {
                    (self.inner.events)(VoiceEvent::Transcript(transcript.text))
                }
                Ok(_) => {}
                Err(error) => self.log("failed", serde_json::json!({ "reason": error.to_string() })),
            }
        }
        self.resume();
    }

    fn listen_events(&self) -> ListenEvents {
        let wake = self.clone();
        Arc::new(move |event| wake.handle(event))
    }

    fn panel_events(&self) -> Events {
        let events = self.inner.events.clone();
        Arc::new(move |event| events(event))
    }

    /// One JSON line per detection (with its score) and per failure (S5), so real use collects the
    /// data the operating point still lacks. Opened, appended and flushed per line: no dependency,
    /// and a log that cannot be written never breaks listening.
    fn log(&self, event: &str, details: serde_json::Value) {
        let mut entry = serde_json::json!({ "at": now_ms(), "event": event });
        if let (Some(fields), serde_json::Value::Object(more)) = (entry.as_object_mut(), details) {
            fields.extend(more);
        }
        let mut line = entry.to_string();
        line.push('\n');
        let written = std::fs::OpenOptions::new().create(true).append(true).open(&self.inner.log).and_then(|mut file| {
            use std::io::Write;
            file.write_all(line.as_bytes())?;
            file.flush()
        });
        if let Err(error) = written {
            eprintln!("gentle-dot: cannot write {}: {error}", self.inner.log.display());
        }
    }
}

/// Milliseconds since the epoch, for the log's timestamp.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The detector for this platform, loaded from the reference at `path` (S4). macOS only: it is
/// the platform whose microphone this app has the tap for (S2).
fn open_model(path: &Path) -> Result<Arc<dyn WakeWord>, String> {
    #[cfg(target_os = "macos")]
    return wake::RustpotterWake::load(path).map(|detector| Arc::new(detector) as Arc<dyn WakeWord>);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(UNSUPPORTED.to_string())
    }
}

/// The local model's files and the recognizer that keeps it loaded.
pub struct VoiceModel {
    manager: Arc<ModelManager>,
    local: Arc<Parakeet>,
}

impl VoiceModel {
    pub fn status(&self) -> ModelStatus {
        self.manager.status()
    }

    pub fn download(&self) -> Result<(), ModelError> {
        self.manager.download()
    }

    pub fn cancel(&self) {
        self.manager.cancel();
    }

    /// Deletes the files and drops the loaded model.
    pub fn remove(&self) -> Result<(), ModelError> {
        self.manager.remove()?;
        self.local.release();
        Ok(())
    }
}

/// Where models are installed: `<app data>/models`.
pub fn models_dir(app_data: Option<PathBuf>) -> PathBuf {
    app_data.unwrap_or_else(|| std::env::temp_dir().join("gentle-dot")).join("models")
}

/// Voice input with the engine this platform prefers, and the local model's manager.
pub fn start(app: &AppHandle) -> (VoiceInput, VoiceModel) {
    let emitter = app.clone();
    let events: ModelEvents = Arc::new(move |event: ModelEvent| {
        if let Err(error) = emitter.emit_to(EventTarget::webview_window(crate::shell::PANEL), MODEL_EVENT, event) {
            eprintln!("gentle-dot: cannot send a voice model event: {error}");
        }
    });
    let manager = Arc::new(ModelManager::new(
        ModelSpec::parakeet(),
        models_dir(app.path().app_data_dir().ok()),
        Arc::new(HttpFetcher),
        Arc::new(SystemClock),
        events,
        fallback_engine(),
    ));
    let installed = manager.clone();
    let locate: Locate = Arc::new(move || installed.installed());
    let loader: Loader = Arc::new(parakeet::load);
    let local = Arc::new(Parakeet::new(locate, loader));
    let mut input = platform_input(local.clone());
    let config = crate::config::load_config();
    let panel = app.clone();
    let target = EventTarget::webview_window(crate::shell::PANEL);
    let panel_events: Events = Arc::new(move |event: VoiceEvent| {
        if let Err(error) = panel.emit_to(target.clone(), event.name(), event.payload()) {
            eprintln!("gentle-dot: cannot send a voice event: {error}");
        }
    });
    let wake = Wake::new(input.voice.clone(), &config, panel_events);
    // S1: the flag is read here and applied now; a failure is logged with its reason.
    wake.startup(config.wake_word);
    input.wake = Some(wake);
    (input, VoiceModel { manager, local })
}

/// macOS: the native microphone, Parakeet when installed, else Apple Speech. Linux: a
/// command-line recorder and Parakeet. Elsewhere: nothing.
fn platform_input(local: Arc<Parakeet>) -> VoiceInput {
    #[cfg(target_os = "macos")]
    return VoiceInput::new(Voice::new(
        Arc::new(super::MacMicrophone),
        Arc::new(Preferred::new(local, Some(Arc::new(super::AppleSpeech)))),
        Arc::new(SystemClock),
    ));
    #[cfg(target_os = "linux")]
    return VoiceInput::new(Voice::new(
        Arc::new(super::pipe::PipeMicrophone::system()),
        Arc::new(Preferred::new(local, None)),
        Arc::new(SystemClock),
    ));
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = local;
        VoiceInput::unsupported()
    }
}

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&VoiceInput) -> Result<T, VoiceError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(&app.state::<VoiceInput>()))
        .await
        .map_err(|error| error.to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> Result<VoiceStatus, String> {
    blocking(app, |input| Ok(input.status())).await
}

#[tauri::command]
pub async fn voice_start(app: AppHandle, webview: tauri::WebviewWindow, locale: Option<String>) -> Result<(), String> {
    let target = EventTarget::webview_window(webview.label());
    let emitter = app.clone();
    let events: Events = Arc::new(move |event: VoiceEvent| {
        if let Err(error) = emitter.emit_to(target.clone(), event.name(), event.payload()) {
            eprintln!("gentle-dot: cannot send a voice event: {error}");
        }
    });
    blocking(app, move |input| input.start(locale.as_deref(), events)).await
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle) -> Result<Transcript, String> {
    blocking(app, VoiceInput::stop).await
}

#[tauri::command]
pub async fn voice_cancel(app: AppHandle) -> Result<(), String> {
    blocking(app, VoiceInput::cancel).await
}

/// `{enabled, available, reason?}` (S1): whether it is on, and if not, why it cannot be.
#[tauri::command]
pub async fn wake_word_status(app: AppHandle) -> Result<WakeStatus, String> {
    blocking(app, |input| Ok(input.wake_status())).await
}

/// Turns the wake word on or off (S1). On without the reference fails with the reason.
#[tauri::command]
pub async fn wake_word_set(app: AppHandle, enabled: bool) -> Result<WakeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<VoiceInput>().wake_set(enabled))
        .await
        .map_err(|error| error.to_string())?
}

async fn model<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&VoiceModel) -> Result<T, ModelError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(&app.state::<VoiceModel>()))
        .await
        .map_err(|error| error.to_string())?
        .map_err(String::from)
}

/// `{installed, bytes?, downloading, received?, total?, engine}`.
#[tauri::command]
pub async fn voice_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    model(app, |model| Ok(model.status())).await
}

/// Starts the download; `voice://model` events report progress and the outcome.
#[tauri::command]
pub async fn voice_model_download(app: AppHandle) -> Result<(), String> {
    model(app, VoiceModel::download).await
}

/// Stops a download in flight (harmless otherwise); a `failed` event follows.
#[tauri::command]
pub async fn voice_model_cancel(app: AppHandle) -> Result<(), String> {
    model(app, |model| {
        model.cancel();
        Ok(())
    })
    .await
}

/// Deletes the model; a `removed` event follows when there was one.
#[tauri::command]
pub async fn voice_model_remove(app: AppHandle) -> Result<(), String> {
    model(app, VoiceModel::remove).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeMicrophone, FakeRecognizer, Recorder};
    use crate::voice::wake::FakeWake;
    use crate::voice::{VoiceError, VoiceEvent, VoiceStatus, UNSUPPORTED};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;

    #[test]
    fn without_a_backend_voice_is_unavailable_and_every_action_errors() {
        let input = VoiceInput::unsupported();
        assert_eq!(input.status(), VoiceStatus::unavailable(UNSUPPORTED));
        assert_eq!(input.start(None, Arc::new(|_| {})), Err(VoiceError::Unsupported));
        assert_eq!(input.stop(), Err(VoiceError::Unsupported));
        assert_eq!(input.cancel(), Err(VoiceError::Unsupported));
        assert_eq!(String::from(VoiceError::Unsupported), "Voice input is available on macOS and Linux.");
    }

    #[test]
    fn without_a_backend_the_wake_word_is_unavailable_and_cannot_be_turned_on() {
        let input = VoiceInput::unsupported();
        assert_eq!(
            input.wake_status(),
            WakeStatus { enabled: false, available: false, reason: Some(UNSUPPORTED.into()) }
        );
        assert_eq!(input.wake_set(true), Err(UNSUPPORTED.to_string()));
    }

    #[test]
    fn the_command_names_match_the_l88_and_s30_5_contracts() {
        assert_eq!(
            COMMANDS,
            [
                "voice_status",
                "voice_start",
                "voice_stop",
                "voice_cancel",
                "voice_model_status",
                "voice_model_download",
                "voice_model_cancel",
                "voice_model_remove",
                "wake_word_status",
                "wake_word_set",
            ]
        );
    }

    #[test]
    fn models_live_under_the_app_data_dir() {
        assert_eq!(models_dir(Some(PathBuf::from("/data/app"))), PathBuf::from("/data/app/models"));
        assert_eq!(models_dir(None), std::env::temp_dir().join("gentle-dot").join("models"));
    }

    #[test]
    fn the_commands_are_registered_and_granted_to_the_panel_only() {
        let build = include_str!("../../build.rs");
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let granted_to = |permission: &str| -> Vec<&str> {
            let all = capabilities["capabilities"].as_array().unwrap();
            let mut windows: Vec<&str> = all
                .iter()
                .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == permission))
                .flat_map(|c| c["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()))
                .collect();
            windows.sort();
            windows
        };
        for command in COMMANDS {
            assert!(build.contains(&format!("\"{command}\",")), "{command} is missing from build.rs");
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(granted_to(&permission), vec!["panel"], "{permission}");
        }
    }

    fn config(dir: PathBuf) -> DesktopConfig {
        DesktopConfig { data_dir: dir, port: 0, shortcut: String::new(), wake_word: false }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch/wake").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("wake-word")).unwrap();
        dir
    }

    /// Counts the pips, so the "once per note, never on the stop" rule is testable.
    #[derive(Default)]
    struct CountingChime(std::sync::atomic::AtomicUsize);

    impl Chime for CountingChime {
        fn note_started(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl CountingChime {
        fn count(&self) -> usize {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    struct WakeRig {
        wake: Wake,
        mic: Arc<FakeMicrophone>,
        recognizer: Arc<FakeRecognizer>,
        detector: Arc<FakeWake>,
        recorder: Recorder,
        chime: Arc<CountingChime>,
        dir: PathBuf,
    }

    /// The wake word with a scripted detector and a fake microphone: the whole path, with no
    /// reference file and no audio device.
    fn wake_rig(name: &str, with_reference: bool) -> WakeRig {
        let dir = scratch(name);
        if with_reference {
            std::fs::write(dir.join("wake-word").join(wake::MODEL_FILE), b"reference").unwrap();
        }
        let mic = Arc::new(FakeMicrophone::granted());
        let recognizer = Arc::new(FakeRecognizer::granted());
        let voice = Voice::new(mic.clone(), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0))));
        let detector = Arc::new(FakeWake::default());
        let recorder = Recorder::default();
        let load: Load = {
            let detector = detector.clone();
            Arc::new(move |_| Ok(detector.clone() as Arc<dyn WakeWord>))
        };
        let chime = Arc::new(CountingChime::default());
        let wake = Wake::new(Some(voice), &config(dir.clone()), recorder.events())
            .with_detector(load)
            .with_chime(chime.clone());
        WakeRig { wake, mic, recognizer, detector, recorder, chime, dir }
    }

    /// Waits for a background reaction (they all run on spawned threads) before checking it.
    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !done() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(done(), "{what}");
    }

    #[test]
    fn the_wake_word_is_off_until_it_is_turned_on_and_the_flag_is_saved() {
        let rig = wake_rig("on", true);
        assert_eq!(rig.wake.status(), WakeStatus { enabled: false, available: true, reason: None });
        assert_eq!(rig.wake.set(true), Ok(WakeStatus { enabled: true, available: true, reason: None }));
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1, "listening is the only capture");
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(rig.dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["wake_word"], serde_json::json!(true));
        assert_eq!(rig.wake.set(false), Ok(WakeStatus { enabled: false, available: true, reason: None }));
        assert_eq!(rig.mic.log.lock().unwrap().closed, 1);
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(rig.dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["wake_word"], serde_json::json!(false));
    }

    #[test]
    fn turning_it_on_without_the_reference_fails_with_the_reason_and_saves_nothing() {
        let rig = wake_rig("missing", false);
        let error = rig.wake.set(true).unwrap_err();
        assert!(error.contains("wake-word/hey-dot.rpw"), "{error}");
        assert!(!rig.wake.status().enabled);
        assert!(!rig.wake.status().available);
        assert!(!rig.dir.join("config.json").exists(), "a flag that cannot work is not saved");
        assert_eq!(rig.mic.log.lock().unwrap().opened, 0);
    }

    #[test]
    fn a_saved_flag_is_applied_at_startup() {
        let rig = wake_rig("startup", true);
        rig.wake.startup(true);
        assert!(rig.wake.status().enabled);
        assert_eq!(rig.mic.log.lock().unwrap().opened, 1);
        let quiet = wake_rig("startup-off", true);
        quiet.wake.startup(false);
        assert_eq!(quiet.mic.log.lock().unwrap().opened, 0);
    }

    #[test]
    fn a_detection_is_logged_and_starts_the_note_the_button_starts() {
        let rig = wake_rig("detected", true);
        rig.wake.set(true).unwrap();
        rig.detector.detect(0.51);
        rig.mic.sink().audio(&[0.2; 480]);
        wait_until("the note starts", || rig.mic.log.lock().unwrap().opened == 2);
        let log = std::fs::read_to_string(rig.dir.join("wake-word.log")).unwrap();
        let line: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!(line["event"], serde_json::json!("detected"));
        assert!((line["score"].as_f64().unwrap() - 0.51).abs() < 1e-5, "{line}");
        assert_eq!(line["model"], serde_json::json!(wake::WAKE_WORD));
        assert!(line["at"].as_u64().is_some(), "the line is timestamped: {line}");
    }

    #[test]
    fn a_note_started_by_the_wake_word_pips_once_and_the_stop_is_silent() {
        let rig = wake_rig("chime", true);
        *rig.recognizer.final_text.lock().unwrap() = Some("hola".into());
        rig.wake.set(true).unwrap();
        assert_eq!(rig.chime.count(), 0, "arming the detector is not a note");

        rig.detector.detect(0.51);
        rig.mic.sink().audio(&[0.2; 480]);
        wait_until("the note starts", || rig.mic.log.lock().unwrap().opened == 2);
        wait_until("the pip plays", || rig.chime.count() == 1);

        let sink = rig.mic.sink();
        for _ in 0..20 {
            sink.audio(&[0.05; 1_600]);
        }
        for _ in 0..16 {
            sink.audio(&[0.0; 1_600]);
        }
        wait_until("the transcript arrives", || {
            rig.recorder.seen().iter().any(|event| matches!(event, VoiceEvent::Transcript(_)))
        });
        assert_eq!(rig.chime.count(), 1, "the end of the note is silent");
    }

    #[test]
    fn the_note_ends_itself_and_the_transcript_reaches_the_panel() {
        let rig = wake_rig("transcript", true);
        *rig.recognizer.final_text.lock().unwrap() = Some(" hola ".into());
        rig.wake.set(true).unwrap();
        rig.detector.detect(0.51);
        rig.mic.sink().audio(&[0.2; 480]);
        wait_until("the note starts", || rig.mic.log.lock().unwrap().opened == 2);
        let sink = rig.mic.sink();
        for _ in 0..20 {
            sink.audio(&[0.05; 1_600]);
        }
        for _ in 0..16 {
            sink.audio(&[0.0; 1_600]);
        }
        wait_until("the transcript arrives", || {
            rig.recorder.seen().iter().any(|event| matches!(event, VoiceEvent::Transcript(_)))
        });
        let transcript = rig.recorder.seen().into_iter().find(|event| matches!(event, VoiceEvent::Transcript(_)));
        assert_eq!(transcript, Some(VoiceEvent::Transcript("hola".into())));
        // And the phrase is waited for again, on a capture of its own.
        wait_until("the detector listens again", || rig.mic.log.lock().unwrap().opened == 3);
    }

    #[test]
    fn a_failed_detector_is_logged_too() {
        let rig = wake_rig("failed", true);
        *rig.mic.open_error.lock().unwrap() = Some(VoiceError::NoMicrophone);
        rig.wake.startup(true);
        let log = std::fs::read_to_string(rig.dir.join("wake-word.log")).unwrap();
        let line: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!(line["event"], serde_json::json!("failed"));
        assert!(line["reason"].as_str().unwrap().contains("No microphone"), "{line}");
    }
}
