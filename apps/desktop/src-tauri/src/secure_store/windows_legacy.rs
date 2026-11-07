//! Strict, portable parser for the retained legacy ciphertext snapshot. No filesystem I/O.
//! Errors never include JSON, IDs, ciphertext, or decrypted values.
use super::{check_id, StoreError};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::de::{DeserializeSeed, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

pub(super) const MAX_SECRET_BYTES: usize = 1024 * 1024;
pub(super) const MAX_LEGACY_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_LEGACY_ENTRIES: usize = 256;
pub(super) const MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY: usize = 2 * 1024 * 1024;
pub(super) const MAX_LEGACY_CIPHERTEXT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_LEGACY_PLAINTEXT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const RECEIPT_NAME: &str = "migration-v1.receipt";
pub(super) const RECEIPT_ID: &str = "completion";

pub(super) fn invalid() -> StoreError {
    StoreError::Failed("invalid legacy Windows secret migration".into())
}

pub(super) fn plaintext_remaining(remaining: usize, length: usize) -> Result<usize, StoreError> {
    if remaining > MAX_LEGACY_PLAINTEXT_BYTES || length > MAX_SECRET_BYTES { return Err(invalid()); }
    remaining.checked_sub(length).ok_or_else(invalid)
}

pub(super) fn encoded_limit(decoded: usize) -> Result<usize, StoreError> {
    decoded.checked_add(2).and_then(|n| n.checked_div(3))
        .and_then(|n| n.checked_mul(4)).ok_or_else(invalid)
}

// Validate canonical padded base64 and its EXACT decoded length without decoding
// or allocating a ciphertext buffer. All entries pass this before any decode.
fn decoded_length(encoded: &str) -> Result<usize, StoreError> {
    let bytes = encoded.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0
        || bytes.len() > encoded_limit(MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY)? { return Err(invalid()); }
    let padding = if bytes.ends_with(b"==") { 2 } else if bytes.ends_with(b"=") { 1 } else { 0 };
    let data = &bytes[..bytes.len() - padding];
    let sextet = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'), b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52), b'+' => Some(62), b'/' => Some(63), _ => None,
        }
    };
    if data.iter().any(|b| sextet(*b).is_none()) { return Err(invalid()); }
    let last = sextet(*data.last().ok_or_else(invalid)?).ok_or_else(invalid)?;
    if (padding == 2 && last & 15 != 0) || (padding == 1 && last & 3 != 0) { return Err(invalid()); }
    let length = bytes.len().checked_div(4).and_then(|n| n.checked_mul(3))
        .and_then(|n| n.checked_sub(padding)).ok_or_else(invalid)?;
    if length == 0 || length > MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY { return Err(invalid()); }
    Ok(length)
}

