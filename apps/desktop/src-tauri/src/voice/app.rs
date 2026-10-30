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
use super::{Events, Transcript, Voice, VoiceError, VoiceEvent, VoiceStatus, UNSUPPORTED};
use crate::computer::SystemClock;
use crate::config::{self, VoiceInput as StoredInput};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// The commands, as registered in `build.rs` and granted to the panel.
pub const COMMANDS: [&str; 10] = [
    "voice_status",
    "voice_start",
    "voice_stop",
    "voice_cancel",
    "voice_input_options",
    "voice_input_set",
    "voice_model_status",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_remove",
];

/// Said when the panel asks to record from a microphone that is not one.
pub const EMPTY_INPUT: &str = "Choose a microphone to record from.";

/// Voice input, when this platform has a backend, and the microphone the user chose (S1-S4).
pub struct VoiceInput {
    voice: Option<Voice>,
    /// `config.json`, where the choice is kept between recordings and launches (S2).
    config: PathBuf,
    /// The stored choice; `None` follows the system default input.
    stored: Mutex<Option<StoredInput>>,
    /// The inputs this platform offers and its default, read when the panel asks.
    devices: Enumerate,
}

/// The platform's input devices (UID and display name) and the UID of its default input. A
/// function rather than a call so the tests answer fixed devices instead of this Mac's.
type Enumerate = fn() -> (Vec<StoredInput>, Option<String>);

/// macOS asks CoreAudio (S1-S4); elsewhere the system default input is all there is, so the
/// panel gets an empty list rather than a device it could never select (S7, Linux).
fn platform_devices() -> (Vec<StoredInput>, Option<String>) {
    #[cfg(target_os = "macos")]
    return (
        super::core_audio::inputs().into_iter().map(|device| StoredInput { uid: device.uid, name: device.name }).collect(),
        super::core_audio::default_input_uid(),
    );
    #[cfg(not(target_os = "macos"))]
    (Vec::new(), None)
}

impl VoiceInput {
    pub fn new(voice: Voice) -> Self {
        let (config, stored) = stored_input();
        VoiceInput { voice: Some(voice), config, stored: Mutex::new(stored), devices: platform_devices }
    }

    pub fn unsupported() -> Self {
        let (config, stored) = stored_input();
        VoiceInput { voice: None, config, stored: Mutex::new(stored), devices: platform_devices }
    }

    fn voice(&self) -> Result<&Voice, VoiceError> {
        self.voice.as_ref().ok_or(VoiceError::Unsupported)
    }

    /// The stored device UID; `None` follows the system default input.
    fn chosen(&self) -> Option<String> {
        self.stored.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|input| input.uid.clone())
    }

    pub fn status(&self) -> VoiceStatus {
        self.voice().map_or_else(|_| VoiceStatus::unavailable(UNSUPPORTED), Voice::status)
    }

    pub fn start(&self, locale: Option<&str>, events: Events) -> Result<(), VoiceError> {
        // The recording reads the choice stored in Rust state, so the panel never passes a device.
        let chosen = self.chosen();
        self.voice()?.start(locale, chosen.as_deref(), events)
    }

    pub fn stop(&self) -> Result<Transcript, VoiceError> {
        self.voice()?.stop()
    }

    pub fn cancel(&self) -> Result<(), VoiceError> {
        self.voice()?.cancel()
    }

    /// The devices the panel may choose from, the stored choice, and the system default.
    pub fn input_options(&self) -> InputOptions {
        let (devices, default) = (self.devices)();
        // The stored choice stays in the answer even when the device is gone, so the panel can
        // warn about it (S3); a recording from it falls back to the default.
        InputOptions { devices, chosen: self.chosen(), default }
    }

    /// Stores the choice (a device UID, or `None` to follow the system default) in `config.json`
    /// and in the state the next recording reads, and answers with what it stored.
    pub fn set_input(&self, uid: Option<&str>) -> Result<InputChoice, VoiceError> {
        let uid = uid.map(str::trim);
        if uid == Some("") {
            return Err(VoiceError::Failed(EMPTY_INPUT.to_string()));
        }
        let mut stored = self.stored.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let input = uid.map(|uid| StoredInput {
            // The name is kept for display only (S4): what the device calls itself now, else the
            // name already stored for it, else the UID, so a device that is gone still reads as
            // something in the panel.
            name: (self.devices)()
                .0
                .into_iter()
                .find(|device| device.uid == uid)
                .map(|device| device.name)
                .or_else(|| stored.as_ref().filter(|input| input.uid == uid).map(|input| input.name.clone()))
                .unwrap_or_else(|| uid.to_string()),
            uid: uid.to_string(),
        });
        config::save_voice_input(&self.config, input.as_ref()).map_err(VoiceError::Failed)?;
        let chosen = input.as_ref().map(|input| input.uid.clone());
        *stored = input;
        Ok(InputChoice { chosen })
    }
}

/// The choice in `config.json`, read once at startup, and the file it is written back to.
fn stored_input() -> (PathBuf, Option<StoredInput>) {
    let config = config::load_config();
    (config.data_dir.join("config.json"), config.voice_input)
}

/// The `voice_input_options` reply: `{devices, chosen, default}`, the two choices as UIDs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InputOptions {
    /// Every input the Mac reports, in its own order (empty off macOS).
    pub devices: Vec<StoredInput>,
    /// The stored UID, or `null` when following the system default.
    pub chosen: Option<String>,
    /// The system default input's UID, or `null` while it is not known.
    pub default: Option<String>,
}

/// The `voice_input_set` reply: `{chosen}`, the UID that is now stored, or `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InputChoice {
    pub chosen: Option<String>,
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
    (platform_input(local.clone()), VoiceModel { manager, local })
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

