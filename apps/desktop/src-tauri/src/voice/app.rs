//! The app side of voice input (S30.1, L88) and of the optional local model (S30.5): the
//! `voice_*` commands and the `voice://*` events. Recording events go only to the webview that
//! started the recording; `voice://model` events go to the panel. On macOS, Apple Speech records
//! until the local model is installed; on Linux and Windows, the local model is the only engine; elsewhere
//! `voice_status` answers "unavailable" and the other recording commands fail. Every command
//! runs on a blocking thread: starting may wait on a permission prompt, stopping waits for the
//! final transcript, and removing the model deletes files.

use super::engine::{fallback_engine, Preferred};
use super::model::{HttpFetcher, ModelError, ModelEvent, ModelEvents, ModelManager, ModelSpec, ModelStatus, MODEL_EVENT};
use super::parakeet::{self, Loader, Locate, Parakeet};
use super::{Events, Transcript, Voice, VoiceError, VoiceEvent, VoiceStatus, UNSUPPORTED};
use crate::computer::SystemClock;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// The commands, as registered in `build.rs` and granted to the panel.
pub const COMMANDS: [&str; 11] = [
    "voice_status",
    "voice_start",
    "voice_stop",
    "voice_cancel",
    "voice_model_status",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_remove",
    "voice_synthesis_status",
    "voice_synthesize",
    "voice_synthesize_cancel",
];

/// Voice input, when this platform has a backend.
pub struct VoiceInput {
    voice: Option<Voice>,
}

impl VoiceInput {
    pub fn new(voice: Voice) -> Self {
        VoiceInput { voice: Some(voice) }
    }

    pub fn unsupported() -> Self {
        VoiceInput { voice: None }
    }

    fn voice(&self) -> Result<&Voice, VoiceError> {
        self.voice.as_ref().ok_or(VoiceError::Unsupported)
    }

    pub fn status(&self) -> VoiceStatus {
        self.voice().map_or_else(|_| VoiceStatus::unavailable(UNSUPPORTED), Voice::status)
    }

    pub fn start(&self, locale: Option<&str>, events: Events) -> Result<(), VoiceError> {
        self.voice()?.start(locale, events)
    }

    pub fn stop(&self) -> Result<Transcript, VoiceError> {
        self.voice()?.stop()
    }

    pub fn cancel(&self) -> Result<(), VoiceError> {
        self.voice()?.cancel()
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
    (platform_input(local.clone()), VoiceModel { manager, local })
}

/// macOS: the native microphone, Parakeet when installed, else Apple Speech. Linux: a
/// command-line recorder and Parakeet. Windows: WASAPI and Parakeet. Elsewhere: nothing.
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
    #[cfg(windows)]
    return VoiceInput::new(Voice::new(
        Arc::new(super::wasapi::WindowsMicrophone),
        Arc::new(Preferred::new(local, None)),
        Arc::new(SystemClock),
    ));
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
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
    use std::sync::Arc;

    #[test]
    fn without_a_backend_voice_is_unavailable_and_every_action_errors() {
        let input = VoiceInput::unsupported();
        assert_eq!(input.status(), VoiceStatus::unavailable(UNSUPPORTED));
        assert_eq!(input.start(None, Arc::new(|_| {})), Err(VoiceError::Unsupported));
        assert_eq!(input.stop(), Err(VoiceError::Unsupported));
        assert_eq!(input.cancel(), Err(VoiceError::Unsupported));
        assert_eq!(String::from(VoiceError::Unsupported), "Voice input is available on macOS, Linux, and Windows.");
    }

    #[cfg(windows)]
    #[test]
    fn windows_records_with_the_local_model_and_asks_for_it_first() {
        let local = Arc::new(Parakeet::new(Arc::new(|| None), Arc::new(parakeet::load)));
        assert_eq!(platform_input(local).status(), VoiceStatus::unavailable(VoiceError::NoModel.to_string()));
    }

    #[test]
    fn the_command_names_preserve_input_and_add_spoken_output() {
        assert_eq!(
            COMMANDS.as_slice(),
            &[
                "voice_status",
                "voice_start",
                "voice_stop",
                "voice_cancel",
                "voice_model_status",
                "voice_model_download",
                "voice_model_cancel",
                "voice_model_remove",
                "voice_synthesis_status",
                "voice_synthesize",
                "voice_synthesize_cancel",
            ]
        );
    }

    const SYNTHESIS_COMMANDS: [&str; 3] = ["voice_synthesis_status", "voice_synthesize", "voice_synthesize_cancel"];

    #[test]
    fn synthesis_commands_are_in_the_build_inventory() {
        let build = include_str!("../../build.rs");
        for command in SYNTHESIS_COMMANDS {
            assert!(build.contains(&format!("\"{command}\",")), "missing build command: {command}");
        }
    }

    #[test]
    fn synthesis_handlers_are_registered_in_the_shell() {
        let shell = include_str!("../shell.rs");
        let handlers = shell.split("tauri::generate_handler![").nth(1).expect("handler inventory")
            .split(']').next().unwrap();
        for command in SYNTHESIS_COMMANDS {
            assert!(handlers.lines().any(|line| line.trim().trim_end_matches(',').rsplit("::").next() == Some(command)),
                "missing shell handler: {command}");
        }
    }

    #[test]
    fn synthesis_permissions_belong_only_to_the_local_panel_voice_capability() {
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        for command in SYNTHESIS_COMMANDS {
            let permission = format!("allow-{}", command.replace('_', "-"));
            let grants: Vec<_> = capabilities["capabilities"].as_array().unwrap().iter()
                .filter(|capability| capability["permissions"].as_array().unwrap().iter().any(|p| p == &permission))
                .collect();
            assert_eq!(grants.len(), 1, "one voice grant required: {permission}");
            assert_eq!(grants[0]["identifier"], "voice");
            assert_eq!(grants[0]["windows"], serde_json::json!(["panel"]));
            assert!(grants[0].get("remote").is_none(), "no remote webview grant");
            assert_ne!(grants[0].get("local"), Some(&serde_json::json!(false)));
        }
    }

    #[test]
    fn synthesis_generated_permissions_allow_the_exact_command() {
        for command in SYNTHESIS_COMMANDS {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("permissions/autogenerated/{command}.toml"));
            // Missing generated files fail an assertion, never include_str compilation.
            let source = std::fs::read_to_string(&path);
            assert!(source.is_ok(), "missing generated permission: {}", path.display());
            let source = source.unwrap();
            assert!(source.contains(&format!("identifier = \"allow-{}\"", command.replace('_', "-"))));
            assert!(source.contains(&format!("commands.allow = [\"{command}\"]")));
        }
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
}
