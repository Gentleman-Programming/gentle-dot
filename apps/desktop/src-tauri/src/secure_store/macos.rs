//! Connector secrets in the macOS login keychain (S25.5).
//!
//! Each secret is a generic password item: service [`SERVICE`](super::SERVICE), account = the
//! secret id. Items live in the file-based login keychain (not the data protection keychain,
//! which needs a keychain-access-groups entitlement and a provisioning profile). There, the
//! item's access list trusts the application that created it, identified by its designated
//! requirement; any other process that asks for the data (the agent's `security` CLI, a script)
//! makes SecurityAgent ask the user, and computer control refuses to act on SecurityAgent
//! (S24.4). Attributes (service, account) are readable without a prompt, so ids are not secrets.
//!
//! How the access list follows the signature (S29.2):
//! - Stable self-signed identity ("Gentle Dot Local Signing", L85): the designated requirement
//!   is `identifier "dev.gentleman.gentle-dot" and certificate leaf = H"…"`, the same for every
//!   build signed with that certificate, so a new build reads the items without a prompt.
//! - Ad-hoc builds (`tauri dev`, unsigned debug builds, `cargo test` binaries): the designated
//!   requirement is the code hash, so each rebuild is a different application. Reading an item
//!   created by an earlier build asks the user ("Allow", "Always Allow", "Deny"); "Always Allow"
//!   adds that build to the item's access list.
//! - A signature change (a new certificate, a switch between ad-hoc and signed): the same
//!   prompt, once per item, asking for the login password; "Deny" reads as
//!   [`StoreError::Denied`], and the daemon fails closed. Deleting and storing the secret again
//!   from the new build makes it the owner.
//!
//! `put` deletes any existing item and adds a new one instead of updating in place, so the new
//! item's access list is the default one (only this app), even if another process created an
//! item under the same name first with a wider list. If an item reappears between the two
//! calls, `put` fails rather than write into it.
//!
//! What `get` can and cannot check (T23d, L110 advisory): whether an item was created by this
//! app is recorded only in its access list, and `security-framework` 3.7 has no binding to read
//! it (`SecKeychainItemCopyAccess`, `SecAccessCopyACLList`, `SecACLCopyContents`, and
//! `SecTrustedApplicationCopyData` are deprecated file-keychain calls the crate leaves out).
//! The attributes it can read (label, creator code, dates) are set by whoever adds the item, so
//! checking them would prove nothing. So `get` does not verify the item: a same-user process
//! could plant an item with an open access list before the first `put`, or delete one and plant
//! its own. The daemon narrows this: it only reads ids it recorded after its own `put` (the
//! `secretRef`s in `connectors.json`; T23e adds an HMAC to it), it never imports a sign-in file after
//! the one-time migration, and every `put` replaces whatever item was there. An item planted
//! with an access list that does not trust this app makes `get` ask the user through
//! SecurityAgent ("Deny" fails closed).

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use core_foundation::data::CFData;
use security_framework::base::Error;
use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, Limit, Location};
use security_framework::passwords::{delete_generic_password, generic_password, PasswordOptions};

const NOT_FOUND: i32 = -25300; // errSecItemNotFound
const DUPLICATE: i32 = -25299; // errSecDuplicateItem
const AUTH_FAILED: i32 = -25293; // errSecAuthFailed
const USER_CANCELED: i32 = -128; // errSecUserCanceled
const NO_INTERACTION: i32 = -25308; // errSecInteractionNotAllowed

/// The login keychain, under [`SERVICE`] (or another service, for tests).
pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new() -> Self {
        Self::with_service(SERVICE)
    }

    pub fn with_service(service: impl Into<String>) -> Self {
        Keychain { service: service.into() }
    }
}

impl Default for Keychain {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Keychain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keychain").field("service", &self.service).finish()
    }
}

fn store_error(error: Error) -> StoreError {
    match error.code() {
        USER_CANCELED | AUTH_FAILED => StoreError::Denied,
        NO_INTERACTION => StoreError::Unavailable("the keychain is locked and cannot ask".into()),
        code => StoreError::Failed(format!("{error} ({code})")),
    }
}

impl SecretStore for Keychain {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        self.delete(id)?;
        let mut options = ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: CFData::from_buffer(secret.expose().as_bytes()),
        });
        options
            .set_service(&self.service)
            .set_account_name(id)
            .set_label(format!("Gentle Dot connector: {id}"))
            .set_location(Location::DefaultFileKeychain);
        options.add().map_err(|error| match error.code() {
            DUPLICATE => StoreError::Failed("another item with this id appeared while storing it".into()),
            _ => store_error(error),
        })
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        match generic_password(PasswordOptions::new_generic_password(&self.service, id)) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => Ok(Some(Secret::new(text))),
                Err(error) => {
                    wipe(&mut error.into_bytes());
                    Err(StoreError::NotText)
                }
            },
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(store_error(error)),
        }
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        match delete_generic_password(&self.service, id) {
            Ok(()) => Ok(true),
            Err(error) if error.code() == NOT_FOUND => Ok(false),
            Err(error) => Err(store_error(error)),
        }
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(&self.service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        let results = match found {
            Ok(results) => results,
            Err(error) if error.code() == NOT_FOUND => return Ok(Vec::new()),
            Err(error) => return Err(store_error(error)),
        };
        let mut ids: Vec<String> = results
            .iter()
            .filter_map(|result| result.simplify_dict()?.remove("acct"))
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keychain_shows_its_service_only() {
        assert_eq!(format!("{:?}", Keychain::new()), "Keychain { service: \"dev.gentleman.gentle-dot.connectors\" }");
    }

    #[test]
    fn keychain_errors_map_to_denied_or_unavailable() {
        assert_eq!(store_error(Error::from_code(USER_CANCELED)), StoreError::Denied);
        assert_eq!(store_error(Error::from_code(AUTH_FAILED)), StoreError::Denied);
        assert!(matches!(store_error(Error::from_code(NO_INTERACTION)), StoreError::Unavailable(_)));
        assert!(matches!(store_error(Error::from_code(-50)), StoreError::Failed(_)));
    }

    /// Touches the real login keychain under a throwaway service and removes what it created.
    /// Run by hand: `cargo test real_keychain -- --ignored`.
    #[test]
    #[ignore = "uses the real login keychain"]
    fn real_keychain_keeps_the_contract_under_a_throwaway_service() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let store = Keychain::with_service(format!("dev.gentleman.gentle-dot.test.{suffix}"));
        let outcome = std::panic::catch_unwind(|| super::super::check_contract(&store));
        // Leave nothing behind, whatever happened.
        for id in store.list_ids().unwrap_or_default() {
            let _ = store.delete(&id);
        }
        assert!(store.list_ids().unwrap().is_empty());
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }
}