/// `{devices, chosen, default}`: the microphones the panel may choose from (S1-S4).
#[tauri::command]
pub async fn voice_input_options(app: AppHandle) -> Result<InputOptions, String> {
    blocking(app, |input| Ok(input.input_options())).await
}

/// Stores the chosen microphone (`null` follows the system default) and answers `{chosen}`.
#[tauri::command]
pub async fn voice_input_set(app: AppHandle, uid: Option<String>) -> Result<InputChoice, String> {
    blocking(app, move |input| input.set_input(uid.as_deref())).await
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
    use crate::voice::{VoiceError, VoiceStatus, UNSUPPORTED};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

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
    fn the_command_names_match_the_l88_and_s30_5_contracts() {
        assert_eq!(
            COMMANDS,
            [
                "voice_status",
                "voice_start",
                "voice_stop",
                "voice_cancel",
                "voice_input_options",
                "voice_input_set",
                "voice_model_status",
                "voice_model_download",
                "voice_model_cancel",
                "voice_model_remove",
            ]
        );
    }

    #[test]
    fn models_live_under_the_app_data_dir() {
        assert_eq!(models_dir(Some(PathBuf::from("/data/app"))), PathBuf::from("/data/app/models"));
        assert_eq!(models_dir(None), std::env::temp_dir().join("gentle-dot").join("models"));
    }

    #[test]
    fn the_chosen_microphone_is_stored_in_the_config_and_answered_back() {
        let dir = scratch("input");
        let input = VoiceInput {
            voice: None,
            config: dir.join("config.json"),
            stored: Mutex::new(None),
            devices: fixed_devices,
        };
        // Nothing chosen yet: the system default, and the devices the panel offers (S1).
        assert_eq!(
            input.input_options(),
            InputOptions {
                devices: vec![
                    StoredInput { uid: "BuiltInMic:1".into(), name: "MacBook Pro Microphone".into() },
                    StoredInput { uid: "USB:2".into(), name: "USB Microphone".into() },
                ],
                chosen: None,
                default: Some("BuiltInMic:1".into()),
            }
        );
        assert_eq!(input.set_input(Some(" BuiltInMic:1 ")), Ok(InputChoice { chosen: Some("BuiltInMic:1".into()) }));
        assert_eq!(input.input_options().chosen, Some("BuiltInMic:1".into()));
        // It is in config.json, so the next launch records from it (S2).
        let saved = std::fs::read_to_string(dir.join("config.json")).unwrap();
        let read = config::parse_config(dir.clone(), Some(&saved), |_| None).voice_input.unwrap();
        assert_eq!((read.uid.as_str(), read.name.as_str()), ("BuiltInMic:1", "MacBook Pro Microphone"));
        // Following the system default again is a choice too.
        assert_eq!(input.set_input(None), Ok(InputChoice { chosen: None }));
        assert_eq!(input.input_options().chosen, None);
        // The name stored is the device's own, for display only (S4): the UID is the identity.
        assert_eq!(input.set_input(Some("USB:2")), Ok(InputChoice { chosen: Some("USB:2".into()) }));
        let saved = std::fs::read_to_string(dir.join("config.json")).unwrap();
        let read = config::parse_config(dir.clone(), Some(&saved), |_| None).voice_input.unwrap();
        assert_eq!((read.uid.as_str(), read.name.as_str()), ("USB:2", "USB Microphone"));
        // An empty UID is refused and changes nothing.
        assert_eq!(input.set_input(Some("   ")), Err(VoiceError::Failed(EMPTY_INPUT.into())));
        assert_eq!(input.input_options().chosen, Some("USB:2".into()));
    }

    #[test]
    fn a_chosen_microphone_that_is_gone_keeps_the_name_it_had() {
        let dir = scratch("gone");
        let input = VoiceInput {
            voice: None,
            config: dir.join("config.json"),
            stored: Mutex::new(Some(StoredInput { uid: "USB:2".into(), name: "USB Microphone".into() })),
            devices: fixed_devices,
        };
        // Unplugged: still stored, still shown as chosen, with the name it was known by (S3).
        let gone = VoiceInput { devices: no_devices, ..input };
        let options = gone.input_options();
        assert_eq!((options.devices, options.default), (Vec::new(), None));
        assert_eq!(options.chosen, Some("USB:2".into()));
        assert_eq!(gone.set_input(Some("USB:2")), Ok(InputChoice { chosen: Some("USB:2".into()) }));
        let saved = std::fs::read_to_string(gone.config.clone()).unwrap();
        let read = config::parse_config(dir.clone(), Some(&saved), |_| None).voice_input.unwrap();
        assert_eq!(read.name, "USB Microphone");
        // Never seen before and not connected: the UID is all there is to show.
        assert_eq!(gone.set_input(Some("Ghost:3")), Ok(InputChoice { chosen: Some("Ghost:3".into()) }));
        let saved = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert_eq!(config::parse_config(dir, Some(&saved), |_| None).voice_input.unwrap().name, "Ghost:3");
    }

    /// Two devices, so the tests say nothing about this Mac's hardware.
    fn fixed_devices() -> (Vec<StoredInput>, Option<String>) {        (
            vec![
                StoredInput { uid: "BuiltInMic:1".into(), name: "MacBook Pro Microphone".into() },
                StoredInput { uid: "USB:2".into(), name: "USB Microphone".into() },
            ],
            Some("BuiltInMic:1".into()),
        )
    }

    /// A Mac with no input device at all: the list is empty and the default unknown.
    fn no_devices() -> (Vec<StoredInput>, Option<String>) {
        (Vec::new(), None)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch/voice").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
}
