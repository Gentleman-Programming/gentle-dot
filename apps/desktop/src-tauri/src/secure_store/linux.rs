//! Connector secrets in the Secret Service (S25.7), over D-Bus: GNOME Keyring on Debian and
//! Ubuntu, KWallet or GNOME Keyring elsewhere. Items carry the attributes `service` =
//! [`SERVICE`](super::SERVICE) and `account` = the secret id, in the default collection (the login
//! keyring).
//!
//! Documented limit (S25.7, docs/install.md): the Secret Service has no per-caller access list, so
//! any process of the same user can read items while the collection is unlocked (usually the whole
//! session). Items are encrypted at rest. The session uses the plain transfer (the secret crosses
//! the local session bus unencrypted), since every same-user process can read it anyway.
//!
//! Without a Secret Service (no session bus, or no provider on it) every call fails with
//! [`StoreError::Unavailable`] naming what is missing, so connectors that need a secret fail closed.
//! A locked collection asks the provider to show its unlock prompt and waits at most
//! [`PROMPT_TIMEOUT_SECS`]; dismissed or unanswered, the call is [`StoreError::Denied`].

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use dbus_secret_service::{EncryptionType, Error, Item, SecretService};
use std::collections::HashMap;

/// How long a call waits on the provider's unlock prompt, below the daemon's wait for an answer.
pub const PROMPT_TIMEOUT_SECS: u64 = 120;

pub struct SecretServiceStore {
    service: String,
    prompt_timeout: u64,
}

impl SecretServiceStore {
    pub fn new() -> Self {
        Self::with_service(SERVICE)
    }

    pub fn with_service(service: impl Into<String>) -> Self {
        SecretServiceStore { service: service.into(), prompt_timeout: PROMPT_TIMEOUT_SECS }
    }

    fn connect(&self) -> Result<SecretService, StoreError> {
        SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, self.prompt_timeout).map_err(|error| {
            StoreError::Unavailable(format!(
                "no Secret Service in this desktop session ({error}); install and unlock a keyring such as GNOME Keyring or KWallet"
            ))
        })
    }

    fn attributes<'a>(&'a self, id: &'a str) -> HashMap<&'a str, &'a str> {
        HashMap::from([("service", self.service.as_str()), ("account", id)])
    }
}

impl Default for SecretServiceStore {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for SecretServiceStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretServiceStore").field("service", &self.service).finish()
    }
}

/// D-Bus errors that mean the provider went away or never was there.
const GONE: [&str; 4] = [
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.NoServer",
    "org.freedesktop.DBus.Error.Disconnected",
];

fn store_error(error: Error) -> StoreError {
    match error {
        Error::Locked | Error::Prompt => StoreError::Denied,
        Error::Unavailable => StoreError::Unavailable("no Secret Service on the session bus".into()),
        Error::Dbus(ref dbus) if dbus.name().is_some_and(|name| GONE.contains(&name)) => {
            StoreError::Unavailable(format!("the Secret Service stopped answering ({error})"))
        }
        other => StoreError::Failed(other.to_string()),
    }
}

/// Every item matching the attributes, unlocked ones first.
fn matching<'a>(ss: &'a SecretService, attributes: HashMap<&str, &str>) -> Result<Vec<Item<'a>>, StoreError> {
    let found = ss.search_items(attributes).map_err(store_error)?;
    Ok(found.unlocked.into_iter().chain(found.locked).collect())
}

