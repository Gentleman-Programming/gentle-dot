//! Which speech-to-text engine records (S30.5): the local Parakeet model when it is installed,
//! else the platform's own (Apple Speech on macOS, S30.1). Linux has no platform engine, so
//! there voice input needs the model. The choice is made on every call, so a model installed or
//! removed while the app runs takes effect on the next recording.

use super::model::EngineName;
use super::parakeet::Parakeet;
use super::{Authorization, Recognition, Recognizer, Sink, VoiceError};
use std::sync::Arc;

/// The engine used while the local model is absent, on this platform.
pub fn fallback_engine() -> EngineName {
    if cfg!(target_os = "macos") {
        EngineName::Apple
    } else {
        EngineName::None
    }
}

pub struct Preferred {
    local: Arc<Parakeet>,
    fallback: Option<Arc<dyn Recognizer>>,
}

impl Preferred {
    pub fn new(local: Arc<Parakeet>, fallback: Option<Arc<dyn Recognizer>>) -> Self {
        Preferred { local, fallback }
    }

    fn pick(&self) -> Option<&dyn Recognizer> {
        if self.local.installed() {
            Some(self.local.as_ref())
        } else {
            self.fallback.as_deref()
        }
    }

    pub fn engine(&self) -> EngineName {
        if self.local.installed() {
            EngineName::Parakeet
        } else if self.fallback.is_some() {
            // The only platform engine is Apple Speech.
            EngineName::Apple
        } else {
            EngineName::None
        }
    }
}

impl Recognizer for Preferred {
    fn availability(&self) -> Result<(), VoiceError> {
        self.pick().map_or(Err(VoiceError::NoModel), |engine| engine.availability())
    }

    fn authorization(&self) -> Authorization {
        self.pick().map_or(Authorization::Authorized, |engine| engine.authorization())
    }

    fn request_authorization(&self) -> Authorization {
        self.pick().map_or(Authorization::Authorized, |engine| engine.request_authorization())
    }

    fn current_locale(&self) -> String {
        self.pick().unwrap_or(self.local.as_ref()).current_locale()
    }

    fn supported_locales(&self) -> Vec<String> {
        self.pick().unwrap_or(self.local.as_ref()).supported_locales()
    }

    fn begin(&self, locale: &str, sink: Sink) -> Result<Box<dyn Recognition>, VoiceError> {
        self.pick().ok_or(VoiceError::NoModel)?.begin(locale, sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeMicrophone, FakeNative, FakeRecognizer, Recorder};
    use crate::voice::parakeet::{Engine, Loader, Locate};
    use crate::voice::{Authorization, Transcript, Voice, VoiceError, VoiceStatus};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct Echo;

    impl Engine for Echo {
        fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
            Ok(format!("parakeet heard {}", samples.len()))
        }
    }

    fn local(installed: Arc<AtomicBool>) -> Arc<Parakeet> {
        let locate: Locate = Arc::new(move || installed.load(Ordering::SeqCst).then(|| PathBuf::from("/m")));
        let loader: Loader = Arc::new(|_: &Path| Ok(Arc::new(Echo) as Arc<dyn Engine>));
        Arc::new(Parakeet::new(locate, loader))
    }

    struct Rig {
        voice: Voice,
        mic: Arc<FakeMicrophone>,
        apple: Arc<FakeRecognizer>,
        installed: Arc<AtomicBool>,
        preferred: Arc<Preferred>,
    }

    fn rig(apple: FakeRecognizer, with_fallback: bool) -> Rig {
        let installed = Arc::new(AtomicBool::new(false));
        let apple = Arc::new(apple);
        let fallback = with_fallback.then(|| apple.clone() as Arc<dyn Recognizer>);
        let preferred = Arc::new(Preferred::new(local(installed.clone()), fallback));
        let mic = Arc::new(FakeMicrophone::granted());
        let clock = Arc::new(FakeClock(AtomicU64::new(0)));
        let voice = Voice::new(mic.clone(), preferred.clone(), clock).with_final_timeout(Duration::from_millis(50));
        Rig { voice, mic, apple, installed, preferred }
    }

