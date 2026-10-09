//! An in-memory [`SecretStore`] for tests (and for callers' tests in T23c).

use super::{check_id, Secret, SecretStore, StoreError};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct MemoryStore {
    secrets: Mutex<BTreeMap<String, Secret>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Shows the ids only.
impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let secrets = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        f.debug_struct("MemoryStore").field("ids", &secrets.keys().collect::<Vec<_>>()).finish()
    }
}

impl MemoryStore {
    fn secrets(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Secret>> {
        self.secrets.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretStore for MemoryStore {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        self.secrets().insert(id.to_owned(), Secret::new(secret.expose()));
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        Ok(self.secrets().get(id).map(|secret| Secret::new(secret.expose())))
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        Ok(self.secrets().remove(id).is_some())
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        Ok(self.secrets().keys().cloned().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_memory_store_keeps_the_contract() {
        super::super::check_contract(&MemoryStore::new());
    }

    #[test]
    fn the_memory_store_shows_ids_but_not_secrets() {
        let store = MemoryStore::new();
        store.put("slack/bot", &Secret::new("xoxb-secret-value")).unwrap();
        let shown = format!("{store:?}");
        assert!(shown.contains("slack/bot"), "{shown}");
        assert!(!shown.contains("xoxb"), "{shown}");
    }
}
