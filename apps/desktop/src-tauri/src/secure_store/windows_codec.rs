//! Plaintext envelope codec for the Windows DPAPI backend; this module does not encrypt.
//! The caller must wipe encoded bytes on every path and validate the decoded ID against
//! the requested ID and hashed filename. Errors contain only fixed, non-sensitive text.

use super::{check_id, Secret, StoreError};
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 8] = b"GDSEC\0\x01\0";
const HEADER_LEN: usize = MAGIC.len() + 12;
const NAME_DOMAIN: &[u8] = b"gentle-dot/windows-secret-filename/v1\0";

fn malformed() -> StoreError {
    StoreError::Failed("invalid Windows secret envelope".to_owned())
}

fn allocation_error() -> StoreError {
    StoreError::Failed("Windows secret buffer allocation failed".to_owned())
}

fn check_service(service: &str) -> Result<(), StoreError> {
    if service.is_empty() || service.contains('\0') {
        return Err(StoreError::Failed("invalid Windows secret service".to_owned()));
    }
    length(service.len())?;
    Ok(())
}

fn length(len: usize) -> Result<u32, StoreError> {
    u32::try_from(len).map_err(|_| malformed())
}

// DPAPI's input count is a DWORD. Include the entire envelope, not just the value.
fn envelope_len(service: usize, id: usize, value: usize) -> Result<usize, StoreError> {
    length(service)?;
    length(id)?;
    length(value)?;
    let total = HEADER_LEN.checked_add(service)
        .and_then(|n| n.checked_add(id))
        .and_then(|n| n.checked_add(value))
        .ok_or_else(malformed)?;
    length(total)?;
    Ok(total)
}

pub(super) fn filename(service: &str, id: &str) -> Result<String, StoreError> {
    check_id(id)?;
    check_service(service)?;
    let mut hash = Sha256::new();
    hash.update(NAME_DOMAIN);
    hash.update(length(service.len())?.to_le_bytes());
    hash.update(service.as_bytes());
    hash.update(length(id.len())?.to_le_bytes());
    hash.update(id.as_bytes());
    let digest = hash.finalize();
    let mut name = String::new();
    name.try_reserve_exact(68).map_err(|_| allocation_error())?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        name.push(HEX[(byte >> 4) as usize] as char);
        name.push(HEX[(byte & 15) as usize] as char);
    }
    name.push_str(".bin");
    Ok(name)
}

pub(super) fn encode(service: &str, id: &str, value: &Secret) -> Result<Vec<u8>, StoreError> {
    check_id(id)?;
    check_service(service)?;
    let value = value.expose().as_bytes();
    let total = envelope_len(service.len(), id.len(), value.len())?;
    let lengths = [length(service.len())?, length(id.len())?, length(value.len())?];
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(total).map_err(|_| allocation_error())?;
    bytes.extend_from_slice(MAGIC);
    for len in lengths {
        bytes.extend_from_slice(&len.to_le_bytes());
    }
    bytes.extend_from_slice(service.as_bytes());
    bytes.extend_from_slice(id.as_bytes());
    bytes.extend_from_slice(value);
    Ok(bytes)
}

fn take<'a>(bytes: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], StoreError> {
    let end = offset.checked_add(len).ok_or_else(malformed)?;
    let part = bytes.get(*offset..end).ok_or_else(malformed)?;
    *offset = end;
    Ok(part)
}

fn read_length(bytes: &[u8], offset: &mut usize) -> Result<usize, StoreError> {
    let mut field = [0; 4];
    field.copy_from_slice(take(bytes, offset, 4)?);
    usize::try_from(u32::from_le_bytes(field)).map_err(|_| malformed())
}

