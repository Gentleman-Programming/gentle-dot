//! Connector secrets in the OS secure store (S25.5, S25.7): OAuth tokens, bot tokens, client
//! secrets, and imported headers, keyed by a connector secret id. The app owns the store; the
//! daemon gets a secret in memory over the app channel (`secret_get`, `secret_put`,
//! `secret_delete`, `secret_list` in `app_channel`, T23d), never from a file.
//!
//! - macOS (`Keychain`): generic password items in the login keychain, service
//!   [`SERVICE`], account = the secret id, created by the app process. See `macos.rs` for how
//!   the items' access list follows the app's code signature.
//! - Linux (`SecretServiceStore`): the Secret Service over D-Bus (GNOME Keyring, KWallet).
//!   Items are encrypted at rest, but any same-user process can read unlocked items (S25.7).
//! - `MemoryStore`: an in-memory store for tests.
//!
//! Secrets are never logged: [`Secret`] and every store redact themselves in `Debug`, have no
//! `Display`, and errors never carry a secret.

mod memory;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

pub use memory::MemoryStore;
#[cfg(target_os = "linux")]
pub use linux::SecretServiceStore;
#[cfg(target_os = "macos")]
pub use macos::Keychain;

/// The keychain service (macOS) or `service` attribute (Linux) of every connector secret.
pub const SERVICE: &str = "dev.gentleman.gentle-dot.connectors";
/// The longest secret id, in bytes.
pub const MAX_ID_LEN: usize = 200;

/// A secret value. Redacted in `Debug`, no `Display`, and its bytes are overwritten on drop
/// (best effort: copies made by the OS or by callers are out of reach).
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    /// The value, for handing it to the daemon. Never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut std::mem::take(&mut self.0).into_bytes());
    }
}

/// Overwrites a buffer with zeros in a way the compiler does not drop as a dead store.
pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid, aligned, exclusive reference.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// Why a store call failed. Never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The id is empty, too long, or has characters outside `[A-Za-z0-9._:@/-]`.
    InvalidId,
    /// The stored value is not UTF-8 text.
    NotText,
    /// The user or the system refused access (a declined keychain prompt, a locked item).
    Denied,
    /// The store cannot be reached (no Secret Service, a locked keychain that cannot ask).
    Unavailable(String),
    /// Anything else, with the store's own message.
    Failed(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::InvalidId => write!(f, "invalid secret id"),
            StoreError::NotText => write!(f, "the stored secret is not text"),
            StoreError::Denied => write!(f, "access to the secret store was denied"),
            StoreError::Unavailable(why) => write!(f, "the secret store is unavailable: {why}"),
            StoreError::Failed(why) => write!(f, "the secret store failed: {why}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Where connector secrets live.
pub trait SecretStore: Send + Sync {
    /// Stores the secret under `id`, replacing any previous one.
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError>;
    /// The secret under `id`, or `None` when there is none.
    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError>;
    /// Removes the secret under `id`; true when one was there.
    fn delete(&self, id: &str) -> Result<bool, StoreError>;
    /// Every id in this store, sorted, without duplicates.
    fn list_ids(&self) -> Result<Vec<String>, StoreError>;
}

/// The store the app serves connector secrets from: the login keychain on macOS, the Secret
/// Service on Linux. Nothing is touched until the first request.
pub fn connector_store() -> Box<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    return Box::new(Keychain::new());
    #[cfg(target_os = "linux")]
    return Box::new(SecretServiceStore::new());
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Box::new(MemoryStore::new());
}

/// Accepts 1 to [`MAX_ID_LEN`] bytes of `[A-Za-z0-9._:@/-]`.
pub fn check_id(id: &str) -> Result<(), StoreError> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._:@/-".contains(c);
    if id.is_empty() || id.len() > MAX_ID_LEN || !id.chars().all(allowed) {
        return Err(StoreError::InvalidId);
    }
    Ok(())
}

/// The contract every store keeps, run against `MemoryStore` here and against a throwaway
/// keychain service in the ignored macOS test.
#[cfg(test)]
pub(crate) fn check_contract(store: &dyn SecretStore) {
    assert!(store.get("contract/missing").unwrap().is_none());
    assert!(!store.delete("contract/missing").unwrap());

    store.put("contract/b", &Secret::new("first")).unwrap();
    store.put("contract/a", &Secret::new("xoxb-123")).unwrap();
    assert_eq!(store.get("contract/a").unwrap().unwrap().expose(), "xoxb-123");
    store.put("contract/a", &Secret::new("replaced ✓")).unwrap();
    assert_eq!(store.get("contract/a").unwrap().unwrap().expose(), "replaced ✓");
    store.put("contract/empty", &Secret::new("")).unwrap();
    assert_eq!(store.get("contract/empty").unwrap().unwrap().expose(), "");

    let ids = store.list_ids().unwrap();
    assert_eq!(ids, vec!["contract/a", "contract/b", "contract/empty"]);

    assert!(store.delete("contract/a").unwrap());
    assert!(!store.delete("contract/a").unwrap());
    assert!(store.get("contract/a").unwrap().is_none());
    assert!(store.delete("contract/b").unwrap());
    assert!(store.delete("contract/empty").unwrap());
    assert!(store.list_ids().unwrap().is_empty());

    for bad in ["", "has space", "new\nline", "tab\t", "ünicode", &"x".repeat(MAX_ID_LEN + 1)] {
        assert_eq!(store.put(bad, &Secret::new("s")).unwrap_err(), StoreError::InvalidId, "{bad:?}");
        assert_eq!(store.get(bad).unwrap_err(), StoreError::InvalidId, "{bad:?}");
        assert_eq!(store.delete(bad).unwrap_err(), StoreError::InvalidId, "{bad:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_allow_a_small_safe_alphabet() {
        for good in ["notion", "slack/bot-token", "gmail:client_secret", "a.b@c", &"x".repeat(MAX_ID_LEN)] {
            assert_eq!(check_id(good), Ok(()), "{good:?}");
        }
        for bad in ["", " ", "a b", "a\u{0}b", "a\nb", "ñ", "a\u{202e}b", &"x".repeat(MAX_ID_LEN + 1)] {
            assert_eq!(check_id(bad), Err(StoreError::InvalidId), "{bad:?}");
        }
    }

    #[test]
    fn a_secret_never_shows_in_debug() {
        let secret = Secret::new("hunter2-very-secret");
        let shown = format!("{secret:?} {secret:#?}");
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("redacted"), "{shown}");
        let some = Some(Secret::new("hunter2"));
        assert!(!format!("{some:?}").contains("hunter2"));
    }

    #[test]
    fn errors_say_what_failed_without_a_secret() {
        assert_eq!(StoreError::Denied.to_string(), "access to the secret store was denied");
        assert_eq!(StoreError::InvalidId.to_string(), "invalid secret id");
    }

    #[test]
    fn wipe_zeroes_the_buffer() {
        let mut bytes = b"token".to_vec();
        wipe(&mut bytes);
        assert_eq!(bytes, vec![0; 5]);
    }
}
