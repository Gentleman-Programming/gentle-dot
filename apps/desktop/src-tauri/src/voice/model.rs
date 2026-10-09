//! The optional local voice model (S30.5): NVIDIA Parakeet TDT 0.6B v3, int8, as sherpa-onnx
//! publishes it. Nothing downloads unless the user asks. A download streams the official release
//! asset into a staging directory next to the install, hashing it on the way; the SHA-256 and the
//! size are pinned here. Only a verified archive is unpacked, and only the four model files at
//! `<archive root>/<file>` are taken from it (any other path, `..` included, is ignored). The
//! unpacked files then move into place with one rename, so a model directory is either complete
//! or absent; failures and cancels remove the staging directory.
//!
//! Progress and outcomes go out as `voice://model` events, throttled to a few a second.

use crate::computer::Clock;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// `{state, received?, total?, message?}`, to the panel.
pub const MODEL_EVENT: &str = "voice://model";
/// At most one progress event per this many milliseconds (plus the last one).
pub const PROGRESS_INTERVAL_MS: u64 = 250;
const CHUNK: usize = 64 * 1024;
const CANCELLED: &str = "The download was cancelled.";

/// What to download and what it must contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSpec {
    pub url: String,
    /// Lowercase hex SHA-256 of the archive.
    pub sha256: String,
    /// The archive's size in bytes.
    pub size: u64,
    /// The archive's top-level directory.
    pub archive_root: String,
    /// The install directory under the models directory.
    pub dir: String,
    /// The files the recognizer needs, all of them required.
    pub files: Vec<String>,
}

impl ModelSpec {
    /// The official sherpa-onnx release asset (tag `asr-models`), published 2025-08-16. The
    /// SHA-256 was computed from the downloaded asset on 2026-10-09 and matches the digest
    /// GitHub lists for it.
    pub fn parakeet() -> Self {
        ModelSpec {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2".into(),
            sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf".into(),
            size: 487_170_055,
            archive_root: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8".into(),
            dir: "parakeet-tdt-0.6b-v3-int8".into(),
            files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].map(String::from).to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelState {
    Downloading,
    /// Checking the checksum and unpacking the model files.
    Verifying,
    Installed,
    /// Failed or cancelled; `message` says which.
    Failed,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelEvent {
    pub state: ModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ModelEvent {
    pub fn state(state: ModelState) -> Self {
        ModelEvent { state, received: None, total: None, message: None }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        ModelEvent { message: Some(message.into()), ..ModelEvent::state(ModelState::Failed) }
    }

    fn progress(received: u64, total: u64) -> Self {
        ModelEvent { received: Some(received), total: Some(total), ..ModelEvent::state(ModelState::Downloading) }
    }
}

/// The speech-to-text engine `voice_start` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineName {
    Parakeet,
    Apple,
    None,
}

/// The `voice_model_status` reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelStatus {
    pub installed: bool,
    /// The installed files' total size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub downloading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub engine: EngineName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    Installed,
    Downloading,
    Failed(String),
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModelError::Installed => f.write_str("The local voice model is already installed."),
            ModelError::Downloading => f.write_str("The local voice model is downloading. Cancel the download first."),
            ModelError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<ModelError> for String {
    fn from(error: ModelError) -> String {
        error.to_string()
    }
}

/// An open download: the body, and its length when the server says.
pub struct Download {
    pub body: Box<dyn Read + Send>,
    pub length: Option<u64>,
}

/// Opens a URL for reading. HTTPS in the app, an in-memory archive in tests.
pub trait Fetcher: Send + Sync {
    fn open(&self, url: &str) -> Result<Download, String>;
}

/// HTTPS through ureq (rustls with the bundled web PKI roots; `HTTPS_PROXY` is honored). GitHub
/// answers the release URL with a redirect to its asset host, which is followed.
pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn open(&self, url: &str) -> Result<Download, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(20))
            .timeout_read(Duration::from_secs(60))
            .try_proxy_from_env(true)
            .https_only(true)
            .build();
        let response = agent.get(url).call().map_err(|error| error.to_string())?;
        let length = response.header("Content-Length").and_then(|value| value.parse().ok());
        Ok(Download { body: Box::new(response.into_reader()), length })
    }
}