impl SecretStore for SecretServiceStore {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        let ss = self.connect()?;
        let collection = ss.get_default_collection().map_err(|error| match error {
            Error::NoResult => StoreError::Unavailable(
                "the Secret Service has no default keyring; create one (for example the login keyring in Passwords and Keys)".into(),
            ),
            other => store_error(other),
        })?;
        collection.ensure_unlocked().map_err(store_error)?;
        let label = format!("Gentle Dot connector: {id}");
        collection
            .create_item(&label, self.attributes(id), secret.expose().as_bytes(), true, "text/plain")
            .map_err(store_error)?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let ss = self.connect()?;
        let Some(item) = matching(&ss, self.attributes(id))?.into_iter().next() else {
            return Ok(None);
        };
        item.ensure_unlocked().map_err(store_error)?;
        let bytes = item.get_secret().map_err(store_error)?;
        match String::from_utf8(bytes) {
            Ok(text) => Ok(Some(Secret::new(text))),
            Err(error) => {
                wipe(&mut error.into_bytes());
                Err(StoreError::NotText)
            }
        }
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        let ss = self.connect()?;
        let items = matching(&ss, self.attributes(id))?;
        for item in &items {
            item.delete().map_err(store_error)?;
        }
        Ok(!items.is_empty())
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let ss = self.connect()?;
        let items = matching(&ss, HashMap::from([("service", self.service.as_str())]))?;
        let mut ids = Vec::new();
        for item in &items {
            if let Some(id) = item.get_attributes().map_err(store_error)?.remove("account") {
                ids.push(id);
            }
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn throwaway() -> SecretServiceStore {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        SecretServiceStore::with_service(format!("dev.gentleman.gentle-dot.test.{suffix}"))
    }

    #[test]
    fn the_store_shows_its_service_only() {
        assert_eq!(
            format!("{:?}", SecretServiceStore::new()),
            "SecretServiceStore { service: \"dev.gentleman.gentle-dot.connectors\" }"
        );
    }

    #[test]
    fn secret_service_errors_map_to_denied_unavailable_or_failed() {
        assert_eq!(store_error(Error::Locked), StoreError::Denied);
        assert_eq!(store_error(Error::Prompt), StoreError::Denied);
        assert!(matches!(store_error(Error::Unavailable), StoreError::Unavailable(_)));
        for gone in GONE {
            let error = Error::Dbus(dbus::Error::new_custom(gone, "the provider quit"));
            assert!(matches!(store_error(error), StoreError::Unavailable(_)), "{gone}");
        }
        let other = Error::Dbus(dbus::Error::new_custom("org.freedesktop.Secret.Error.NoSuchObject", "gone"));
        assert!(matches!(store_error(other), StoreError::Failed(_)));
    }

    /// Run by `docker/linux-package/cargo-check.sh` with no session bus, and with a bus that has no
    /// provider: every call fails closed, saying what is missing.
    #[test]
    #[ignore = "needs a session without a Secret Service"]
    fn without_a_secret_service_the_store_is_unavailable() {
        let store = throwaway();
        let errors = [
            store.put("connector/x/value/token", &Secret::new("s")).unwrap_err(),
            store.get("connector/x/value/token").unwrap_err(),
            store.delete("connector/x/value/token").unwrap_err(),
            store.list_ids().unwrap_err(),
        ];
        for error in errors {
            let StoreError::Unavailable(ref why) = error else { panic!("{error:?}") };
            assert!(why.starts_with("no Secret Service in this desktop session ("), "{why}");
            assert!(why.ends_with("install and unlock a keyring such as GNOME Keyring or KWallet"), "{why}");
        }
        // What the daemon gets back over the app channel when it asks for a connector's secret.
        let answer = crate::app_channel::serve_secret(&store, "secret_get", &serde_json::json!({"id": "connector/x/value/token"}));
        let refusal = answer.unwrap_err();
        assert!(refusal.starts_with("the secret store is unavailable: no Secret Service in this desktop session ("), "{refusal}");
        eprintln!("the app answers secret_get with: {refusal}");
    }

    /// Touches a real, unlocked Secret Service under a throwaway service and removes what it
    /// created; also shows the documented limit: another same-user client (`secret-tool`) reads the
    /// item with no prompt. Run by `docker/linux-package/cargo-check.sh` against GNOME Keyring.
    #[test]
    #[ignore = "uses the session's Secret Service"]
    fn real_secret_service_keeps_the_contract_under_a_throwaway_service() {
        let store = throwaway();
        let outcome = std::panic::catch_unwind(|| {
            super::super::check_contract(&store);
            store.put("limit/demo", &Secret::new("readable-by-the-same-user")).unwrap();
            match std::process::Command::new("secret-tool")
                .args(["lookup", "service", &store.service, "account", "limit/demo"])
                .output()
            {
                Ok(output) => assert_eq!(String::from_utf8_lossy(&output.stdout), "readable-by-the-same-user"),
                Err(error) => eprintln!("secret-tool not run ({error}); the same-user read is not shown"),
            }
        });
        // Leave nothing behind, whatever happened.
        for id in store.list_ids().unwrap_or_default() {
            let _ = store.delete(&id);
        }
        assert!(store.list_ids().unwrap().is_empty());
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    /// Run by `docker/linux-package/cargo-check.sh` against a locked GNOME Keyring with no way to
    /// show its unlock prompt: refused, within the prompt timeout.
    #[test]
    #[ignore = "needs a locked Secret Service"]
    fn a_locked_keyring_is_refused_without_waiting_on_a_prompt() {
        let mut store = throwaway();
        store.prompt_timeout = 3;
        let started = Instant::now();
        assert_eq!(store.put("connector/x/value/token", &Secret::new("s")).unwrap_err(), StoreError::Denied);
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    }
}