// Bound strings before their owned copies. serde_json's escape scratch is also
// bounded by the 16 MiB input admission limit; retained IDs/values are much smaller.
struct BoundedText(usize);
impl<'de> DeserializeSeed<'de> for BoundedText {
    type Value = String;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<String, D::Error> {
        impl<'de> Visitor<'de> for BoundedText {
            type Value = String;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("bounded legacy text") }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<String, E> {
                if text.len() > self.0 { return Err(E::custom("invalid legacy entries")); }
                let mut owned = String::new();
                owned.try_reserve_exact(text.len()).map_err(|_| E::custom("invalid legacy entries"))?;
                owned.push_str(text);
                Ok(owned)
            }
        }
        d.deserialize_str(self)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    #[serde(deserialize_with = "unique_entries")]
    secrets: Vec<(String, String, usize)>,
}
fn unique_entries<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<(String, String, usize)>, D::Error> {
    struct Entries;
    impl<'de> Visitor<'de> for Entries {
        type Value = Vec<(String, String, usize)>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("bounded unique legacy entries") }
        fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let error = || <M::Error as serde::de::Error>::custom("invalid legacy entries");
            let mut entries: Self::Value = Vec::new();
            let mut total = 0usize;
            while let Some(id) = map.next_key_seed(BoundedText(super::MAX_ID_LEN))? {
                let count = entries.len().checked_add(1).ok_or_else(error)?;
                if count > MAX_LEGACY_ENTRIES || check_id(&id).is_err()
                    || entries.iter().any(|(old, _, _)| old == &id) { return Err(error()); }
                let remaining = MAX_LEGACY_CIPHERTEXT_BYTES.checked_sub(total).ok_or_else(error)?;
                let limit = encoded_limit(remaining.min(MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY)).map_err(|_| error())?;
                let value = map.next_value_seed(BoundedText(limit))?;
                let length = decoded_length(&value).map_err(|_| error())?;
                total = total.checked_add(length).filter(|n| *n <= MAX_LEGACY_CIPHERTEXT_BYTES).ok_or_else(error)?;
                entries.try_reserve_exact(1).map_err(|_| error())?;
                entries.push((id, value, length));
            }
            Ok(entries)
        }
    }
    d.deserialize_map(Entries)
}

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, StoreError> {
    if bytes.is_empty() || bytes.len() > MAX_LEGACY_SNAPSHOT_BYTES { return Err(invalid()); }
    let mut body: Body = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    body.secrets.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let mut entries = Vec::new();
    entries.try_reserve_exact(body.secrets.len()).map_err(|_| invalid())?;
    // Every encoded length, alphabet, count and aggregate passed preflight above.
    // Decode into exact pre-reserved buffers, not base64's allocating decode API.
    for (id, encoded, length) in body.secrets {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| invalid())?;
        bytes.resize(length, 0);
        let written = STANDARD.decode_slice(encoded.as_bytes(), &mut bytes).map_err(|_| invalid())?;
        if written != length { return Err(invalid()); }
        entries.push((id, bytes));
    }
    Ok(entries)
}

pub(super) fn snapshot(bytes: Option<&[u8]>) -> String {
    match bytes {
        None => "absent".into(),
        Some(bytes) => {
            let digest = Sha256::digest(bytes);
            let mut value = String::from("sha256:");
            for byte in digest { value.push_str(&format!("{byte:02x}")); }
            value
        }
    }
}
pub(super) fn receipt_service(service: &str) -> String {
    format!("{service}/windows-legacy-migration/v1")
}

