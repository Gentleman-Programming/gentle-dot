//! Admission of an exact private Windows split-runtime tree, without launch wiring.
//!
//! The trusted caller supplies the intended root, canonical manifest bytes and
//! an independent digest. The tree and its path resolution must remain stable
//! and exclusively controlled. Enumeration is path-based, not a snapshot; the
//! retained handles constrain ordinary sharing, not all namespace mutations.
//! This proves neither same-user atomicity nor provenance. Provisioning and
//! root ACLs are separate responsibilities. Only unnamed file data is read.

#![cfg(windows)]

use super::windows_pinned_file::open_pinned_file;
use super::windows_split_manifest::{Manifest, ManifestError};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::mem::MaybeUninit;
use std::os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle};
use std::path::{Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW,
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_EXECUTE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_TYPE_DISK, VOLUME_NAME_DOS,
};

#[derive(Debug)]
pub(super) enum TreeError {
    Manifest(ManifestError),
    RootPath,
    Layout,
    Io(io::Error),
}

impl From<io::Error> for TreeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub(super) struct PinnedTree {
    root: PathBuf,
    files: Vec<File>,
    dirs: Vec<File>,
}

impl Drop for PinnedTree {
    fn drop(&mut self) {
        self.files.clear();
        while self.dirs.pop().is_some() {} // descendants before their ancestors
    }
}

impl PinnedTree {
    #[allow(dead_code)] // The split binary verifies only; the library also plans launch.
    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn admit(root: &Path, raw: &[u8], digest: [u8; 32]) -> Result<Self, TreeError> {
        let manifest = Manifest::decode(raw, digest).map_err(TreeError::Manifest)?;
        let text = root_spelling(root)?;
        let layout = expected_layout(&manifest)?;
        let mut tree = Self {
            root: root.to_owned(),
            files: Vec::new(),
            dirs: Vec::new(),
        };
        let mut prefix = PathBuf::from(&text[..3]);
        let drive = [text.as_bytes()[0] as u16, b':' as u16, b'\\' as u16, 0];
        // SAFETY: `drive` is a NUL-terminated DOS drive root.
        const DRIVE_FIXED: u32 = 3;
        if unsafe { GetDriveTypeW(drive.as_ptr()) } != DRIVE_FIXED {
            return Err(TreeError::RootPath);
        }
        for component in std::iter::once("").chain(text[3..].split('\\')) {
            if !component.is_empty() {
                prefix.push(component);
            }
            let dir = open_directory(&prefix)?;
            check_root_name(&dir, &prefix)?;
            tree.dirs.push(dir);
        }
        enumerate(root, &layout, &mut tree.dirs)?;
        // Complete exact-name and metadata checks before opening any data handle.
        let paths: Vec<_> = manifest.files().iter()
            .map(|record| root.join(record.path().replace('/', "\\"))).collect();
        for path in &paths {
            preflight_file(path)?;
        }
        for path in &paths {
            tree.files.push(open_pinned_file(path)?);
        }
        for (record, file) in manifest.files().iter().zip(&tree.files) {
            record.verify(file).map_err(TreeError::Manifest)?;
        }
        Ok(tree)
    }
}

// Accept a deliberately narrow, unambiguous DOS spelling. Check the original
// string, not Path::components(), which discards e.g. interior '.' components.
pub(super) fn root_spelling(root: &Path) -> Result<&str, TreeError> {
    let text = root.to_str().ok_or(TreeError::RootPath)?;
    let bytes = text.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\"
        || !text[3..].split('\\').all(ordinary_root_component)
    {
        return Err(TreeError::RootPath);
    }
    Ok(text)
}

