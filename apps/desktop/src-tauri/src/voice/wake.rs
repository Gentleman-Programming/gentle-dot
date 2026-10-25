//! The wake word "hey dot" (S30.7, S1-S7): saying it starts the note the panel's mic button
//! starts, without touching anything.
//!
//! The detector reads the capture the microphone already opens (S2): the machine arms a listener
//! on that stream and the microphone hands it the same 16 kHz PCM it hands a recording. Nothing
//! here opens a device, spawns a helper or listens on a second engine.
//!
//! `RustpotterWake` is the real detector (rustpotter, macOS only, the platform with that capture);
//! `FakeWake` plays detections on demand so every rule is tested on every platform without a
//! microphone.

use std::path::{Path, PathBuf};

/// One wake word matched in the stream.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    /// The key the reference was loaded under (`WAKE_WORD`), as the detector reports it.
    pub name: String,
    pub score: f32,
}

/// Matches wake words in the PCM the microphone delivers. `accept` runs on the audio thread, so
/// it must not block; `reset` runs wherever the machine is disarming.
pub trait WakeWord: Send + Sync {
    /// More audio; `Some` when a wake word matched in what has been heard so far.
    fn accept(&self, samples: &[f32]) -> Option<Detection>;
    /// Drops audio buffered but not yet matched, so the next capture starts clean.
    fn reset(&self);
}

/// The reference's file name. It is a voice signature, so it lives in the data dir (S4), is never
/// bundled with the build, is never committed, and `*.rpw` is in `.gitignore`.
pub const MODEL_FILE: &str = "hey-dot.rpw";
/// The detector's name for the phrase, and the model name the log records.
pub const WAKE_WORD: &str = "hey-dot";
/// The operating point measured on this machine (S7, L4): four samples, leave-one-out margin
/// 0.062, and no usable threshold from 0.50 up.
pub const THRESHOLD: f32 = 0.45;
pub const MIN_SCORES: usize = 5;

/// `<data dir>/wake-word/hey-dot.rpw`, next to `config.json` (S4).
pub fn model_path(data_dir: &Path) -> PathBuf {
    data_dir.join("wake-word").join(MODEL_FILE)
}

/// The file name this app used before the phrase was called "hey dot". The reference is the same
/// recording, so an installation that already has one keeps working across the rename.
pub const LEGACY_MODEL_FILE: &str = "oye-dot.rpw";

/// Copies the reference installed under the old name to the current one, once: an installation
/// that already worked must not be asked for the file again. Never overwrites, so a reference the
/// user has since rebuilt always wins. Returns the new path when it copied.
pub fn adopt_legacy(data_dir: &Path) -> Option<PathBuf> {
    let current = model_path(data_dir);
    let legacy = data_dir.join("wake-word").join(LEGACY_MODEL_FILE);
    if current.exists() || !legacy.is_file() {
        return None;
    }
    std::fs::copy(&legacy, &current).ok().map(|_| current)
}

/// A short system sound when a note starts, so speaking the phrase is enough to know it did
/// (S30.7). Played once per note, at the start only, through the system's own output — it reaches
/// headphones like any other system sound.
pub trait Chime: Send + Sync {
    fn note_started(&self);
}

/// The platforms without a system sound to borrow: nothing is played.
pub struct Silent;

impl Chime for Silent {
    fn note_started(&self) {}
}

/// `Tink`, one of the system sounds macOS already ships: no asset of our own, routed to the
/// current output device.
#[cfg(target_os = "macos")]
pub struct SystemChime;

#[cfg(target_os = "macos")]
impl Chime for SystemChime {
    fn note_started(&self) {
        use objc2_app_kit::NSSound;
        use objc2_foundation::NSString;
        // A shared AppKit instance that outlives the call; playing from a worker thread is what
        // the system sound is for.
        if let Some(sound) = NSSound::soundNamed(&NSString::from_str("Tink")) {
            sound.play();
        }
    }
}

/// The chime this build plays, if the platform has one.
pub fn platform_chime() -> std::sync::Arc<dyn Chime> {
    #[cfg(target_os = "macos")]
    return std::sync::Arc::new(SystemChime);
    #[cfg(not(target_os = "macos"))]
    std::sync::Arc::new(Silent)
}

/// Why the detector has no reference to listen for, naming the file the user has to put there:
/// the one thing the app cannot do for him (the file is his own voice, S4).
pub fn missing(path: &Path) -> String {
    format!(
        "The wake word's voice reference is missing at {}. Put {MODEL_FILE} there, then turn the wake word on again.",
        path.display()
    )
}

#[cfg(target_os = "macos")]
pub use real::RustpotterWake;

#[cfg(target_os = "macos")]
mod real {
    use super::{missing, Detection, WakeWord, MIN_SCORES, THRESHOLD, WAKE_WORD};
    use rustpotter::{Rustpotter, RustpotterConfig};
    use std::path::Path;
    use std::sync::Mutex;

    /// rustpotter wants whole frames (`get_samples_per_frame`, 480 samples = 30 ms at 16 kHz)
    /// and the microphone's tap delivers about 21 ms, so chunks are buffered until a frame is
    /// full. The detector is mutexed because the trait is shared: `accept` only ever runs on the
    /// audio thread, one chunk at a time.
    pub struct RustpotterWake {
        pending: Mutex<Pending>,
    }

    struct Pending {
        detector: Rustpotter,
        samples: Vec<f32>,
    }

