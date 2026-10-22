//! Generic credentials in the current Windows logon's Credential Manager.
//! No plaintext secret file; only names in this app's service namespace are enumerated.
use super::{check_id, Secret, SecretStore, StoreError, SERVICE};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_ACCESS_DENIED, ERROR_NOT_FOUND};
use windows_sys::Win32::Security::Credentials::*;

#[derive(Debug, Default)]
pub struct CredentialStore;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn target(id: &str) -> Result<Vec<u16>, StoreError> {
    check_id(id)?;
    Ok(wide(&format!("{SERVICE}/{id}")))
}
fn failure(code: u32) -> StoreError {
    if code == ERROR_ACCESS_DENIED {
        StoreError::Denied
    } else {
        StoreError::Unavailable(format!("Windows Credential Manager error {code}"))
    }
}

impl SecretStore for CredentialStore {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        let mut name = target(id)?;
        let bytes = secret.expose().as_bytes();
        if bytes.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err(StoreError::Failed("credential exceeds the Windows storage limit".into()));
        }
        let mut value: CREDENTIALW = unsafe { std::mem::zeroed() };
        value.Type = CRED_TYPE_GENERIC;
        value.TargetName = name.as_mut_ptr();
        value.CredentialBlobSize = bytes.len() as u32;
        value.CredentialBlob = bytes.as_ptr().cast_mut();
        value.Persist = CRED_PERSIST_LOCAL_MACHINE;
        // SAFETY: all buffers remain live for this synchronous API; nothing is logged.
        if unsafe { CredWriteW(&value, 0) } == 0 {
            return Err(failure(unsafe { GetLastError() }));
        }
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        let name = target(id)?;
        let mut raw = std::ptr::null_mut();
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            let code = unsafe { GetLastError() };
            return if code == ERROR_NOT_FOUND { Ok(None) } else { Err(failure(code)) };
        }
        // SAFETY: CredReadW returns one allocated credential; copy before freeing it.
        let bytes = unsafe {
            let value = &*raw;
            if value.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize).to_vec()
            }
        };
        unsafe {
            CredFree(raw.cast());
        }
        String::from_utf8(bytes).map(|text| Some(Secret::new(text))).map_err(|error| {
            super::wipe(&mut error.into_bytes());
            StoreError::NotText
        })
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        let name = target(id)?;
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
            return Ok(true);
        }
        let code = unsafe { GetLastError() };
        if code == ERROR_NOT_FOUND {
            Ok(false)
        } else {
            Err(failure(code))
        }
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let prefix = format!("{SERVICE}/");
        let filter = wide(&format!("{prefix}*"));
        let mut count = 0;
        let mut raw = std::ptr::null_mut();
        if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut raw) } == 0 {
            let code = unsafe { GetLastError() };
            return if code == ERROR_NOT_FOUND { Ok(Vec::new()) } else { Err(failure(code)) };
        }
        let mut ids = Vec::new();
        for value in unsafe { std::slice::from_raw_parts(raw, count as usize) } {
            let name = unsafe { (**value).TargetName };
            let mut len = 0;
            while unsafe { *name.add(len) } != 0 {
                len += 1;
            }
            if let Ok(name) = String::from_utf16(unsafe { std::slice::from_raw_parts(name, len) }) {
                if let Some(id) = name.strip_prefix(&prefix).filter(|id| check_id(id).is_ok()) {
                    ids.push(id.to_owned());
                }
            }
        }
        unsafe {
            CredFree(raw.cast());
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_manager_roundtrip_uses_only_a_unique_test_credential() {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let id = format!("windows-test/{}", nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = CredentialStore.delete(&self.0);
            }
        }
        let _cleanup = Cleanup(id.clone());
        let store = CredentialStore;
        assert!(store.get(&id).unwrap().is_none());
        store.put(&id, &Secret::new("native Windows UTF-8: café 東京")).unwrap();
        assert_eq!(store.get(&id).unwrap().unwrap().expose(), "native Windows UTF-8: café 東京");
        assert!(store.list_ids().unwrap().contains(&id));
        assert!(store.put(&id, &Secret::new("x".repeat(2561))).is_err());
        assert_eq!(store.get(&id).unwrap().unwrap().expose(), "native Windows UTF-8: café 東京");
        assert!(store.delete(&id).unwrap());
        assert!(!store.delete(&id).unwrap());
    }
}
