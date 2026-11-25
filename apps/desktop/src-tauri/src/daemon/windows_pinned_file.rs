//! Windows final-file pinning, independent of launch admission.

#![cfg(windows)]

use std::fs::{File, OpenOptions};
use std::io;
use std::mem::MaybeUninit;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::path::Path;

const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_TYPE_DISK: u32 = 0x0001;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

// BY_HANDLE_FILE_INFORMATION is 13 DWORDs (each FILETIME is two DWORDs).
#[repr(C)]
struct ByHandleFileInformation {
    attributes: u32,
    creation_time: [u32; 2],
    last_access_time: [u32; 2],
    last_write_time: [u32; 2],
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetFileType(file: RawHandle) -> u32;
    fn GetFileInformationByHandle(file: RawHandle, info: *mut ByHandleFileInformation) -> i32;
}

/// Opens and validates the final file, then returns that same readable handle.
/// The handle denies ordinary write and delete opens until it is dropped.
///
/// Caller precondition: supply an absolute, ordinary filesystem path to the
/// unnamed data stream. The caller must rule out special paths (device/NT
/// namespaces, DOS device aliases, pipes, and alternate data streams) before
/// calling; this is not an entry point for raw, untrusted path strings. This
/// checks the final object only, not ancestor containment or provenance.
pub(crate) fn open_pinned_file(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected an absolute file path",
        ));
    }
    // Allow a directory to be opened for inspection, but do not follow a final
    // reparse point. File owns the handle even if a later check fails.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let handle = file.as_raw_handle();
    // SAFETY: `file` owns this live handle throughout both queries.
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err(not_regular_file());
    }
    let mut info = MaybeUninit::<ByHandleFileInformation>::uninit();
    // SAFETY: the handle is live and `info` is valid writable ABI-sized storage.
    if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful query initializes the structure.
    let info = unsafe { info.assume_init() };
    if info.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || info.number_of_links != 1
    {
        return Err(not_regular_file());
    }
    Ok(file)
}

fn not_regular_file() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "expected a regular single-link file")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read;
    use std::os::windows::fs::symlink_file;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const READ_SHARE: u32 = 1;
    const ALL_SHARES: u32 = READ_SHARE | 2 | 4;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const BYTES: &[u8] = b"synthetic runtime file\0\xff";

    fn fixture_dir(case: &str) -> PathBuf {
        // The runner explicitly supplies an authorized scratch directory. Retain fixtures.
        let root = PathBuf::from(std::env::var_os("DOT_PINNED_FILE_TEST_SCRATCH").unwrap());
        assert!(root.is_absolute());
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = root.join(format!("{case}-{}-{nonce}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn fixture_file(dir: &Path) -> PathBuf {
        let path = dir.join("runtime.bin");
        fs::write(&path, BYTES).unwrap();
        path
    }

    #[test]
    #[ignore = "requires dedicated DOT_PINNED_FILE_TEST_SCRATCH; retains fixtures"]
    fn reads_exact_bytes_from_held_handle_and_accepts_a_read_only_share() {
        let path = fixture_file(&fixture_dir("read"));
        let mut held = open_pinned_file(&path).unwrap();
        let mut reader = OpenOptions::new()
            .read(true)
            .share_mode(READ_SHARE)
            .open(&path)
            .unwrap();
        let mut bytes = Vec::new();
        held.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, BYTES);
        bytes.clear();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, BYTES);
    }

    #[test]
    #[ignore = "requires dedicated DOT_PINNED_FILE_TEST_SCRATCH; retains fixtures"]
    fn denies_write_and_delete_opens_until_drop() {
        let path = fixture_file(&fixture_dir("sharing"));
        let held = open_pinned_file(&path).unwrap();
        // Grant all sharing on the competing handles so only the held handle's
        // share mask can be responsible for a sharing violation.
        let write = || {
            OpenOptions::new().write(true).share_mode(ALL_SHARES).open(&path)
        };
        let delete = || {
            OpenOptions::new().access_mode(DELETE_ACCESS).share_mode(ALL_SHARES).open(&path)
        };
        let write_error = write().err().and_then(|error| error.raw_os_error());
        let delete_error = delete().err().and_then(|error| error.raw_os_error());
        drop(held);
        drop(write().expect("write access after drop"));
        drop(delete().expect("DELETE access after drop (without deleting the file)"));
        assert_eq!(
            (write_error, delete_error),
            (Some(ERROR_SHARING_VIOLATION), Some(ERROR_SHARING_VIOLATION))
        );
        assert_eq!(fs::read(&path).unwrap(), BYTES);
    }

    #[test]
    fn refuses_relative_paths() {
        assert_eq!(
            open_pinned_file(Path::new("runtime.bin")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    #[ignore = "requires dedicated DOT_PINNED_FILE_TEST_SCRATCH; retains fixtures"]
    fn refuses_directories_and_hard_links() {
        let dir = fixture_dir("shape");
        let target = fixture_file(&dir);
        let link = dir.join("hard-link.bin");
        fs::hard_link(&target, &link).unwrap();
        let results = [&dir, &target, &link]
            .map(|path| open_pinned_file(path).err().map(|error| error.kind()));
        assert_eq!(results, [Some(io::ErrorKind::InvalidData); 3]);
        assert_eq!(fs::read(&target).unwrap(), BYTES);
    }

    #[test]
    #[ignore = "requires dedicated DOT_PINNED_FILE_TEST_SCRATCH; retains fixtures"]
    fn refuses_final_symlink_when_supported() {
        let dir = fixture_dir("symlink");
        let target = fixture_file(&dir);
        let link = dir.join("symlink.bin");
        match symlink_file(&target, &link) {
            Ok(()) => {}
            Err(error) if matches!(error.raw_os_error(), Some(50 | 1314)) => {
                eprintln!("skipped final symlink check: {error}");
                return;
            }
            Err(error) => panic!("could not create synthetic file symlink: {error}"),
        }
        assert_eq!(open_pinned_file(&link).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(&target).unwrap(), BYTES);
    }
}