fn ordinary_root_component(name: &str) -> bool {
    if name.is_empty() || name.ends_with([' ', '.'])
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b" ._@+-()".contains(&b))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ');
    let stem = stem.to_ascii_lowercase();
    !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        && !(stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

fn open_directory(path: &Path) -> Result<File, TreeError> {
    let dir = OpenOptions::new()
        // Attributes-only access would not participate in read/write/delete sharing.
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let attrs = disk_info(&dir)?.dwFileAttributes;
    if attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != FILE_ATTRIBUTE_DIRECTORY {
        return Err(TreeError::Layout);
    }
    Ok(dir)
}

fn disk_info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, TreeError> {
    let handle = file.as_raw_handle();
    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: `file` owns the live handle, and `info` has writable ABI-sized storage.
    unsafe {
        if GetFileType(handle) != FILE_TYPE_DISK {
            return Err(TreeError::Layout);
        }
        if GetFileInformationByHandle(handle, info.as_mut_ptr()) == 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(info.assume_init())
    }
}

fn preflight_file(path: &Path) -> Result<(), TreeError> {
    const WRONG_ATTRIBUTES: u32 = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_attributes() & WRONG_ATTRIBUTES != 0 {
        return Err(TreeError::Layout);
    }
    // Stable std metadata does not expose the link count. Query a native handle
    // without FILE_READ_DATA. FILE_EXECUTE makes sharing checks apply (unlike
    // attributes-only access); this handle is used only for metadata, never execution.
    let metadata_handle = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_EXECUTE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let info = disk_info(&metadata_handle)?;
    if info.dwFileAttributes & WRONG_ATTRIBUTES != 0 {
        return Err(TreeError::Layout);
    }
    if info.nNumberOfLinks != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "expected a regular single-link file").into());
    }
    Ok(())
}

// Check normalized spelling on the already inspected handle. This also rejects
// short-name aliases without relying on every short name containing a tilde.
fn check_root_name(dir: &File, path: &Path) -> Result<(), TreeError> {
    let expected: Vec<_> = r"\\?\".encode_utf16()
        .chain(path.to_str().ok_or(TreeError::RootPath)?.encode_utf16()).collect();
    let mut actual = vec![0u16; expected.len() + 1];
    // SAFETY: `dir` owns the live handle and `actual` is a writable UTF-16 buffer.
    let len = unsafe {
        GetFinalPathNameByHandleW(dir.as_raw_handle(), actual.as_mut_ptr(), actual.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)
    } as usize;
    if len == 0 {
        return Err(io::Error::last_os_error().into());
    }
    // Drive-letter case is not a component alias; all directory names are exact.
    let drive = 4;
    actual[drive] = u16::from(u8::try_from(actual[drive]).unwrap_or(0).to_ascii_uppercase());
    let drive_only = expected.len() == 7 && len == 6;
    if len > actual.len() || (!drive_only && len != expected.len())
        || actual[..drive] != expected[..drive]
        || actual[drive] != u16::from((expected[drive] as u8).to_ascii_uppercase())
        || actual[drive + 1..len] != expected[drive + 1..len]
    {
        return Err(TreeError::RootPath);
    }
    Ok(())
}

type Layout<'a> = BTreeMap<&'a str, Member<'a>>;

enum Member<'a> {
    Dir(Layout<'a>),
    File,
}

fn expected_layout(manifest: &Manifest) -> Result<Layout<'_>, TreeError> {
    let mut layout = Layout::new();
    for record in manifest.files() {
        let mut dir = &mut layout;
        let mut components = record.path().split('/').peekable();
        while let Some(name) = components.next() {
            if components.peek().is_none() {
                dir.insert(name, Member::File);
            } else if let Member::Dir(children) = dir.entry(name).or_insert_with(|| Member::Dir(Layout::new())) {
                dir = children;
            } else {
                return Err(TreeError::Layout);
            }
        }
    }
    Ok(layout)
}