pub type ModelEvents = Arc<dyn Fn(ModelEvent) + Send + Sync>;

/// Downloads, verifies, installs, and removes one model under a models directory.
pub struct ModelManager {
    shared: Arc<Shared>,
}

struct Shared {
    spec: ModelSpec,
    root: PathBuf,
    fetcher: Arc<dyn Fetcher>,
    clock: Arc<dyn Clock>,
    events: ModelEvents,
    /// The engine used while the model is absent.
    fallback: EngineName,
    job: Mutex<Option<Job>>,
}

/// The download in flight.
struct Job {
    cancel: Arc<AtomicBool>,
    received: u64,
    total: u64,
}

enum Failure {
    Cancelled,
    Error(String),
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Failure::Error(format!("The local voice model could not be installed: {error}"))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Removes a directory this manager owns, if present.
fn clear(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

impl ModelManager {
    pub fn new(
        spec: ModelSpec,
        root: PathBuf,
        fetcher: Arc<dyn Fetcher>,
        clock: Arc<dyn Clock>,
        events: ModelEvents,
        fallback: EngineName,
    ) -> Self {
        let shared = Shared { spec, root, fetcher, clock, events, fallback, job: Mutex::new(None) };
        ModelManager { shared: Arc::new(shared) }
    }

    /// The model directory, when every model file is in it.
    pub fn installed(&self) -> Option<PathBuf> {
        self.shared.installed()
    }

    pub fn status(&self) -> ModelStatus {
        let (downloading, received, total) = match &*lock(&self.shared.job) {
            Some(job) => (true, Some(job.received), Some(job.total)),
            None => (false, None, None),
        };
        let dir = self.installed();
        let bytes = dir.as_ref().map(|dir| self.shared.spec.files.iter().filter_map(|f| fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum());
        let engine = if dir.is_some() { EngineName::Parakeet } else { self.shared.fallback };
        ModelStatus { installed: dir.is_some(), bytes, downloading, received, total, engine }
    }

    /// Starts the download in the background; progress and the outcome arrive as events.
    pub fn download(&self) -> Result<(), ModelError> {
        let mut job = lock(&self.shared.job);
        if job.is_some() {
            return Err(ModelError::Downloading);
        }
        if self.installed().is_some() {
            return Err(ModelError::Installed);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let shared = self.shared.clone();
        let flag = cancel.clone();
        std::thread::Builder::new()
            .name("voice-model-download".into())
            .spawn(move || shared.run(&flag))
            .map_err(|error| ModelError::Failed(format!("The download could not start: {error}")))?;
        *job = Some(Job { cancel, received: 0, total: self.shared.spec.size });
        Ok(())
    }

    /// Asks the download in flight to stop; whether there was one. The outcome arrives as a
    /// `failed` event once the staging files are gone.
    pub fn cancel(&self) -> bool {
        lock(&self.shared.job).as_ref().map(|job| job.cancel.store(true, Ordering::SeqCst)).is_some()
    }

    /// Deletes the installed model (refused while downloading). Removing nothing is not an error.
    pub fn remove(&self) -> Result<(), ModelError> {
        let shared = &self.shared;
        {
            let job = lock(&shared.job);
            if job.is_some() {
                return Err(ModelError::Downloading);
            }
            let dir = shared.dir();
            if fs::symlink_metadata(&dir).is_err() {
                return Ok(());
            }
            // Out of sight in one step, then deleted.
            let trash = shared.root.join(format!(".{}.removing", shared.spec.dir));
            let removed = clear(&trash).and_then(|()| fs::rename(&dir, &trash)).and_then(|()| clear(&trash));
            removed.map_err(|error| ModelError::Failed(format!("The local voice model could not be removed: {error}")))?;
        }
        (shared.events)(ModelEvent::state(ModelState::Removed));
        Ok(())
    }
}

impl Shared {
    fn dir(&self) -> PathBuf {
        self.root.join(&self.spec.dir)
    }

    fn staging(&self) -> PathBuf {
        self.root.join(format!(".{}.download", self.spec.dir))
    }

    fn installed(&self) -> Option<PathBuf> {
        let dir = self.dir();
        self.spec.files.iter().all(|file| fs::metadata(dir.join(file)).is_ok_and(|m| m.is_file())).then_some(dir)
    }

    /// The download thread: run, clean up, clear the job, then report.
    fn run(&self, cancel: &AtomicBool) {
        let staging = self.staging();
        let outcome = self.install(&staging, cancel);
        if let Err(error) = clear(&staging) {
            eprintln!("gentle-dot: cannot remove {}: {error}", staging.display());
        }
        *lock(&self.job) = None;
        (self.events)(match outcome {
            Ok(()) => ModelEvent::state(ModelState::Installed),
            Err(Failure::Cancelled) => ModelEvent::failed(CANCELLED),
            Err(Failure::Error(message)) => ModelEvent::failed(message),
        });
    }

    fn install(&self, staging: &Path, cancel: &AtomicBool) -> Result<(), Failure> {
        // A staging directory left by a crash is ours to clear.
        clear(staging)?;
        fs::create_dir_all(staging)?;
        let archive = staging.join("archive.tar.bz2");
        let digest = self.fetch(&archive, cancel)?;
        (self.events)(ModelEvent::state(ModelState::Verifying));
        if digest != self.spec.sha256 {
            return Err(Failure::Error("The download did not match the published checksum.".into()));
        }
        let unpacked = staging.join("model");
        self.extract(&archive, &unpacked, cancel)?;
        fs::remove_file(&archive)?;
        let dir = self.dir();
        // An incomplete directory (not `installed`) is replaced.
        clear(&dir)?;
        fs::rename(&unpacked, &dir)?;
        Ok(())
    }

    /// Streams the archive to `path`, reporting progress; the archive's SHA-256.
    fn fetch(&self, path: &Path, cancel: &AtomicBool) -> Result<String, Failure> {
        let total = self.spec.size;
        let Download { mut body, length } = self
            .fetcher
            .open(&self.spec.url)
            .map_err(|error| Failure::Error(format!("The local voice model could not be downloaded: {error}")))?;
        let wrong_size = || Failure::Error("The download was not the expected size.".into());
        if length.is_some_and(|length| length != total) {
            return Err(wrong_size());
        }
        let mut file = File::create(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; CHUNK];
        let (mut received, mut reported) = (0u64, 0u64);
        let mut last_ms = self.clock.now_ms();
        (self.events)(ModelEvent::progress(0, total));
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            let read = match body.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(Failure::Error(format!("The download was interrupted: {error}"))),
            };
            received += read as u64;
            if received > total {
                return Err(wrong_size());
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read])?;
            if let Some(job) = lock(&self.job).as_mut() {
                job.received = received;
            }
            let now = self.clock.now_ms();
            if now.saturating_sub(last_ms) >= PROGRESS_INTERVAL_MS {
                last_ms = now;
                reported = received;
                (self.events)(ModelEvent::progress(received, total));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        if received != total {
            return Err(wrong_size());
        }
        if reported != received {
            (self.events)(ModelEvent::progress(received, total));
        }
        file.sync_all()?;
        Ok(hex(&hasher.finalize()))
    }

    /// The model file an archive path names: exactly `<archive root>/<one of the files>`.
    fn model_file(&self, path: &Path) -> Option<&str> {
        let mut parts = path.components().filter(|part| *part != Component::CurDir);
        match (parts.next(), parts.next(), parts.next()) {
            (Some(Component::Normal(root)), Some(Component::Normal(name)), None) if root == self.spec.archive_root.as_str() => {
                self.spec.files.iter().find(|file| name == file.as_str()).map(String::as_str)
            }
            _ => None,
        }
    }

    /// Unpacks the model files of a verified archive into `into`, which must not exist.
    fn extract(&self, archive: &Path, into: &Path, cancel: &AtomicBool) -> Result<(), Failure> {
        fs::create_dir(into)?;
        let mut archive = tar::Archive::new(bzip2::read::BzDecoder::new(BufReader::new(File::open(archive)?)));
        for entry in archive.entries()? {
            let mut entry = entry?;
            if cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path()?.into_owned();
            let Some(name) = self.model_file(&path) else { continue };
            let mut out = File::create_new(into.join(name))?;
            let mut buffer = vec![0; CHUNK];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(Failure::Cancelled);
                }
                let read = entry.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                out.write_all(&buffer[..read])?;
            }
            out.sync_all()?;
        }
        let missing: Vec<&str> = self.spec.files.iter().filter(|file| !into.join(file).is_file()).map(String::as_str).collect();
        if !missing.is_empty() {
            return Err(Failure::Error(format!("The downloaded model is missing {}.", missing.join(", "))));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::FakeClock;
    use bzip2::write::BzEncoder;
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Read};
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    const FILES: [&str; 4] = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

    /// A tar.bz2 shaped like the sherpa-onnx release: `<root>/<file>` plus files to skip.
    fn archive(root: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let paths: Vec<(String, &[u8])> = files.iter().map(|(name, data)| (format!("{root}/{name}"), *data)).collect();
        raw_archive(&paths.iter().map(|(path, data)| (path.as_str(), *data)).collect::<Vec<_>>())
    }

    /// Entries written with the exact path bytes, `..` included (the builder refuses those).
    fn raw_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(BzEncoder::new(Vec::new(), bzip2::Compression::fast()));
        for (path, data) in entries {
            let mut header = tar::Header::new_old();
            header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    /// Bytes bzip2 cannot shrink, so the archive spans many reads.
    fn noise(len: usize) -> Vec<u8> {
        let mut state = 0x2545_f491u32;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect()
    }

    fn full_archive() -> Vec<u8> {
        archive(
            "release-root",
            &[
                ("tokens.txt", b"<blk> 0\n"),
                ("encoder.int8.onnx", &noise(20_000)),
                ("decoder.int8.onnx", &[2u8; 200]),
                ("joiner.int8.onnx", &[3u8; 100]),
                ("test_wavs/en.wav", b"RIFF"),
            ],
        )
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn spec_for(bytes: &[u8]) -> ModelSpec {
        ModelSpec {
            url: "https://example.invalid/model.tar.bz2".into(),
            sha256: sha(bytes),
            size: bytes.len() as u64,
            archive_root: "release-root".into(),
            dir: "parakeet-test".into(),
            files: FILES.map(String::from).to_vec(),
        }
    }

    /// Holds the body after its first chunk, so a test can look at a download in flight.
    #[derive(Default)]
    struct Pause {
        /// (reached, released)
        state: Mutex<(bool, bool)>,
        changed: Condvar,
    }

    impl Pause {
        fn wait_reached(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.0 {
                state = self.changed.wait_timeout(state, Duration::from_secs(5)).unwrap().0;
            }
        }

        fn release(&self) {
            self.state.lock().unwrap().1 = true;
            self.changed.notify_all();
        }

        fn hold(&self) {
            let mut state = self.state.lock().unwrap();
            state.0 = true;
            self.changed.notify_all();
            while !state.1 {
                state = self.changed.wait(state).unwrap();
            }
        }
    }

    struct Body {
        data: Cursor<Vec<u8>>,
        chunk: usize,
        pause: Option<Arc<Pause>>,
        clock: Arc<FakeClock>,
        served: usize,
    }

    impl Read for Body {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if let (Some(pause), true) = (&self.pause, self.served > 0) {
                pause.hold();
            }
            let n = buf.len().min(self.chunk);
            let read = self.data.read(&mut buf[..n])?;
            self.served += read;
            self.clock.advance(100);
            Ok(read)
        }
    }

    struct FakeFetcher {
        body: Vec<u8>,
        length: Option<u64>,
        chunk: usize,
        pause: Option<Arc<Pause>>,
        clock: Arc<FakeClock>,
        urls: Mutex<Vec<String>>,
    }

    impl Fetcher for FakeFetcher {
        fn open(&self, url: &str) -> Result<Download, String> {
            self.urls.lock().unwrap().push(url.to_string());
            let body = Body {
                data: Cursor::new(self.body.clone()),
                chunk: self.chunk,
                pause: self.pause.clone(),
                clock: self.clock.clone(),
                served: 0,
            };
            Ok(Download { body: Box::new(body), length: self.length })
        }
    }

    struct Rig {
        manager: ModelManager,
        fetcher: Arc<FakeFetcher>,
        events: mpsc::Receiver<ModelEvent>,
        root: PathBuf,
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("gentle-dot-model-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn rig(name: &str, body: Vec<u8>, spec: ModelSpec, pause: Option<Arc<Pause>>) -> Rig {
        let clock = Arc::new(FakeClock(AtomicU64::new(0)));
        let length = Some(body.len() as u64);
        let fetcher = Arc::new(FakeFetcher { body, length, chunk: 512, pause, clock: clock.clone(), urls: Mutex::default() });
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let root = temp_root(name);
        let manager = ModelManager::new(
            spec,
            root.clone(),
            fetcher.clone(),
            clock,
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
            EngineName::Apple,
        );
        Rig { manager, fetcher, events, root }
    }

    impl Rig {
        /// Every event up to and including the next terminal one.
        fn until_done(&self) -> Vec<ModelEvent> {
            let mut seen = Vec::new();
            loop {
                let event = self.events.recv_timeout(Duration::from_secs(10)).expect("a model event");
                let done = matches!(event.state, ModelState::Installed | ModelState::Failed | ModelState::Removed);
                seen.push(event);
                if done {
                    return seen;
                }
            }
        }

        fn leftovers(&self) -> Vec<String> {
            let Ok(entries) = std::fs::read_dir(&self.root) else { return Vec::new() };
            let mut names: Vec<String> = entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }

    #[test]
    fn the_pinned_parakeet_asset_is_the_official_int8_release() {
        let spec = ModelSpec::parakeet();
        assert_eq!(
            spec.url,
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
        );
        assert_eq!(spec.sha256, "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf");
        assert_eq!(spec.size, 487_170_055);
        assert_eq!(spec.archive_root, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
        assert_eq!(spec.dir, "parakeet-tdt-0.6b-v3-int8");
        assert_eq!(spec.files, FILES.map(String::from).to_vec());
    }

    #[test]
    fn status_before_any_download_reports_the_fallback_engine() {
        let rig = rig("status", full_archive(), spec_for(&full_archive()), None);
        let status = rig.manager.status();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"installed": false, "downloading": false, "engine": "apple"})
        );
        assert_eq!(rig.manager.installed(), None);
    }

    #[test]
    fn a_download_reports_progress_verifies_and_installs_only_the_model_files() {
        let body = full_archive();
        let rig = rig("install", body.clone(), spec_for(&body), None);
        rig.manager.download().unwrap();
        let events = rig.until_done();
        assert_eq!(rig.fetcher.urls.lock().unwrap().as_slice(), ["https://example.invalid/model.tar.bz2"]);

        let first = &events[0];
        assert_eq!((first.state, first.received, first.total), (ModelState::Downloading, Some(0), Some(body.len() as u64)));
        let progress: Vec<u64> = events.iter().filter(|e| e.state == ModelState::Downloading).filter_map(|e| e.received).collect();
        assert!(progress.windows(2).all(|w| w[0] < w[1]), "progress grows: {progress:?}");
        assert_eq!(progress.last(), Some(&(body.len() as u64)), "the last progress is the whole body");
        assert!(
            progress.len() < body.len().div_ceil(512),
            "progress is throttled, not one event per chunk ({} events)",
            progress.len()
        );
        assert!(events.iter().any(|e| e.state == ModelState::Verifying));
        assert_eq!(events.last().unwrap().state, ModelState::Installed);

        let dir = rig.root.join("parakeet-test");
        assert_eq!(rig.manager.installed(), Some(dir.clone()));
        let mut names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["decoder.int8.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
        assert_eq!(std::fs::read(dir.join("encoder.int8.onnx")).unwrap(), noise(20_000));
        assert_eq!(rig.leftovers(), ["parakeet-test"], "no staging files remain");

        let status = rig.manager.status();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"installed": true, "bytes": 20_000 + 200 + 100 + 8, "downloading": false, "engine": "parakeet"})
        );
        assert_eq!(rig.manager.download(), Err(ModelError::Installed));
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_checksum_mismatch_fails_and_leaves_nothing_behind() {
        let body = full_archive();
        let mut spec = spec_for(&body);
        spec.sha256 = "0".repeat(64);
        let rig = rig("mismatch", body, spec, None);
        rig.manager.download().unwrap();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        assert!(last.message.unwrap().contains("did not match"), "the reason is the checksum");
        assert_eq!(rig.manager.installed(), None);
        assert!(rig.leftovers().is_empty(), "staging removed: {:?}", rig.leftovers());
        assert!(!rig.manager.status().downloading);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_body_of_the_wrong_size_fails() {
        let body = full_archive();
        let mut spec = spec_for(&body);
        spec.size += 1;
        let rig = rig("size", body, spec, None);
        rig.manager.download().unwrap();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        assert!(rig.leftovers().is_empty());
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn an_archive_missing_a_model_file_is_not_installed() {
        let body = archive("release-root", &[("tokens.txt", b"x"), ("encoder.int8.onnx", b"e"), ("decoder.int8.onnx", b"d")]);
        let rig = rig("missing", body.clone(), spec_for(&body), None);
        rig.manager.download().unwrap();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        assert!(last.message.unwrap().contains("joiner.int8.onnx"));
        assert_eq!(rig.manager.installed(), None);
        assert!(rig.leftovers().is_empty());
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn entries_outside_the_release_root_are_ignored() {
        let body = raw_archive(&[
            ("other-root/tokens.txt", b"t"),
            ("release-root/../tokens.txt", b"t"),
            ("../encoder.int8.onnx", b"e"),
            ("/release-root/encoder.int8.onnx", b"e"),
            ("release-root/nested/decoder.int8.onnx", b"d"),
            ("release-root/joiner.int8.onnx", b"j"),
        ]);
        let rig = rig("outside", body.clone(), spec_for(&body), None);
        rig.manager.download().unwrap();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        let message = last.message.unwrap();
        assert_eq!(
            message, "The downloaded model is missing encoder.int8.onnx, decoder.int8.onnx, tokens.txt.",
            "only release-root/<file> counts"
        );
        assert!(rig.leftovers().is_empty());
        assert!(!rig.root.parent().unwrap().join("encoder.int8.onnx").exists());
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_download_in_flight_is_reported_not_installed_and_can_be_cancelled() {
        let body = full_archive();
        let pause = Arc::new(Pause::default());
        let rig = rig("cancel", body.clone(), spec_for(&body), Some(pause.clone()));
        rig.manager.download().unwrap();
        pause.wait_reached();

        let status = rig.manager.status();
        assert!(status.downloading && !status.installed);
        assert_eq!((status.received, status.total), (Some(512), Some(body.len() as u64)));
        assert_eq!(rig.manager.download(), Err(ModelError::Downloading));
        assert_eq!(rig.manager.remove(), Err(ModelError::Downloading));
        assert!(!rig.root.join("parakeet-test").exists(), "nothing is installed until the end");

        assert!(rig.manager.cancel());
        pause.release();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        assert_eq!(last.message.as_deref(), Some("The download was cancelled."));
        assert!(rig.leftovers().is_empty(), "staging removed: {:?}", rig.leftovers());
        assert!(!rig.manager.status().downloading);
        assert!(!rig.manager.cancel(), "nothing left to cancel");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn remove_deletes_the_model_and_reports_it() {
        let body = full_archive();
        let rig = rig("remove", body.clone(), spec_for(&body), None);
        rig.manager.download().unwrap();
        assert_eq!(rig.until_done().pop().unwrap().state, ModelState::Installed);

        rig.manager.remove().unwrap();
        assert_eq!(rig.until_done(), vec![ModelEvent::state(ModelState::Removed)]);
        assert_eq!(rig.manager.installed(), None);
        assert!(rig.leftovers().is_empty());
        assert_eq!(rig.manager.status().engine, EngineName::Apple);
        rig.manager.remove().unwrap();
        assert!(rig.events.try_recv().is_err(), "removing nothing reports nothing");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_staging_directory_left_by_a_crash_is_cleared_by_the_next_download() {
        let body = full_archive();
        let rig = rig("stale", body.clone(), spec_for(&body), None);
        let stale = rig.root.join(".parakeet-test.download");
        std::fs::create_dir_all(stale.join("model")).unwrap();
        std::fs::write(stale.join("archive.tar.bz2"), b"partial").unwrap();
        rig.manager.download().unwrap();
        assert_eq!(rig.until_done().pop().unwrap().state, ModelState::Installed);
        assert_eq!(rig.leftovers(), ["parakeet-test"]);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn an_incomplete_install_does_not_count() {
        let rig = rig("partial", Vec::new(), spec_for(&[]), None);
        let dir = rig.root.join("parakeet-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tokens.txt"), b"t").unwrap();
        assert_eq!(rig.manager.installed(), None);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    /// Reads a local copy of the release asset.
    struct FileFetcher(PathBuf);

    impl Fetcher for FileFetcher {
        fn open(&self, _url: &str) -> Result<Download, String> {
            let file = std::fs::File::open(&self.0).map_err(|e| e.to_string())?;
            let length = file.metadata().map_err(|e| e.to_string())?.len();
            Ok(Download { body: Box::new(file), length: Some(length) })
        }
    }

    /// Installs from a downloaded copy of the real asset, checking the pinned SHA-256 and the
    /// release's layout. Run with
    /// `GENTLE_DOT_PARAKEET_ARCHIVE=<the .tar.bz2> cargo test -- --ignored real_parakeet_archive`.
    #[test]
    #[ignore = "needs the real Parakeet archive (487 MB)"]
    fn real_parakeet_archive_installs() {
        let Some(archive) = std::env::var_os("GENTLE_DOT_PARAKEET_ARCHIVE").map(PathBuf::from) else {
            eprintln!("GENTLE_DOT_PARAKEET_ARCHIVE is not set; skipping");
            return;
        };
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let root = temp_root("real");
        let manager = ModelManager::new(
            ModelSpec::parakeet(),
            root.clone(),
            Arc::new(FileFetcher(archive)),
            Arc::new(crate::computer::SystemClock),
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
            EngineName::Apple,
        );
        let started = std::time::Instant::now();
        manager.download().unwrap();
        let last = loop {
            let event: ModelEvent = events.recv_timeout(Duration::from_secs(600)).unwrap();
            if matches!(event.state, ModelState::Installed | ModelState::Failed) {
                break event;
            }
        };
        eprintln!("installed in {:?}: {:?}", started.elapsed(), manager.status());
        assert_eq!(last.state, ModelState::Installed, "{:?}", last.message);
        assert_eq!(manager.status().bytes, Some(670_478_772));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn events_carry_the_contract_shape() {
        assert_eq!(MODEL_EVENT, "voice://model");
        let progress = ModelEvent { state: ModelState::Downloading, received: Some(5), total: Some(10), message: None };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            serde_json::json!({"state": "downloading", "received": 5, "total": 10})
        );
        let failed = ModelEvent::failed("no");
        assert_eq!(serde_json::to_value(failed).unwrap(), serde_json::json!({"state": "failed", "message": "no"}));
        for (state, name) in [
            (ModelState::Verifying, "verifying"),
            (ModelState::Installed, "installed"),
            (ModelState::Removed, "removed"),
        ] {
            assert_eq!(serde_json::to_value(ModelEvent::state(state)).unwrap(), serde_json::json!({"state": name}));
        }
        for (engine, name) in [(EngineName::Parakeet, "parakeet"), (EngineName::Apple, "apple"), (EngineName::None, "none")] {
            assert_eq!(serde_json::to_value(engine).unwrap(), serde_json::json!(name));
        }
    }
}
