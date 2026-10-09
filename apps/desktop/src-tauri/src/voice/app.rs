//! The app side of voice input (S30.1, L88): the `voice_*` commands and the `voice://*` events,
//! sent only to the webview that started the recording. Off macOS `voice_status` answers
//! "unavailable" and the other commands fail. Every command runs on a blocking thread: starting
//! may wait on a permission prompt and stopping waits for the final transcript.

use super::{Events, Transcript, Voice, VoiceError, VoiceEvent, VoiceStatus, UNSUPPORTED};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// The commands, as registered in `build.rs` and granted to the panel.
pub const COMMANDS: [&str; 4] = ["voice_status", "voice_start", "voice_stop", "voice_cancel"];

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

/// Apple's Speech framework over the native microphone on macOS; nothing elsewhere.
pub fn start() -> VoiceInput {
    #[cfg(target_os = "macos")]
    return VoiceInput::new(Voice::new(
        Arc::new(super::MacMicrophone),
        Arc::new(super::AppleSpeech),
        Arc::new(crate::computer::SystemClock),
    ));
    #[cfg(not(target_os = "macos"))]
    VoiceInput::unsupported()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::{VoiceError, VoiceStatus, UNSUPPORTED};
    use std::sync::Arc;

    #[test]
    fn without_a_backend_voice_is_unavailable_and_every_action_errors() {
        let input = VoiceInput::unsupported();
        assert_eq!(input.status(), VoiceStatus::unavailable(UNSUPPORTED));
        assert_eq!(input.start(None, Arc::new(|_| {})), Err(VoiceError::Unsupported));
        assert_eq!(input.stop(), Err(VoiceError::Unsupported));
        assert_eq!(input.cancel(), Err(VoiceError::Unsupported));
        assert_eq!(String::from(VoiceError::Unsupported), "Voice input is available on macOS.");
    }

    #[test]
    fn the_command_names_match_the_l88_contract() {
        assert_eq!(COMMANDS, ["voice_status", "voice_start", "voice_stop", "voice_cancel"]);
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
