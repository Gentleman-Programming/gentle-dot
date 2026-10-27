//! Windows launch encoding; the native owned-process adapter lands in later slices.

use std::io;

const DESCRIPTOR_COUNT: usize = 4;
const FOPEN: u8 = 1;
const FPIPE: u8 = 8;
const FDEV: u8 = 64;

/// CRT/libuv lpReserved2: native int count, count flag bytes, then packed native HANDLEs.
/// Handles are copied as bytes: the handle region is not necessarily aligned on 64-bit Windows.
/// The caller must retain this buffer until CreateProcessW returns; cbReserved2 is its u16 length.
/// Entries 0..2 are inherited NUL stdin and file-backed stdout/stderr; entry 3 is the
/// dedicated connected duplex pipe. Do not reuse this for pipe-backed standard streams.
/// This buffer does NOT constrain inheritance: an explicit STARTUPINFOEX handle list is required.
pub(super) fn fd3_bootstrap(handles: [usize; DESCRIPTOR_COUNT]) -> io::Result<Vec<u8>> {
    packed_bootstrap(&[FOPEN | FDEV, FOPEN, FOPEN, FOPEN | FPIPE], &handles)
}

fn packed_bootstrap(flags: &[u8], handles: &[usize]) -> io::Result<Vec<u8>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid descriptor bootstrap size");
    if flags.len() != handles.len() {
        return Err(invalid());
    }
    let count = i32::try_from(handles.len()).map_err(|_| invalid())?;
    let size = handles.len().checked_mul(std::mem::size_of::<usize>())
        .and_then(|n| n.checked_add(flags.len()))
        .and_then(|n| n.checked_add(std::mem::size_of::<i32>()))
        .ok_or_else(invalid)?;
    u16::try_from(size).map_err(|_| invalid())?;
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(&count.to_ne_bytes());
    bytes.extend_from_slice(flags);
    for handle in handles {
        bytes.extend_from_slice(&handle.to_ne_bytes());
    }
    Ok(bytes)
}

/// Always quote each argument using Windows CRT escaping, including empty arguments.
/// Reject embedded NUL rather than letting CreateProcessW silently truncate a command line.
/// The executable must also be passed separately as lpApplicationName, never shell-interpreted.
pub(super) fn command_line(program: &str, args: &[String]) -> io::Result<Vec<u16>> {
    let mut line = String::new();
    for arg in std::iter::once(program).chain(args.iter().map(String::as_str)) {
        if arg.contains('\0') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in launch argument"));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push('"');
        let mut slashes = 0;
        for ch in arg.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            let copies = if ch == '"' { slashes * 2 + 1 } else { slashes };
            line.extend(std::iter::repeat('\\').take(copies));
            slashes = 0;
            line.push(ch);
        }
        line.extend(std::iter::repeat('\\').take(slashes * 2));
        line.push('"');
    }
    let mut wide: Vec<u16> = line.encode_utf16().collect();
    // CreateProcessW's limit includes the terminating NUL.
    if wide.len() >= 32_767 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "launch command line too long"));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fd3_layout_is_packed_and_native_width() {
        let handles = [0x11usize, 0x22, 0x33, 0x44];
        let bytes = fd3_bootstrap(handles).unwrap();
        assert_eq!(&bytes[..4], &4i32.to_ne_bytes());
        assert_eq!(&bytes[4..8], &[65, 1, 1, 9]);
        assert_eq!(bytes.len(), 8 + 4 * std::mem::size_of::<usize>());
        for (i, handle) in handles.iter().enumerate() {
            let start = 8 + i * std::mem::size_of::<usize>();
            assert_eq!(&bytes[start..start + std::mem::size_of::<usize>()], &handle.to_ne_bytes());
        }
    }

    #[test]
    fn generic_layout_copies_handles_at_unaligned_offset() {
        let handle = usize::MAX;
        let bytes = packed_bootstrap(&[9], &[handle]).unwrap();
        assert_eq!(&bytes[..4], &1i32.to_ne_bytes());
        assert_eq!(bytes[4], 9);
        assert_eq!(&bytes[5..], &handle.to_ne_bytes());
        assert_eq!(packed_bootstrap(&[], &[]).unwrap(), 0i32.to_ne_bytes());
    }

    #[test]
    fn invalid_counts_and_reserved_size_are_refused() {
        assert!(packed_bootstrap(&[1], &[]).is_err());
        let flags = vec![1; 65_536];
        let handles = vec![1; flags.len()];
        assert!(packed_bootstrap(&flags, &handles).is_err());
    }

    #[test]
    fn command_quotes_empty_spaces_quotes_and_trailing_slashes() {
        let wide = command_line("node.exe", &["".into(), "a b".into(), "a\"b".into(), "tail\\".into()]).unwrap();
        assert_eq!(wide.last(), Some(&0));
        let text = String::from_utf16(&wide[..wide.len() - 1]).unwrap();
        assert_eq!(text, "\"node.exe\" \"\" \"a b\" \"a\\\"b\" \"tail\\\\\"");
    }

    #[test]
    fn command_rejects_nul_and_excess_utf16_length() {
        assert!(command_line("node.exe", &["x\0y".into()]).is_err());
        assert!(command_line("node.exe", &["x".repeat(32_767)]).is_err());
    }
}