fn enumerate(path: &Path, layout: &Layout<'_>, dirs: &mut Vec<File>) -> Result<(), TreeError> {
    let mut seen = BTreeSet::new();
    for entry in fs::read_dir(path)? {
        let name = entry?.file_name();
        let (expected, _) = name.to_str().and_then(|name| layout.get_key_value(name))
            .ok_or(TreeError::Layout)?;
        if !seen.insert(expected) {
            return Err(TreeError::Layout);
        }
    }
    if seen.len() != layout.len() {
        return Err(TreeError::Layout);
    }
    for (name, member) in layout {
        if let Member::Dir(children) = member {
            let child = path.join(name);
            dirs.push(open_directory(&child)?);
            enumerate(&child, children, dirs)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::{symlink_dir, OpenOptionsExt};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const PATHS: [&str; 7] = [
        "bin/engram.exe", "bin/pi.exe", "bin/private-storage.exe", "daemon/cli.mjs",
        "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs", "node/node.exe", "ui/index.html",
    ];

    fn scratch() -> PathBuf {
        let base = PathBuf::from(std::env::var_os("DOT_SPLIT_TREE_TEST_SCRATCH").unwrap());
        assert!(base.is_absolute());
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = base.join(format!("{}-{nonce}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn fixture(root: &Path, omit: &str) {
        for path in PATHS.into_iter().filter(|&path| path != omit) {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"abc").unwrap();
        }
    }

    fn inventory() -> String {
        let records: Vec<_> = PATHS.iter().map(|path| format!(
            r#"{{"path":"{path}","type":"file","size":3,"sha256":"{:x}"}}"#,
            Sha256::digest(b"abc"),
        )).collect();
        format!("{{\"schema\":1,\"target\":\"windows-x64\",\"shell\":\"5.0.0\",\"pi\":\"1.6.0\",\"files\":[{}]}}\n", records.join(","))
    }

    fn admit(root: &Path) -> Result<PinnedTree, TreeError> {
        let raw = inventory();
        PinnedTree::admit(root, raw.as_bytes(), Sha256::digest(&raw).into())
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn authenticates_and_decodes_before_missing_root() {
        let missing = scratch().join("absent");
        assert!(matches!(PinnedTree::admit(&missing, b"{", [0; 32]),
            Err(TreeError::Manifest(ManifestError::ManifestDigest))));
        assert!(matches!(PinnedTree::admit(&missing, b"{", Sha256::digest(b"{").into()),
            Err(TreeError::Manifest(ManifestError::Schema))));
        let raw = inventory().replace("ui/index.html", "x/sessions-inert/a");
        assert!(matches!(PinnedTree::admit(&missing, raw.as_bytes(), Sha256::digest(raw.as_bytes()).into()),
            Err(TreeError::Manifest(ManifestError::Path))));
        assert!(matches!(admit(&missing), Err(TreeError::Io(e)) if e.kind() == io::ErrorKind::NotFound));
        assert!(!missing.exists());
    }

    #[test]
    fn rejects_ambiguous_root_spelling() {
        for text in [r"relative\a", r"D:a", r"\\host\share\a", r"\\?\D:\a", r"\\.\D:\a",
            r"D:\a\.\b", r"D:\a\..\b", r"D:\a\\b", "D:/a", "D:\\a\\", r"D:\a.\b",
            r"D:\a \b", r"D:\a:stream", r"D:\LONGNA~1", r"D:\nul.txt", r"D:\COM¹.txt"] {
            assert!(matches!(admit(Path::new(text)), Err(TreeError::RootPath)), "{text}");
        }
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn exact_tree_only_and_extras_precede_member_open() {
        let root = scratch();
        fixture(&root, "");
        drop(admit(&root).expect("exact tree"));
        let extra = root.join("ui/extra.bin");
        fs::write(&extra, b"unlisted").unwrap();
        let blocked = OpenOptions::new().write(true).share_mode(0)
            .open(root.join("bin/engram.exe")).unwrap();
        assert!(matches!(admit(&root), Err(TreeError::Layout)));
        drop(blocked);
        assert_eq!(fs::read(extra).unwrap(), b"unlisted");
        for replacement in [None, Some("Index.html"), Some("empty-dir")] {
            let root = scratch();
            fixture(&root, "ui/index.html");
            let ui = root.join("ui");
            fs::create_dir(&ui).unwrap();
            match replacement {
                Some("empty-dir") => fs::create_dir(ui.join("empty-dir")).unwrap(),
                Some(name) => fs::write(ui.join(name), b"abc").unwrap(),
                None => (),
            }
            assert!(matches!(admit(&root), Err(TreeError::Layout)));
            assert_eq!(fs::read(root.join("bin/pi.exe")).unwrap(), b"abc");
        }
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn refuses_same_size_corrupt_member() {
        let root = scratch();
        fixture(&root, "");
        let file = root.join("ui/index.html");
        fs::write(&file, b"abd").unwrap();
        assert!(matches!(admit(&root), Err(TreeError::Manifest(ManifestError::FileDigest))));
        assert_eq!(fs::read(file).unwrap(), b"abd");
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn late_wrong_type_wins_over_earlier_corrupt_bytes() {
        let root = scratch();
        fixture(&root, "ui/index.html");
        let early = root.join("bin/engram.exe");
        let late = root.join("ui/index.html");
        fs::write(&early, b"abd").unwrap();
        fs::create_dir_all(&late).unwrap();
        assert!(matches!(admit(&root), Err(TreeError::Layout)));
        assert_eq!(fs::read(&early).unwrap(), b"abd");
        assert!(fs::read_dir(&late).unwrap().next().is_none());
        assert_eq!(fs::read(root.join("bin/pi.exe")).unwrap(), b"abc");
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn denies_write_and_delete_opens_until_drop() {
        let ancestor = scratch();
        let root = ancestor.join("runtime");
        fixture(&root, "");
        let file = root.join("bin/pi.exe");
        let paths = [&ancestor, &root, &root.join("bin"), &file];
        let attempt = |path, access| OpenOptions::new().access_mode(access).share_mode(7)
            .custom_flags(0x0200_0000).open(path);
        let held = admit(&root).unwrap();
        for path in paths {
            for access in [2, 0x0001_0000] { // FILE_WRITE_DATA / FILE_ADD_FILE, DELETE
                assert_eq!(attempt(path, access).unwrap_err().raw_os_error(), Some(32), "{path:?}");
            }
        }
        drop(held);
        for path in paths {
            for access in [2, 0x0001_0000] {
                drop(attempt(path, access).expect("access released"));
            }
        }
        assert_eq!(fs::read(file).unwrap(), b"abc");
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn refuses_hard_link_member_when_supported() {
        let root = scratch();
        fixture(&root, "bin/pi.exe");
        let target = root.join("bin/engram.exe");
        match fs::hard_link(&target, root.join("bin/pi.exe")) {
            Ok(()) => (),
            Err(e) if e.raw_os_error() == Some(50) => { eprintln!("hard link unsupported: {e}"); return; }
            Err(e) => panic!("fixture hard link: {e}"),
        }
        assert!(matches!(admit(&root), Err(TreeError::Io(e)) if e.kind() == io::ErrorKind::InvalidData));
        assert_eq!(fs::read(target).unwrap(), b"abc");
    }

    #[test]
    #[ignore = "requires dedicated DOT_SPLIT_TREE_TEST_SCRATCH; retains fixtures"]
    fn refuses_reparse_directory_when_supported() {
        let target = scratch();
        fixture(&target, "");
        let root = scratch();
        fixture(&root, "ui/index.html");
        match symlink_dir(target.join("ui"), root.join("ui")) {
            Ok(()) => (),
            Err(e) if matches!(e.raw_os_error(), Some(50 | 1314)) => {
                eprintln!("directory symlink unsupported: {e}");
                return;
            }
            Err(e) => panic!("fixture directory symlink: {e}"),
        }
        assert!(matches!(admit(&root), Err(TreeError::Layout)));
        assert!(matches!(admit(&root.join("ui")), Err(TreeError::Layout)));
        assert_eq!(fs::read(target.join("ui/index.html")).unwrap(), b"abc");
    }
}
