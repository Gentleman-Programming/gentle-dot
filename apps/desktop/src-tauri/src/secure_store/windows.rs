//! Connector secrets in a DPAPI-protected file (S25.5 on Windows, SW4).
//!
//! One file the app owns — `%LOCALAPPDATA%\Gentle Dot\secrets.dat` — holds every secret under its
//! id, each value encrypted on its own with `CryptProtectData` at the default scope: only the same
//! user account on the same machine can decrypt it. The file is replaced atomically (a temporary
//! file, `sync_all`, then a rename), so a reader never sees half a store, and every write re-reads
//! the file first, so it never drops the ids that were already there.
//!
//! **Why not the Windows Credential Manager** (L40, L41): a generic credential's blob is capped at
//! `CRED_MAX_CREDENTIAL_BLOB_SIZE`, 2560 bytes, and the daemon keeps a sign-in as a single JSON
//! secret that measures 2744 bytes for a Microsoft-backed connector *before* any token exists. Two
//! stores with a size-dependent destination would also have bought no security, because the
//! Credential Manager encrypts with these same user-scoped DPAPI keys.
//!
//! **The limit, which W14 documents for users**: any process running as the same user — the agent's
//! shell included — can read these secrets, exactly as S25.7 states for Linux. DPAPI's own scope is
//! "only the same user account on the same machine", which is weaker than the macOS Keychain's, and
//! neither this file nor a Credential Manager item resists another application in the same userspace.
//!
//! A file that cannot be read is refused rather than overwritten, so a corrupt store never destroys
//! what a later reader could still recover. A secret above [`MAX_SECRET_BYTES`], one written by
//! another user or on another machine, and a blob moved to a different id are each refused with an
//! error that names the id. Nothing is logged: [`Secret`] and this store redact themselves in
//! `Debug`, and errors never carry a value.

use super::{check_id, wipe, Secret, SecretStore, StoreError};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// The file this store keeps, inside [`DIR_NAME`] under `%LOCALAPPDATA%`.
pub const FILE_NAME: &str = "secrets.dat";
/// The folder under `%LOCALAPPDATA%` that belongs to this app.
const DIR_NAME: &str = "Gentle Dot";
/// The variable that names the user's local application data folder.
const LOCAL_APP_DATA: &str = "LOCALAPPDATA";
/// The largest secret this store accepts.
///
/// The app channel refuses a frame above 1 MiB, so nothing larger can reach any store; this ceiling
/// exists to bound the file, not to model a real limit.
pub const MAX_SECRET_BYTES: usize = 1024 * 1024;

/// `%LOCALAPPDATA%\Gentle Dot\secrets.dat`, from an injected value so that the missing variable is
/// provable without a real profile (the way this port decides platform questions elsewhere).
pub fn secrets_file(local_app_data: Option<&str>) -> Result<PathBuf, StoreError> {
    let root = local_app_data
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .ok_or_else(|| {
            StoreError::Unavailable(format!(
                "{LOCAL_APP_DATA} is not set, so the app has nowhere to keep its connector secrets"
            ))
        })?;
    Ok(Path::new(root).join(DIR_NAME).join(FILE_NAME))
}

/// The file's shape: one base64 DPAPI blob per id. Ids are readable attributes rather than secrets
/// (the other two backends can read theirs without a prompt as well), and keeping them as the keys
/// lets [`SecretStore::list_ids`] answer without decrypting anything.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct FileBody {
    secrets: BTreeMap<String, String>,
}

