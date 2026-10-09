//! Voice input (S30.1): the panel's mic button records natively and the text comes back as the
//! user's message. Two seams keep the backends swappable:
//!
//! - `Microphone` captures audio and delivers 16 kHz mono f32 PCM (`audio::SAMPLE_RATE`), the
//!   format offline models such as sherpa-onnx expect, so any recognizer can consume it.
//! - `Recognizer` turns that PCM into partial and final text. Apple's Speech framework
//!   (`macos::AppleSpeech`) is the default on macOS; the optional local model (S30.5,
//!   `parakeet::Parakeet`, NVIDIA Parakeet through sherpa-onnx) is preferred once the user has
//!   downloaded it (`model`), and it is the only engine on Linux (`engine::Preferred`).
//!
//! `Voice` is the pure state machine between them (idle → starting → recording → stopping,
//! single flight, cancel, error mapping, level throttling, locale fallback), tested on every OS
//! with fakes. The objc2 bindings live in `macos`; Linux records through a command-line recorder
//! (`pipe`); elsewhere the commands answer "unavailable".
//!
//! SpeechAnalyzer/SpeechTranscriber (macOS 26) are Swift-only, with no Objective-C interface to
//! bind from Rust, and the app supports macOS 12.3, so `SFSpeechRecognizer` is the recognizer.

pub mod app;
pub mod audio;
pub mod engine;
#[cfg(test)]
mod fake;
pub mod locale;
mod machine;
#[cfg(target_os = "macos")]
mod macos;
pub mod model;
pub mod parakeet;
#[cfg(unix)]
pub mod pipe;

pub use machine::{Sink, Voice};
#[cfg(target_os = "macos")]
pub use macos::{AppleSpeech, MacMicrophone};

use serde::Serialize;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// Live text while the user speaks: `{text}`.
pub const PARTIAL_EVENT: &str = "voice://partial";
/// The input level, `{level}` in 0..1, about 15 times a second.
pub const LEVEL_EVENT: &str = "voice://level";
/// A failure while recording (permission, recognizer, interruption): `{message}`.
pub const ERROR_EVENT: &str = "voice://error";
pub const UNSUPPORTED: &str = "Voice input is available on macOS and Linux.";

/// The `voice_status` reply: `{available, reason?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl VoiceStatus {
    pub fn available() -> Self {
        VoiceStatus { available: true, reason: None }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        VoiceStatus { available: false, reason: Some(reason.into()) }
    }
}

/// The `voice_stop` reply: `{text}`, the final transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transcript {
    pub text: String,
}

/// What the webview that started the recording hears.
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    Partial(String),
    Level(f32),
    Error(String),
}

impl VoiceEvent {
    pub fn name(&self) -> &'static str {
        match self {
            VoiceEvent::Partial(_) => PARTIAL_EVENT,
            VoiceEvent::Level(_) => LEVEL_EVENT,
            VoiceEvent::Error(_) => ERROR_EVENT,
        }
    }

    pub fn payload(&self) -> serde_json::Value {
        match self {
            VoiceEvent::Partial(text) => serde_json::json!({ "text": text }),
            VoiceEvent::Level(level) => serde_json::json!({ "level": level }),
            VoiceEvent::Error(message) => serde_json::json!({ "message": message }),
        }
    }
}

/// Delivers events to the webview that started the recording; called from any thread.
pub type Events = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