    impl RustpotterWake {
        /// Loads the reference at `path`, configured with the measured operating point (S7). A
        /// missing or unreadable file is reported with the path: nothing else tells the user
        /// where the reference has to be (S4).
        pub fn load(path: &Path) -> Result<Self, String> {
            if !path.is_file() {
                return Err(missing(path));
            }
            let mut config = RustpotterConfig::default();
            config.detector.threshold = THRESHOLD;
            config.detector.min_scores = MIN_SCORES;
            let mut detector = Rustpotter::new(&config)?;
            let file = path
                .to_str()
                .ok_or_else(|| format!("The wake word reference at {} is not a valid path.", path.display()))?;
            detector
                .add_wakeword_from_file(WAKE_WORD, file)
                .map_err(|error| format!("The wake word reference at {} could not be read: {error}", path.display()))?;
            Ok(RustpotterWake { pending: Mutex::new(Pending { detector, samples: Vec::new() }) })
        }
    }

    impl WakeWord for RustpotterWake {
        fn accept(&self, samples: &[f32]) -> Option<Detection> {
            let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let frame = pending.detector.get_samples_per_frame();
            pending.samples.extend_from_slice(samples);
            if pending.samples.len() < frame {
                return None;
            }
            let audio: Vec<f32> = pending.samples.drain(..frame).collect();
            let detection = pending.detector.process_samples(audio)?;
            // The detector keeps its own history: a phrase already matched must not match again
            // on the audio that follows it.
            pending.samples.clear();
            pending.detector.reset();
            Some(Detection { name: detection.name, score: detection.score })
        }

        fn reset(&self) {
            let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.samples.clear();
            pending.detector.reset();
        }
    }
}

#[cfg(test)]
pub use fake::FakeWake;

#[cfg(test)]
mod fake {
    use super::{Detection, WakeWord, WAKE_WORD};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A detector a test scripts: it plays the detections it was given, one per `accept`, and
    /// keeps the audio that reached it so a test can check the stream it was fed.
    #[derive(Default)]
    pub struct FakeWake {
        /// Detections still to play, in order.
        pub detections: Mutex<Vec<Detection>>,
        /// Every sample that reached the detector.
        pub heard: Mutex<Vec<f32>>,
        /// How many times the machine dropped what was buffered.
        pub resets: AtomicUsize,
    }

    impl FakeWake {
        /// Plays this score on the next audio the detector hears.
        pub fn detect(&self, score: f32) {
            self.detections.lock().unwrap().push(Detection { name: WAKE_WORD.into(), score });
        }

        pub fn heard(&self) -> usize {
            self.heard.lock().unwrap().len()
        }

        pub fn resets(&self) -> usize {
            self.resets.load(Ordering::SeqCst)
        }
    }

    impl WakeWord for FakeWake {
        fn accept(&self, samples: &[f32]) -> Option<Detection> {
            self.heard.lock().unwrap().extend_from_slice(samples);
            let mut detections = self.detections.lock().unwrap();
            if detections.is_empty() {
                None
            } else {
                Some(detections.remove(0))
            }
        }

        fn reset(&self) {
            self.resets.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reference_lives_under_the_data_dir() {
        assert_eq!(model_path(Path::new("/data/dot")), Path::new("/data/dot").join("wake-word").join("hey-dot.rpw"));
    }

    #[test]
    fn a_missing_reference_is_reported_with_the_path_and_the_file_name() {
        let reason = missing(Path::new("/data/dot/wake-word/hey-dot.rpw"));
        assert!(reason.contains("/data/dot/wake-word/hey-dot.rpw"), "{reason}");
        assert!(reason.contains(MODEL_FILE), "{reason}");
    }

    #[test]
    fn the_operating_point_is_the_measured_one() {
        assert_eq!((THRESHOLD, MIN_SCORES), (0.45, 5));
    }

    #[test]
    fn a_scripted_detection_is_played_once_and_the_audio_is_kept() {
        let wake = FakeWake::default();
        wake.detect(0.51);
        assert_eq!(wake.accept(&[0.1, 0.2]), Some(Detection { name: WAKE_WORD.into(), score: 0.51 }));
        assert_eq!(wake.accept(&[0.3]), None);
        assert_eq!(wake.heard(), 3);
        wake.reset();
        assert_eq!(wake.resets(), 1);
    }

    #[test]
    fn a_reference_under_the_old_name_is_adopted_once_and_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("gentle-dot-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("wake-word")).unwrap();
        assert_eq!(adopt_legacy(&dir), None, "nothing to adopt yet");

        std::fs::write(dir.join("wake-word").join(LEGACY_MODEL_FILE), b"old").unwrap();
        assert_eq!(adopt_legacy(&dir), Some(model_path(&dir)));
        assert_eq!(std::fs::read(model_path(&dir)).unwrap(), b"old");

        std::fs::write(dir.join("wake-word").join(LEGACY_MODEL_FILE), b"older").unwrap();
        assert_eq!(adopt_legacy(&dir), None, "the adopted reference wins");
        assert_eq!(std::fs::read(model_path(&dir)).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn loading_a_reference_that_is_not_there_names_the_file() {
        let path = std::env::temp_dir().join(format!("gentle-dot-no-wake-{}", std::process::id())).join(MODEL_FILE);
        let error = RustpotterWake::load(&path).err().expect("a missing reference is an error");
        assert!(error.contains("missing"), "{error}");
        assert!(error.contains(path.to_str().unwrap()), "{error}");
    }
}