/// Encrypts `plaintext` for `id`, bound to that id by the extra entropy, and returns it as base64 so
/// that the file stays text.
fn protect(id: &str, plaintext: &[u8]) -> Result<String, StoreError> {
    let mut entropy = id.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: plaintext.len() as u32, pbData: plaintext.as_ptr() as *mut u8 };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: both inputs borrow buffers that outlive the call, the prompt structure is deliberately
    // absent (a background store never shows one), and DPAPI returns one block this caller owns.
    let encrypted = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if encrypted == 0 {
        return Err(StoreError::Failed(format!(
            "the secret for {id} could not be protected ({})",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: `output` describes the block DPAPI allocated for this call, copied out before it is
    // freed and never touched afterwards.
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: the same allocated block, freed exactly once.
    unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
    Ok(BASE64.encode(bytes))
}

/// Decrypts one stored entry. A blob that is not valid base64, not decryptable by this user on this
/// machine, or not text is refused with an error that names the id and never a value.
fn unprotect(id: &str, stored: &str) -> Result<Secret, StoreError> {
    let mut encrypted = BASE64
        .decode(stored)
        .map_err(|error| StoreError::Failed(format!("the entry for {id} is not readable ({error})")))?;
    let mut entropy = id.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: encrypted.len() as u32, pbData: encrypted.as_mut_ptr() };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`: live buffers, no prompt structure, one owned output block.
    let decrypted = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &extra,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if decrypted == 0 {
        return Err(StoreError::Failed(format!(
            "the entry for {id} could not be unlocked by this user on this machine ({}); it was written by another user, on another machine, or it was changed",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: as in `protect`: the block DPAPI allocated, copied out before it is freed.
    let mut plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: the same allocated block, freed exactly once.
    unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
    match String::from_utf8(std::mem::take(&mut plaintext)) {
        Ok(text) => Ok(Secret::new(text)),
        Err(error) => {
            wipe(&mut error.into_bytes());
            Err(StoreError::NotText)
        }
    }
}

/// The app's connector-secret store on Windows: one file the app owns, guarded by DPAPI.
pub struct DpapiStore {
    /// Resolved once, so a missing `%LOCALAPPDATA%` is reported on every call instead of panicking.
    file: Result<PathBuf, StoreError>,
    /// Serializes each read-modify-write: the trait is `Send + Sync`, and the app can ask from more
    /// than one thread. One process owns the file (the app is single-instance).
    writing: Mutex<()>,
}

impl DpapiStore {
    /// The store at `%LOCALAPPDATA%\Gentle Dot\secrets.dat`.
    pub fn new() -> Self {
        Self::at(secrets_file(std::env::var(LOCAL_APP_DATA).ok().as_deref()))
    }

    /// A store in `dir`, for tests: the real one is never touched.
    pub fn with_dir(dir: impl AsRef<Path>) -> Self {
        Self::at(Ok(dir.as_ref().join(FILE_NAME)))
    }

    fn at(file: Result<PathBuf, StoreError>) -> Self {
        DpapiStore { file, writing: Mutex::new(()) }
    }

    fn file(&self) -> Result<&PathBuf, StoreError> {
        self.file.as_ref().map_err(Clone::clone)
    }

    /// Holds the lock for one call, and outlives a holder that panicked.
    fn writing(&self) -> std::sync::MutexGuard<'_, ()> {
        self.writing.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// The file's contents. A file that is not there is an empty store; one that cannot be read or
    /// parsed is an error, never an empty store.
    fn read(&self) -> Result<FileBody, StoreError> {
        let file = self.file()?;
        let text = match std::fs::read_to_string(file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(FileBody::default()),
            Err(error) => {
                return Err(StoreError::Unavailable(format!("{} could not be read ({error})", file.display())))
            }
        };
        serde_json::from_str(&text).map_err(|error| {
            StoreError::Failed(format!(
                "{} is not a secret file this app wrote ({error}); remove it to start over, and every connector will ask for its secrets again",
                file.display()
            ))
        })
    }

    /// Replaces the file atomically, so a crash leaves either the old store or the new one.
    fn write(&self, body: &FileBody) -> Result<(), StoreError> {
        let file = self.file()?;
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                StoreError::Unavailable(format!("{} could not be created ({error})", parent.display()))
            })?;
        }
        let text = serde_json::to_string(body)
            .map_err(|error| StoreError::Failed(format!("the secret file could not be written ({error})")))?;
        let temporary = file.with_file_name(format!("{FILE_NAME}.tmp"));
        let replace = || -> std::io::Result<()> {
            let mut handle = std::fs::File::create(&temporary)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
            drop(handle);
            std::fs::rename(&temporary, file)
        };
        replace().map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            StoreError::Unavailable(format!("{} could not be replaced ({error})", file.display()))
        })
    }
}

impl Default for DpapiStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Shows the file, and what is missing when there is nowhere to keep secrets.
impl std::fmt::Debug for DpapiStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.file {
            Ok(file) => f.debug_struct("DpapiStore").field("file", file).finish(),
            Err(error) => f.debug_struct("DpapiStore").field("unavailable", &error.to_string()).finish(),
        }
    }
}

impl SecretStore for DpapiStore {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        let plaintext = secret.expose().as_bytes();
        if plaintext.len() > MAX_SECRET_BYTES {
            return Err(StoreError::Failed(format!(
                "the secret for {id} is {} bytes, above the {MAX_SECRET_BYTES}-byte ceiling this store accepts",
                plaintext.len()
            )));
        }
        let _writing = self.writing();
        let mut body = self.read()?;
        body.secrets.insert(id.to_owned(), protect(id, plaintext)?);
        self.write(&body)
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let _writing = self.writing();
        let body = self.read()?;
        match body.secrets.get(id) {
            Some(stored) => Ok(Some(unprotect(id, stored)?)),
            None => Ok(None),
        }
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        let _writing = self.writing();
        let mut body = self.read()?;
        if body.secrets.remove(id).is_none() {
            return Ok(false);
        }
        self.write(&body)?;
        Ok(true)
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let _writing = self.writing();
        Ok(self.read()?.secrets.into_keys().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A directory inside the project's own `target/`, so no test touches the user's real store.
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-scratch/secure-store-windows")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(name: &str) -> (PathBuf, DpapiStore) {
        let dir = scratch(name);
        let store = DpapiStore::with_dir(&dir);
        (dir, store)
    }

    fn file_of(dir: &Path) -> PathBuf {
        dir.join(FILE_NAME)
    }

    fn json_of(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(file_of(dir)).unwrap()).unwrap()
    }

    fn write_json(dir: &Path, value: &serde_json::Value) {
        fs::write(file_of(dir), serde_json::to_string(value).unwrap()).unwrap();
    }

    const ID: &str = "connector/x/value/token";

    #[test]
    fn the_dpapi_store_keeps_the_contract() {
        let (_dir, store) = store("contract");
        super::super::check_contract(&store);
    }

    /// The store is lazy like the other two: nothing on disk until the first `put`.
    #[test]
    fn nothing_is_touched_until_the_first_secret() {
        let (dir, store) = store("lazy");
        assert!(store.get("a").unwrap().is_none());
        assert!(store.list_ids().unwrap().is_empty());
        assert!(!file_of(&dir).exists(), "a read created the file");
        store.put("a", &Secret::new("1")).unwrap();
        assert!(file_of(&dir).exists(), "a write left no file");
    }

    /// The reason the store exists: what rests on disk is ciphertext. Ids are not secrets (they are
    /// readable attributes in the other two backends as well), so the ids are in the clear on purpose.
    #[test]
    fn the_file_never_holds_a_secret_in_the_clear() {
        let (dir, store) = store("clear-text");
        store.put(ID, &Secret::new("s3cr3t-value-9f2a")).unwrap();
        let text = fs::read_to_string(file_of(&dir)).unwrap();
        assert!(!text.contains("s3cr3t-value-9f2a"), "{text}");
        assert!(text.contains(ID), "the id is the map key: {text}");
    }

    /// Each entry is bound to its own id, so a blob copied to another name does not open.
    #[test]
    fn a_blob_moved_to_another_id_is_refused() {
        let (dir, store) = store("moved");
        store.put(ID, &Secret::new("value-a")).unwrap();
        let mut json = json_of(&dir);
        let blob = json["secrets"][ID].clone();
        json["secrets"]["connector/x/value/other"] = blob;
        write_json(&dir, &json);
        let error = store.get("connector/x/value/other").unwrap_err();
        assert!(error.to_string().contains("connector/x/value/other"), "{error}");
    }

    #[test]
    fn a_tampered_blob_is_refused_with_a_named_error() {
        let (dir, store) = store("tampered");
        store.put(ID, &Secret::new("value-a")).unwrap();
        let mut json = json_of(&dir);
        let blob = json["secrets"][ID].as_str().unwrap().to_owned();
        let flipped = format!("{}{}", if blob.starts_with('A') { 'B' } else { 'A' }, &blob[1..]);
        json["secrets"][ID] = serde_json::Value::String(flipped);
        write_json(&dir, &json);
        let error = store.get(ID).unwrap_err();
        assert!(error.to_string().contains(ID), "{error}");
        assert!(store.list_ids().unwrap().contains(&ID.to_owned()));
    }

    /// A file that cannot be read is refused, never overwritten: the next `put` must not destroy
    /// entries that a later reader could still recover.
    #[test]
    fn a_corrupt_file_is_refused_and_never_overwritten() {
        let (dir, store) = store("corrupt");
        let broken = b"{ not json at all";
        fs::write(file_of(&dir), broken).unwrap();
        let errors = [
            store.get("a").unwrap_err(),
            store.delete("a").unwrap_err(),
            store.list_ids().unwrap_err(),
            store.put("a", &Secret::new("v")).unwrap_err(),
        ];
        for error in errors {
            let message = error.to_string();
            assert!(message.contains("secrets.dat"), "{message}");
        }
        assert_eq!(fs::read(file_of(&dir)).unwrap(), broken);
    }

    #[test]
    fn a_secret_above_the_ceiling_is_refused_and_the_file_is_untouched() {
        let (dir, store) = store("too-large");
        store.put(ID, &Secret::new("kept")).unwrap();
        let before = fs::read(file_of(&dir)).unwrap();
        let huge = Secret::new("x".repeat(MAX_SECRET_BYTES + 1));
        let error = store.put("connector/x/value/other", &huge).unwrap_err();
        let message = error.to_string();
        assert!(message.contains(&MAX_SECRET_BYTES.to_string()), "{message}");
        assert!(message.contains(&(MAX_SECRET_BYTES + 1).to_string()), "{message}");
        assert_eq!(fs::read(file_of(&dir)).unwrap(), before);
        assert_eq!(store.get(ID).unwrap().unwrap().expose(), "kept");
    }

    /// The ceiling tests `>` and not `>=`: exactly [`MAX_SECRET_BYTES`] is a secret like any other.
    #[test]
    fn exactly_the_ceiling_is_accepted_and_one_over_is_refused() {
        let (dir, store) = store("ceiling-bound");
        let at_ceiling = Secret::new("x".repeat(MAX_SECRET_BYTES));
        store.put("a", &at_ceiling).unwrap();
        assert_eq!(store.get("a").unwrap().unwrap().expose().len(), MAX_SECRET_BYTES);
        let before = fs::read(file_of(&dir)).unwrap();
        let error = store.put("b", &Secret::new("x".repeat(MAX_SECRET_BYTES + 1))).unwrap_err();
        let message = error.to_string();
        assert!(message.contains(&MAX_SECRET_BYTES.to_string()), "{message}");
        assert!(message.contains(&(MAX_SECRET_BYTES + 1).to_string()), "{message}");
        assert_eq!(fs::read(file_of(&dir)).unwrap(), before);
    }

    /// A rejected command writes nothing at all, so the stored data is untouched.
    #[test]
    fn every_rejected_command_leaves_the_file_byte_identical() {
        let (dir, store) = store("reject-identity");
        store.put(ID, &Secret::new("kept")).unwrap();
        let before = fs::read(file_of(&dir)).unwrap();
        let _ = store.put("a b", &Secret::new("v"));
        let _ = store.get("a b");
        let _ = store.delete("a b");
        let _ = store.put(ID, &Secret::new("y".repeat(MAX_SECRET_BYTES + 1)));
        assert_eq!(fs::read(file_of(&dir)).unwrap(), before);
        assert_eq!(store.get(ID).unwrap().unwrap().expose(), "kept");
    }

    /// Every write re-reads the file, so a write must never drop the ids that were already there.
    #[test]
    fn a_write_keeps_the_ids_that_were_already_there() {
        let (_dir, store) = store("keep");
        store.put("a", &Secret::new("1")).unwrap();
        store.put("b", &Secret::new("2")).unwrap();
        store.put("a", &Secret::new("1b")).unwrap();
        assert_eq!(store.list_ids().unwrap(), vec!["a".to_owned(), "b".to_owned()]);
        assert!(store.delete("b").unwrap());
        assert!(!store.delete("b").unwrap());
        assert_eq!(store.list_ids().unwrap(), vec!["a".to_owned()]);
        assert_eq!(store.get("a").unwrap().unwrap().expose(), "1b");
    }

    /// A second store on the same directory — the shape a restart takes.
    #[test]
    fn a_second_store_sees_what_the_first_wrote() {
        let (dir, store) = store("restart");
        store.put("connector/x/signin", &Secret::new("token-1")).unwrap();
        drop(store);
        let reopened = DpapiStore::with_dir(&dir);
        assert_eq!(reopened.get("connector/x/signin").unwrap().unwrap().expose(), "token-1");
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let (dir, store) = store("leftovers");
        store.put("a", &Secret::new("1")).unwrap();
        store.delete("a").unwrap();
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_owned()], "{names:?}");
    }

    #[test]
    fn the_store_shows_its_file_and_never_a_secret() {
        let (_dir, store) = store("debug");
        store.put("a", &Secret::new("hunter2-very-secret")).unwrap();
        let shown = format!("{store:?}");
        assert!(shown.contains(FILE_NAME), "{shown}");
        assert!(!shown.contains("hunter2"), "{shown}");
    }

    /// The path resolution is a pure function over an injected value, so it is testable without a
    /// real profile, the way the port decides platform questions elsewhere.
    #[test]
    fn the_path_comes_from_the_environment_and_names_what_is_missing() {
        let missing = secrets_file(None).unwrap_err();
        assert!(missing.to_string().contains("LOCALAPPDATA"), "{missing}");
        assert!(secrets_file(Some("   ")).is_err(), "an empty value is not a directory");
        let file = secrets_file(Some(r"C:\Users\someone\AppData\Local")).unwrap();
        let shown = file.to_string_lossy().into_owned();
        assert!(shown.starts_with(r"C:\Users\someone\AppData\Local"), "{shown}");
        assert!(shown.ends_with(r"Gentle Dot\secrets.dat"), "{shown}");
    }

    /// The real store, across two processes: run the writer, then the reader, each by hand. Left
    /// ignored because it writes into the user's own `%LOCALAPPDATA%`.
    const ROUND_TRIP: &str = "w10/round-trip";

    #[test]
    #[ignore = "writes into the real %LOCALAPPDATA%; run it, then the reader, by hand"]
    fn the_real_store_writes_a_round_trip_secret() {
        let store = DpapiStore::new();
        store.put(ROUND_TRIP, &Secret::new("w10-round-trip-value")).unwrap();
        assert_eq!(store.get(ROUND_TRIP).unwrap().unwrap().expose(), "w10-round-trip-value");
        eprintln!("wrote {ROUND_TRIP} for this user");
    }

    #[test]
    #[ignore = "reads what the writer left, in a second process, and removes it"]
    fn the_real_store_reads_it_back_in_a_second_process() {
        let store = DpapiStore::new();
        assert_eq!(store.get(ROUND_TRIP).unwrap().unwrap().expose(), "w10-round-trip-value");
        assert!(store.delete(ROUND_TRIP).unwrap());
        assert!(store.get(ROUND_TRIP).unwrap().is_none());
        eprintln!("read {ROUND_TRIP} back in a second process and removed it");
    }
}