// Exact grammar: the outer encrypted envelope binds schema/service/ID; its value
// binds the immutable ciphertext snapshot, including the distinct absent case.
pub(super) fn receipt(value: &str) -> Result<(bool, &str), StoreError> {
    let (complete, identity) = if let Some(identity) = value.strip_prefix("complete:") {
        (true, identity)
    } else if let Some(identity) = value.strip_prefix("pending:") {
        (false, identity)
    } else { return Err(invalid()); };
    let valid = identity == "absent" || identity.strip_prefix("sha256:").is_some_and(|hash|
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if !valid || (!complete && identity == "absent") { return Err(invalid()); }
    Ok((complete, identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_legacy_store_is_valid() {
        assert!(parse(br#"{"secrets":{}}"#).unwrap().is_empty());
    }
    #[test]
    fn strict_legacy_shape_ids_base64_and_duplicates() {
        let entries = parse(br#"{"secrets":{"token":"AQID","empty-value":"AA=="}}"#).unwrap();
        assert_eq!(entries.iter().find(|(id, _)| id == "token").unwrap().1, vec![1, 2, 3]);
        for bad in [
            r#"{}"#, r#"{"secrets":{},"unknown":0}"#,
            r#"{"secrets":{},"secrets":{}}"#,
            r#"{"secrets":{"a":"AA==","a":"AQ=="}}"#,
            r#"{"secrets":{"bad id":"AA=="}}"#,
            r#"{"secrets":{"a":"!"}}"#, r#"{"secrets":{"a":""}}"#,
            r#"{"secrets":{"a":null}}"#, r#"{"secrets":{}} trailing"#,
        ] { assert!(parse(bad.as_bytes()).is_err(), "{bad}"); }
        assert!(parse(&[0xff]).is_err());
        let too_long = format!(r#"{{"secrets":{{"{}":"AA=="}}}}"#, "a".repeat(super::super::MAX_ID_LEN + 1));
        assert!(parse(too_long.as_bytes()).is_err());
    }
    fn document(entries: &[(String, String)]) -> Vec<u8> {
        let entries: std::collections::BTreeMap<_, _> = entries.iter().cloned().collect();
        serde_json::to_vec(&serde_json::json!({"secrets": entries})).unwrap()
    }
    #[test]
    fn snapshot_and_count_admission_boundaries() {
        let mut bytes = document(&[("a".into(), "AA==".into())]);
        bytes.resize(MAX_LEGACY_SNAPSHOT_BYTES, b' ');
        assert!(parse(&bytes).is_ok());
        bytes.push(b' ');
        assert_eq!(parse(&bytes).unwrap_err(), invalid());
        assert!(parse(&[]).is_err());
        let mut entries: Vec<_> = (0..MAX_LEGACY_ENTRIES)
            .map(|i| (format!("id-{i}"), "AA==".to_owned())).collect();
        assert_eq!(parse(&document(&entries)).unwrap().len(), MAX_LEGACY_ENTRIES);
        entries.push(("too-many".into(), "AA==".into()));
        assert_eq!(parse(&document(&entries)).unwrap_err(), invalid());
    }
    #[test]
    fn ciphertext_encoded_decoded_and_aggregate_boundaries() {
        let at_limit = STANDARD.encode(vec![0; MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY]);
        assert_eq!(at_limit.len(), encoded_limit(MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY).unwrap());
        assert_eq!(decoded_length(&at_limit).unwrap(), MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY);
        let entries: Vec<_> = (0..4).map(|i| (format!("id-{i}"), at_limit.clone())).collect();
        let decoded = parse(&document(&entries)).unwrap();
        assert_eq!(decoded.iter().map(|(_, b)| b.len()).sum::<usize>(), MAX_LEGACY_CIPHERTEXT_BYTES);
        drop(decoded);
        let mut overflow = entries;
        overflow.push(("overflow".into(), "AA==".into()));
        assert_eq!(parse(&document(&overflow)).unwrap_err(), invalid());
        let over = STANDARD.encode(vec![0; MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY + 1]);
        // The padded encoded length can be identical while decoded bytes exceed
        // the cap: admission must use the exact decoded length, not an estimate.
        assert!(decoded_length(&over).is_err());
        assert!(parse(&document(&[("a".into(), over)])).is_err());
        for invalid_text in ["AB==", "AAB=", "AA=A", "====", "AAA", "AA==\n", "!!!!"] {
            assert!(parse(&document(&[("a".into(), invalid_text.into())])).is_err());
        }
        let mut too_long = at_limit;
        too_long.push_str("AAAA");
        assert!(decoded_length(&too_long).is_err());
        assert!(encoded_limit(usize::MAX).is_err());
    }
    #[test]
    fn plaintext_budget_checks_per_entry_and_aggregate_before_copy() {
        let mut remaining = MAX_LEGACY_PLAINTEXT_BYTES;
        for _ in 0..8 { remaining = plaintext_remaining(remaining, MAX_SECRET_BYTES).unwrap(); }
        assert_eq!(remaining, 0);
        assert_eq!(plaintext_remaining(remaining, 0).unwrap(), 0);
        assert!(plaintext_remaining(remaining, 1).is_err());
        assert!(plaintext_remaining(MAX_LEGACY_PLAINTEXT_BYTES, MAX_SECRET_BYTES + 1).is_err());
        assert!(plaintext_remaining(MAX_SECRET_BYTES - 1, MAX_SECRET_BYTES).is_err());
        assert!(plaintext_remaining(usize::MAX, 0).is_err());
    }
    #[test]
    fn snapshot_and_receipt_grammar_are_exact() {
        assert_ne!(snapshot(None), snapshot(Some(b"")));
        assert_ne!(snapshot(Some(b"a")), snapshot(Some(b"b")));
        let identity = snapshot(Some(b"synthetic"));
        assert_eq!(receipt(&format!("pending:{identity}")).unwrap(), (false, identity.as_str()));
        assert_eq!(receipt(&format!("complete:{identity}")).unwrap(), (true, identity.as_str()));
        assert_eq!(receipt("complete:absent").unwrap(), (true, "absent"));
        for bad in ["pending:absent", "complete:", "complete:sha256:00", "v2:absent", "complete:absent\n"] {
            assert!(receipt(bad).is_err());
        }
        assert!(receipt(&format!("complete:sha256:{}", "A".repeat(64))).is_err());
    }
}