pub(super) fn decode(service: &str, bytes: &[u8]) -> Result<(String, Secret), StoreError> {
    check_service(service)?;
    length(bytes.len())?;
    let mut offset = 0;
    if take(bytes, &mut offset, MAGIC.len())? != MAGIC {
        return Err(malformed());
    }
    let service_len = read_length(bytes, &mut offset)?;
    let id_len = read_length(bytes, &mut offset)?;
    let value_len = read_length(bytes, &mut offset)?;
    if envelope_len(service_len, id_len, value_len)? != bytes.len() {
        return Err(malformed());
    }
    let stored_service = std::str::from_utf8(take(bytes, &mut offset, service_len)?)
        .map_err(|_| malformed())?;
    check_service(stored_service)?;
    if stored_service != service {
        return Err(StoreError::Failed("Windows secret service mismatch".to_owned()));
    }
    let id = std::str::from_utf8(take(bytes, &mut offset, id_len)?)
        .map_err(|_| StoreError::InvalidId)?;
    check_id(id)?;
    let value = std::str::from_utf8(take(bytes, &mut offset, value_len)?)
        .map_err(|_| StoreError::NotText)?;
    if offset != bytes.len() {
        return Err(malformed());
    }
    // Validate the borrowed fields before allocating or copying any value bytes.
    let mut owned_id = String::new();
    owned_id.try_reserve_exact(id.len()).map_err(|_| allocation_error())?;
    owned_id.push_str(id);
    let mut owned_value = String::new();
    owned_value.try_reserve_exact(value.len()).map_err(|_| allocation_error())?;
    owned_value.push_str(value);
    Ok((owned_id, Secret::new(owned_value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE: &str = "synthetic.codec.service";

    fn frame(service: &[u8], id: &[u8], value: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        for len in [service.len(), id.len(), value.len()] {
            bytes.extend_from_slice(&(len as u32).to_le_bytes());
        }
        bytes.extend_from_slice(service);
        bytes.extend_from_slice(id);
        bytes.extend_from_slice(value);
        bytes
    }

    #[test]
    fn roundtrip_unicode_empty_and_large_synthetic_values() {
        for value in [String::new(), "synthetic ✓ 🦀".to_owned(), "x".repeat(8192)] {
            let bytes = encode(SERVICE, "test/token", &Secret::new(value.clone())).unwrap();
            assert_eq!(bytes, frame(SERVICE.as_bytes(), b"test/token", value.as_bytes()));
            let (id, secret) = decode(SERVICE, &bytes).unwrap();
            assert_eq!(id, "test/token");
            assert_eq!(secret.expose(), value);
        }
        let id = "x".repeat(super::super::MAX_ID_LEN);
        let bytes = encode("synthetic.服务", &id, &Secret::new("synthetic")).unwrap();
        assert_eq!(decode("synthetic.服务", &bytes).unwrap().0, id);
    }

    #[test]
    fn rejects_missing_truncated_unknown_and_trailing_bytes() {
        let bytes = encode(SERVICE, "test/token", &Secret::new("synthetic")).unwrap();
        for end in 0..bytes.len() {
            assert!(decode(SERVICE, &bytes[..end]).is_err());
        }
        let mut unknown = bytes.clone();
        unknown[0] ^= 1;
        assert!(decode(SERVICE, &unknown).is_err());
        let mut trailing = bytes;
        trailing.push(0);
        assert!(decode(SERVICE, &trailing).is_err());
    }

    #[test]
    fn rejects_overflowing_lengths_without_large_allocations() {
        let mut bytes = frame(SERVICE.as_bytes(), b"id", b"value");
        for offset in [MAGIC.len(), MAGIC.len() + 4, MAGIC.len() + 8] {
            bytes[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(decode(SERVICE, &bytes).is_err());
            bytes = frame(SERVICE.as_bytes(), b"id", b"value");
        }
        assert!(envelope_len(usize::MAX, 1, 1).is_err());
        assert!(envelope_len(u32::MAX as usize, 1, 1).is_err());
        assert!(envelope_len(1, 1, u32::MAX as usize).is_err());
        assert_eq!(envelope_len(1, 1, 8192).unwrap(), HEADER_LEN + 8194);
    }

    #[test]
    fn service_binding_and_value_text_are_checked() {
        let bytes = frame(SERVICE.as_bytes(), b"id", b"synthetic");
        assert!(decode("other.service", &bytes).is_err());
        assert_eq!(decode(SERVICE, &frame(SERVICE.as_bytes(), b"id", &[0xff])).unwrap_err(), StoreError::NotText);
        assert!(decode(SERVICE, &frame(&[0xff], b"id", b"synthetic")).is_err());
        for bad in ["", "service\0name"] {
            assert!(filename(bad, "id").is_err());
            assert!(encode(bad, "id", &Secret::new("synthetic")).is_err());
            assert!(decode(bad, &bytes).is_err());
            assert!(decode(SERVICE, &frame(bad.as_bytes(), b"id", b"synthetic")).is_err());
        }
    }

    #[test]
    fn filenames_are_opaque_lower_hex_and_case_distinct() {
        let name = filename(SERVICE, "test/token").unwrap();
        assert_eq!(name.len(), 68);
        assert!(name.ends_with(".bin"));
        assert!(name[..64].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert!(!name.contains("test/token"));
        assert_eq!(name, filename(SERVICE, "test/token").unwrap());
        assert_ne!(filename(SERVICE, "ID").unwrap().to_lowercase(), filename(SERVICE, "id").unwrap().to_lowercase());
        assert_ne!(filename("ab", "c").unwrap(), filename("a", "bc").unwrap());
        assert_ne!(filename("other.service", "id").unwrap(), filename(SERVICE, "id").unwrap());
    }

    #[test]
    fn rejects_invalid_ids_in_every_entry_point() {
        for id in ["", "with space", "\0", "ñ", &"x".repeat(super::super::MAX_ID_LEN + 1)] {
            assert_eq!(filename(SERVICE, id).unwrap_err(), StoreError::InvalidId);
            assert_eq!(encode(SERVICE, id, &Secret::new("synthetic")).unwrap_err(), StoreError::InvalidId);
            assert_eq!(decode(SERVICE, &frame(SERVICE.as_bytes(), id.as_bytes(), b"synthetic")).unwrap_err(), StoreError::InvalidId);
        }
        assert_eq!(decode(SERVICE, &frame(SERVICE.as_bytes(), &[0xff], b"synthetic")).unwrap_err(), StoreError::InvalidId);
    }

    #[test]
    fn errors_and_secret_debug_do_not_expose_payloads() {
        let marker = "synthetic-redaction-marker";
        let bytes = frame(marker.as_bytes(), b"id", marker.as_bytes());
        let errors = [
            decode(SERVICE, &bytes).unwrap_err(),
            decode(SERVICE, &frame(SERVICE.as_bytes(), marker.as_bytes(), &[0xff])).unwrap_err(),
            filename(SERVICE, "synthetic-redaction-marker invalid").unwrap_err(),
            encode("synthetic-redaction-marker\0", "id", &Secret::new(marker)).unwrap_err(),
        ];
        for error in errors {
            assert!(!format!("{error:?} {error}").contains(marker));
        }
        let (_, secret) = decode(SERVICE, &frame(SERVICE.as_bytes(), b"id", marker.as_bytes())).unwrap();
        assert!(!format!("{secret:?}").contains(marker));
    }
}