/// A macOS privacy permission, as the system reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorization {
    NotDetermined,
    Denied,
    Restricted,
    Authorized,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    Unsupported,
    Busy,
    Stopping,
    NotRecording,
    Cancelled,
    SpeechDenied,
    SpeechRestricted,
    MicrophoneDenied,
    MicrophoneRestricted,
    NoRecognizer(String),
    /// The local model is the only engine here (Linux) and it is not downloaded.
    NoModel,
    NoMicrophone,
    /// Linux: neither `parec` nor `arecord` is installed.
    NoRecorder,
    Interrupted,
    Failed(String),
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VoiceError::Unsupported => f.write_str(UNSUPPORTED),
            VoiceError::Busy => f.write_str("Voice input is already recording."),
            VoiceError::Stopping => f.write_str("Voice input is already stopping."),
            VoiceError::NotRecording => f.write_str("Voice input is not recording."),
            VoiceError::Cancelled => f.write_str("Voice input was cancelled."),
            VoiceError::SpeechDenied => f.write_str(
                "Speech Recognition is off for Gentle Dot. Turn it on in System Settings → Privacy & Security → Speech Recognition.",
            ),
            VoiceError::SpeechRestricted => f.write_str("Speech Recognition is restricted on this Mac."),
            VoiceError::MicrophoneDenied => f.write_str(
                "Microphone access is off for Gentle Dot. Turn it on in System Settings → Privacy & Security → Microphone.",
            ),
            VoiceError::MicrophoneRestricted => f.write_str("Microphone access is restricted on this Mac."),
            VoiceError::NoRecognizer(locale) => write!(f, "Speech recognition is not available for {locale}."),
            VoiceError::NoModel => f.write_str("Download the local voice model to use voice input."),
            VoiceError::NoMicrophone => f.write_str("No microphone is available."),
            VoiceError::NoRecorder => f.write_str(
                "No audio recorder was found. Install pulseaudio-utils (parec) or alsa-utils (arecord).",
            ),
            VoiceError::Interrupted => f.write_str("The microphone was interrupted."),
            VoiceError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<VoiceError> for String {
    fn from(error: VoiceError) -> String {
        error.to_string()
    }
}

/// Native audio capture. Delivers `audio::SAMPLE_RATE` mono f32 chunks to `Sink::audio` (on
/// the audio thread) and reports interruptions with `Sink::failed`.
pub trait Microphone: Send + Sync {
    /// The current permission, without prompting.
    fn authorization(&self) -> Authorization;
    /// Prompts when not yet determined. Blocks until the user answers: never on the main thread.
    fn request_authorization(&self) -> Authorization;
    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError>;
}

/// An open capture.
pub trait Stream: Send {
    fn close(&mut self);
}

/// Speech to text over the microphone's PCM. Results arrive through `Sink::partial`,
/// `Sink::finished`, and `Sink::failed`, from any thread, but never from inside `feed`,
/// `finish`, or `cancel` while reporting a failure.
pub trait Recognizer: Send + Sync {
    /// Whether this recognizer can work at all, apart from permissions (a local model that is
    /// not downloaded cannot).
    fn availability(&self) -> Result<(), VoiceError> {
        Ok(())
    }
    /// The current permission, without prompting (`Authorized` when none is needed).
    fn authorization(&self) -> Authorization;
    /// Prompts when not yet determined. Blocks until the user answers: never on the main thread.
    fn request_authorization(&self) -> Authorization;
    /// The user's locale identifier, as the system reports it.
    fn current_locale(&self) -> String;
    fn supported_locales(&self) -> Vec<String>;
    fn begin(&self, locale: &str, sink: Sink) -> Result<Box<dyn Recognition>, VoiceError>;
}

/// One recognition in progress.
pub trait Recognition: Send {
    /// More audio. Runs on the audio thread, so it must not block (heavy decoders queue it).
    fn feed(&mut self, samples: &[f32]);
    /// No more audio: the final text follows through `Sink::finished`.
    fn finish(&mut self);
    /// Discards the recognition.
    fn cancel(&mut self);
    /// How long `stop` waits for the final text, when this recognition needs longer than the
    /// machine's default (an offline model decodes everything after `finish`).
    fn final_timeout(&self) -> Option<Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_carry_the_contract_names_and_payloads() {
        let partial = VoiceEvent::Partial("hola".into());
        assert_eq!((partial.name(), partial.payload()), ("voice://partial", serde_json::json!({"text": "hola"})));
        let level = VoiceEvent::Level(0.5);
        assert_eq!((level.name(), level.payload()), ("voice://level", serde_json::json!({"level": 0.5})));
        let error = VoiceEvent::Error("no".into());
        assert_eq!((error.name(), error.payload()), ("voice://error", serde_json::json!({"message": "no"})));
    }

    #[test]
    fn status_omits_the_reason_when_available() {
        assert_eq!(serde_json::to_value(VoiceStatus::available()).unwrap(), serde_json::json!({"available": true}));
        assert_eq!(
            serde_json::to_value(VoiceStatus::unavailable(UNSUPPORTED)).unwrap(),
            serde_json::json!({"available": false, "reason": "Voice input is available on macOS and Linux."})
        );
    }

    #[test]
    fn the_stop_reply_is_the_text() {
        let reply = Transcript { text: "hello".into() };
        assert_eq!(serde_json::to_value(reply).unwrap(), serde_json::json!({"text": "hello"}));
    }
}
