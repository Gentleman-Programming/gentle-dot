//! Connector secrets in the Secret Service (S25.7), over D-Bus: GNOME Keyring on Debian and
//! Ubuntu, KWallet or GNOME Keyring elsewhere. Items carry the attributes `service` =
//! [`SERVICE`](super::SERVICE) and `account` = the secret id.
//!
//! Documented limit (S25.7): the Secret Service has no per-caller access list, so any process of
//! the same user can read items while the collection is unlocked (usually the whole session).
//! Items are encrypted at rest. The session uses the plain transfer (the secret crosses the
//! local session bus unencrypted), since every same-user process can read it anyway.
//!
//! Not compiled on the macOS development machine (no Linux target installed); T23g verifies it
//! in a Linux container.

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use dbus_secret_service::{EncryptionType, Error, Item, SecretService};
use std::collections::HashMap;

pub struct SecretServiceStore {
    service: String,
}

impl SecretServiceStore {
    pub fn new() -> Self {
        Self::with_service(SERVICE)
    }

    pub fn with_service(service: impl Into<String>) -> Self {
        SecretServiceStore { service: service.into() }
    }

    fn connect() -> Result<SecretService, StoreError> {
        SecretService::connect(EncryptionType::Plain).map_err(store_error)
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

fn store_error(error: Error) -> StoreError {
    match error {
        Error::Locked | Error::Prompt => StoreError::Denied,
        Error::Unavailable => StoreError::Unavailable("no Secret Service on the session bus".into()),
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
        let ss = Self::connect()?;
        let collection = ss.get_default_collection().map_err(store_error)?;
        collection.ensure_unlocked().map_err(store_error)?;
        let label = format!("Gentle Dot connector: {id}");
        collection
            .create_item(&label, self.attributes(id), secret.expose().as_bytes(), true, "text/plain")
            .map_err(store_error)?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let ss = Self::connect()?;
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
        let ss = Self::connect()?;
        let items = matching(&ss, self.attributes(id))?;
        for item in &items {
            item.delete().map_err(store_error)?;
        }
        Ok(!items.is_empty())
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let ss = Self::connect()?;
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