    #[test]
    fn without_the_model_apple_speech_records() {
        let rig = rig(FakeRecognizer::granted(), true);
        assert_eq!(rig.preferred.engine(), EngineName::Apple);
        *rig.apple.final_text.lock().unwrap() = Some("apple heard".into());
        rig.voice.start(Some("es-AR"), Recorder::default().events()).unwrap();
        assert_eq!(rig.apple.log.lock().unwrap().locales, ["es-ES"]);
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "apple heard".into() }));
    }

    #[test]
    fn with_the_model_installed_parakeet_records_instead() {
        let rig = rig(FakeRecognizer::granted(), true);
        rig.installed.store(true, Ordering::SeqCst);
        assert_eq!(rig.preferred.engine(), EngineName::Parakeet);
        rig.voice.start(None, Recorder::default().events()).unwrap();
        rig.mic.sink().audio(&[0.0; 320]);
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "parakeet heard 320".into() }));
        assert!(rig.apple.log.lock().unwrap().locales.is_empty(), "Apple Speech is not used");
    }

    #[test]
    fn without_the_model_apple_speech_gets_the_device_buffers() {
        let mut apple = FakeRecognizer::granted();
        apple.native = true;
        let rig = rig(apple, true);
        rig.voice.start(None, Recorder::default().events()).unwrap();
        let buffer = FakeNative { rate: 48_000, frames: 960 };
        rig.mic.sink().audio_native(&[0.0; 320], &buffer);
        let log = rig.apple.log.lock().unwrap();
        assert_eq!(log.native, vec![buffer]);
        assert!(log.fed.is_empty());
    }

    #[test]
    fn parakeet_still_receives_the_16k_mono_stream_when_device_buffers_come_along() {
        let mut apple = FakeRecognizer::granted();
        apple.native = true;
        let rig = rig(apple, true);
        rig.installed.store(true, Ordering::SeqCst);
        rig.voice.start(None, Recorder::default().events()).unwrap();
        rig.mic.sink().audio_native(&[0.0; 320], &FakeNative { rate: 48_000, frames: 960 });
        assert_eq!(rig.voice.stop(), Ok(Transcript { text: "parakeet heard 320".into() }));
        assert!(rig.apple.log.lock().unwrap().native.is_empty(), "Apple Speech is not used");
    }

    #[test]
    fn parakeet_needs_only_the_microphone_permission() {
        let rig = rig(FakeRecognizer::with(Authorization::Denied, Authorization::Denied), true);
        assert_eq!(rig.voice.status(), VoiceStatus::unavailable(VoiceError::SpeechDenied.to_string()));
        rig.installed.store(true, Ordering::SeqCst);
        assert_eq!(rig.voice.status(), VoiceStatus::available());
        rig.voice.start(None, Recorder::default().events()).unwrap();
        assert_eq!(rig.apple.log.lock().unwrap().requests, 0, "no Speech Recognition prompt");
        rig.voice.cancel().unwrap();
    }

    #[test]
    fn the_microphone_permission_still_applies_to_parakeet() {
        let installed = Arc::new(AtomicBool::new(true));
        let preferred = Arc::new(Preferred::new(local(installed), None));
        let mic = Arc::new(FakeMicrophone::with(Authorization::Denied, Authorization::Denied));
        let voice = Voice::new(mic, preferred, Arc::new(FakeClock(AtomicU64::new(0))));
        assert_eq!(voice.status(), VoiceStatus::unavailable(VoiceError::MicrophoneDenied.to_string()));
    }

    #[test]
    fn with_no_fallback_the_model_is_the_only_engine() {
        let rig = rig(FakeRecognizer::granted(), false);
        assert_eq!(rig.preferred.engine(), EngineName::None);
        assert_eq!(rig.voice.status(), VoiceStatus::unavailable(VoiceError::NoModel.to_string()));
        assert_eq!(rig.voice.start(None, Recorder::default().events()), Err(VoiceError::NoModel));
        rig.installed.store(true, Ordering::SeqCst);
        assert_eq!(rig.preferred.engine(), EngineName::Parakeet);
        assert_eq!(rig.voice.status(), VoiceStatus::available());
    }

    #[test]
    fn the_fallback_name_follows_the_platform() {
        let expected = if cfg!(target_os = "macos") { EngineName::Apple } else { EngineName::None };
        assert_eq!(fallback_engine(), expected);
    }
}
