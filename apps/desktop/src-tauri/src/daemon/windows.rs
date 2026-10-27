//! Windows launch encoding, native launch preparation and protected record provenance.
//! The owned-process and recovered-stop adapters land in later slices.

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

#[cfg(windows)]
mod native {
    use super::fd3_bootstrap;
    use super::super::{ChildEndpoint, LaunchSpec};
    use std::ffi::OsString;
    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Globalization::CompareStringOrdinal;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;

    // SDK winnt.h definitions, scoped here because the enabled windows-sys
    // namespaces do not expose them: ACE_HEADER.AceType and SID count are BYTEs.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
    const SID_MAX_SUB_AUTHORITIES: u8 = 15;
    // GetDriveTypeW's documented UINT return constant: DRIVE_FIXED = 3.
    const DRIVE_FIXED: u32 = 3;

    // Redirected stdio does not prevent Windows from allocating a console for Node.
    const DAEMON_CREATION_FLAGS: u32 =
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;

    fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
        // SAFETY: a fresh native handle with exactly one owner.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
    fn checked(ok: i32) -> io::Result<()> {
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
    fn wide(text: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = text.encode_wide().collect();
        if value.contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in launch value")); }
        value.push(0);
        Ok(value)
    }
    fn duplicate(handle: HANDLE) -> io::Result<OwnedHandle> {
        let mut copy = null_mut();
        // SAFETY: duplicate only a caller-owned handle, within this process. The copy, not
        // the source, is inheritable and will appear in the exact startup transfer list.
        unsafe {
            checked(DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &mut copy,
                0, 1, DUPLICATE_SAME_ACCESS))?;
        }
        owned(copy)
    }

    struct Transfers { nul: OwnedHandle, stdout: OwnedHandle, stderr: OwnedHandle, channel: OwnedHandle }
    impl Transfers {
        fn new(log: &File, channel: &ChildEndpoint) -> io::Result<Self> {
            let name = wide(std::ffi::OsStr::new("NUL"))?;
            let nul = owned(unsafe { CreateFileW(name.as_ptr(), GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut()) })?;
            Ok(Self { nul: duplicate(nul.as_raw_handle())?, stdout: duplicate(log.as_raw_handle())?,
                stderr: duplicate(log.as_raw_handle())?, channel: duplicate(channel.as_raw_handle())? })
        }
        fn handles(&self) -> [HANDLE; 4] {
            [self.nul.as_raw_handle(), self.stdout.as_raw_handle(), self.stderr.as_raw_handle(), self.channel.as_raw_handle()]
        }
        fn bootstrap(&self) -> io::Result<Vec<u8>> {
            fd3_bootstrap(self.handles().map(|handle| handle as usize))
        }
    }
    struct Attributes { storage: Vec<usize>, initialized: bool }
    impl Attributes {
        fn new(handles: &mut [HANDLE; 4]) -> io::Result<Self> {
            let mut bytes = 0;
            // SAFETY: size-only query, as required by the attribute-list API.
            let queried = unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
            let query_error = io::Error::last_os_error();
            if queried != 0 || bytes == 0 || query_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
                return Err(io::Error::other("startup attribute size query failed"));
            }
            let mut this = Self { storage: vec![0; bytes.div_ceil(std::mem::size_of::<usize>())], initialized: false };
            // SAFETY: aligned storage of queried size; handles stay stable through CreateProcessW.
            unsafe {
                checked(InitializeProcThreadAttributeList(this.pointer(), 1, 0, &mut bytes))?;
                this.initialized = true;
                checked(UpdateProcThreadAttribute(this.pointer(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_mut_ptr().cast(), std::mem::size_of_val(handles), null_mut(), null_mut()))?;
            }
            Ok(this)
        }
        fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST { self.storage.as_mut_ptr().cast() }
    }
    impl Drop for Attributes {
        fn drop(&mut self) {
            if self.initialized { unsafe { DeleteProcThreadAttributeList(self.pointer()) }; }
        }
    }

    fn compare_names(left: &[u16], right: &[u16]) -> io::Result<std::cmp::Ordering> {
        let left_len = i32::try_from(left.len()).map_err(io::Error::other)?;
        let right_len = i32::try_from(right.len()).map_err(io::Error::other)?;
        // SAFETY: length-delimited UTF-16 buffers; Windows ordinal case-insensitive ordering.
        match unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) } {
            1 => Ok(std::cmp::Ordering::Less), 2 => Ok(std::cmp::Ordering::Equal),
            3 => Ok(std::cmp::Ordering::Greater), _ => Err(io::Error::last_os_error()),
        }
    }
    fn environment(spec: &LaunchSpec) -> io::Result<Vec<u16>> {
        let mut entries: Vec<(Vec<u16>, Vec<u16>)> = std::env::vars_os()
            .map(|(key, value)| (key.encode_wide().collect(), value.encode_wide().collect())).collect();
        for (key, value) in &spec.envs {
            if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid launch environment"));
            }
            let key: Vec<u16> = key.encode_utf16().collect();
            let value: Vec<u16> = value.encode_utf16().collect();
            let mut found = None;
            for (index, (existing, _)) in entries.iter().enumerate() {
                if compare_names(existing, &key)? == std::cmp::Ordering::Equal { found = Some(index); break; }
            }
            if let Some(index) = found { entries[index] = (key, value); } else { entries.push((key, value)); }
        }
        // Fallible insertion sort keeps an API failure observable instead of inventing an order.
        for index in 1..entries.len() {
            let mut at = index;
            while at > 0 && compare_names(&entries[at - 1].0, &entries[at].0)? == std::cmp::Ordering::Greater {
                entries.swap(at - 1, at); at -= 1;
            }
        }
        let mut block = Vec::new();
        for (key, value) in entries {
            block.extend(key); block.push(b'=' as u16); block.extend(value); block.push(0);
        }
        if block.is_empty() { block.push(0); }
        block.push(0);
        Ok(block)
    }
    fn application(spec: &LaunchSpec) -> io::Result<Vec<u16>> {
        let program = Path::new(&spec.program);
        let path = if program.components().count() > 1 || program.is_absolute() {
            program.to_path_buf()
        } else {
            let path = spec.envs.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
                .map(|(_, value)| OsString::from(value)).or_else(|| std::env::var_os("PATH"));
            let file = if program.extension().is_some() { program.to_path_buf() } else { program.with_extension("exe") };
            path.as_deref().into_iter().flat_map(std::env::split_paths).map(|dir| dir.join(&file))
                .find(|candidate| candidate.is_file())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "daemon executable not found in launch PATH"))?
        };
        // Windows absolute() also resolves drive-relative paths; cwd itself is unchanged.
        let absolute = std::path::absolute(path)?;
        wide(absolute.as_os_str())
    }

    fn new_job() -> io::Result<OwnedHandle> {
        let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            checked(SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32))?;
            let mut observed: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            checked(QueryInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
                (&mut observed as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&observed) as u32, null_mut()))?;
            if observed.BasicLimitInformation.LimitFlags != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE {
                return Err(io::Error::other("owned Job limits not established"));
            }
        }
        Ok(job)
    }
    fn job_active(job: &OwnedHandle) -> io::Result<u32> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        unsafe {
            checked(QueryInformationJobObject(job.as_raw_handle(), JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), std::mem::size_of_val(&accounting) as u32, null_mut()))?;
        }
        Ok(accounting.ActiveProcesses)
    }

    /// Stable opened-file identity for a later independently checked deletion handle.
    /// This is not process identity or permission to delete; unit 3 must also compare
    /// the complete record and establish exact-process clean completion.
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(crate) struct FileIdentity {
        volume: u64,
        id: [u8; 16],
        created: u64,
    }
    impl FileIdentity {
        fn from_handle(handle: HANDLE, info: &BY_HANDLE_FILE_INFORMATION) -> io::Result<Self> {
            // Require the full filesystem identifier (including ReFS's 128-bit ID),
            // not a truncated legacy file index. Unsupported queries fail closed.
            let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
            unsafe { checked(GetFileInformationByHandleEx(handle, FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(), std::mem::size_of_val(&id) as u32))?; }
            Ok(Self { volume: id.VolumeSerialNumber, id: id.FileId.Identifier,
                created: ((info.ftCreationTime.dwHighDateTime as u64) << 32) | info.ftCreationTime.dwLowDateTime as u64 })
        }
    }

    /// Read-only provenance owner, not a recovered process. No WRITE/DELETE access is
    /// retained: both sharing directions remain compatible with addon startup's
    /// FILE_SHARE_READ record and ancestry opens. No Debug implementation leaks data.
    pub(crate) struct ValidatedRecord {
        pub(crate) record: super::super::windows_record::Record,
        pub(crate) identity: FileIdentity,
        pub(crate) path: PathBuf,
        pub(crate) file: Option<File>,
        deletion_marked: bool,
        // No delete sharing pins every path component through validation and future
        // use. Keep these guards when replacing the record reader with a deletion
        // handle; that handle must be validated anew, not trusted by pathname.
        _ancestry: Vec<OwnedHandle>,
    }

    fn require_complete_record(expected_identity: FileIdentity, expected: &super::super::windows_record::Record,
        observed_identity: FileIdentity, observed: &super::super::windows_record::Record) -> io::Result<()> {
        if expected_identity != observed_identity || expected != observed { return Err(unsafe_record()); }
        Ok(())
    }

    struct SecuritySnapshot(PSECURITY_DESCRIPTOR);
    impl Drop for SecuritySnapshot {
        fn drop(&mut self) { unsafe { LocalFree(self.0) }; }
    }
    fn unsafe_record() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, "unsafe Windows stop record provenance")
    }

    // Aligned buffers are required before interpreting TOKEN_USER or passing SID
    // pointers to Windows. Byte vectors alone do not promise this alignment.
    fn current_user_sid() -> io::Result<Vec<usize>> {
        let mut token = null_mut();
        unsafe { checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token))?; }
        let token = owned(token)?;
        let mut size = 0;
        let result = unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
        let error = io::Error::last_os_error();
        if result != 0 || error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || size < std::mem::size_of::<TOKEN_USER>() as u32 || size > 65_536 {
            return Err(unsafe_record());
        }
        let mut data = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        unsafe {
            checked(GetTokenInformation(token.as_raw_handle(), TokenUser, data.as_mut_ptr().cast(), size, &mut size))?;
            let sid = (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid;
            if IsValidSid(sid) == 0 { return Err(unsafe_record()); }
            let length = GetLengthSid(sid);
            if length == 0 || length > SECURITY_MAX_SID_SIZE as u32 { return Err(unsafe_record()); }
            let mut copy = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
            checked(CopySid(length, copy.as_mut_ptr().cast(), sid))?;
            Ok(copy)
        }
    }

    fn validate_record_security(handle: HANDLE, expected: PSID) -> io::Result<()> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        let result = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, null_mut(), &mut acl, null_mut(), &mut descriptor) };
        if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32)); }
        let _snapshot = SecuritySnapshot(descriptor);
        if descriptor.is_null() { return Err(unsafe_record()); }
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: GetSecurityInfo owns the returned descriptor, ACL and owner SID;
        // the snapshot retains their allocation through every inspection below.
        unsafe {
            if owner.is_null() || IsValidSid(owner) == 0 || EqualSid(owner, expected) == 0
                || acl.is_null() || IsValidAcl(acl) == 0
                || GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0
                || control & SE_DACL_PROTECTED as u16 == 0 || (*acl).AceCount == 0 {
                return Err(unsafe_record());
            }
            for index in 0..(*acl).AceCount {
                let mut raw = null_mut();
                checked(GetAce(acl, index as u32, &mut raw))?;
                if raw.is_null() { return Err(unsafe_record()); }
                let header = &*raw.cast::<ACE_HEADER>();
                // ACCESS_ALLOWED_ACE has an 8-byte prefix, then a variable SID.
                // Bound the SID header and subauthorities before IsValidSid reads it.
                const SID_OFFSET: usize = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
                if header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE as u32 || header.AceFlags != 0
                    || (header.AceSize as usize) < SID_OFFSET + 8 {
                    return Err(unsafe_record());
                }
                let sid_bytes = raw.cast::<u8>().add(SID_OFFSET);
                let count = *sid_bytes.add(1) as usize;
                if count > SID_MAX_SUB_AUTHORITIES as usize
                    || (header.AceSize as usize) != SID_OFFSET + 8 + 4 * count {
                    return Err(unsafe_record());
                }
                let sid = sid_bytes.cast();
                if IsValidSid(sid) == 0 || EqualSid(sid, expected) == 0 {
                    return Err(unsafe_record());
                }
            }
        }
        Ok(())
    }

    fn file_info(handle: HANDLE) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
        let mut info = unsafe { std::mem::zeroed() };
        unsafe { checked(GetFileInformationByHandle(handle, &mut info))?; }
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(unsafe_record());
        }
        Ok(info)
    }

    fn record_ancestry(path: &Path, create_missing: bool) -> io::Result<Vec<OwnedHandle>> {
        let name = wide(path.as_os_str())?;
        let text = &name[..name.len() - 1];
        if text.len() < 4 || text[1] != b':' as u16 || text[2] != b'\\' as u16
            || !((b'A' as u16..=b'Z' as u16).contains(&text[0])
                || (b'a' as u16..=b'z' as u16).contains(&text[0])) {
            return Err(unsafe_record());
        }
        let root = [text[0], text[1], text[2], 0];
        if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_FIXED { return Err(unsafe_record()); }
        let sid = current_user_sid()?;
        let expected = sid.as_ptr() as PSID;
        let mut ancestry = Vec::new();
        // Include the drive root. Every ancestor is opened with read-only access
        // and no write/delete sharing, and kept alive in the returned owner.
        let root_handle = owned(unsafe { CreateFileW(root.as_ptr(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
        if file_info(root_handle.as_raw_handle())?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(unsafe_record());
        }
        ancestry.push(root_handle);
        let mut start = 3;
        for end in 3..=text.len() {
            if end != text.len() && text[end] != b'\\' as u16 { continue; }
            let component = &text[start..end];
            if component.is_empty() || component == [b'.' as u16] || component == [b'.' as u16, b'.' as u16]
                || component.iter().any(|ch| *ch < 32 || [b':' as u16, b'/' as u16,
                    b'*' as u16, b'?' as u16, b'"' as u16, b'<' as u16, b'>' as u16, b'|' as u16].contains(ch))
                || matches!(component.last(), Some(ch) if *ch == b'.' as u16 || *ch == b' ' as u16) {
                return Err(unsafe_record());
            }
            start = end + 1;
            if end == text.len() { break; }
            let mut prefix = text[..end].to_vec(); prefix.push(0);
            let mut raw = unsafe { CreateFileW(prefix.as_ptr(), FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ, null(), OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            if raw == INVALID_HANDLE_VALUE && create_missing {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_FILE_NOT_FOUND as i32)
                    && error.raw_os_error() != Some(ERROR_PATH_NOT_FOUND as i32) { return Err(error); }
                // Create only absent components, beneath already retained ancestry.
                // Existing directories are never repaired by admission/validation.
                let descriptor = Descriptor::for_user(expected)?;
                if unsafe { CreateDirectoryW(prefix.as_ptr(), &descriptor.attributes()) } == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) { return Err(error); }
                }
                raw = unsafe { CreateFileW(prefix.as_ptr(), FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ, null(), OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            }
            let directory = owned(raw)?;
            if file_info(directory.as_raw_handle())?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err(unsafe_record());
            }
            ancestry.push(directory);
        }
        Ok(ancestry)
    }

    /// First-run directory creation is separate from read-only validation and never
    /// repairs an existing object. Every missing component gets a literal-user DACL.
    pub(crate) fn ensure_record_directory(data_dir: &Path) -> io::Result<()> {
        record_ancestry(&data_dir.join(super::super::PID_FILE), true).map(drop)
    }

    fn read_protected(file: &mut File, max: usize) -> io::Result<(Vec<u8>, FileIdentity)> {
        use std::io::{Read, Seek};
        let sid = current_user_sid()?;
        let info = file_info(file.as_raw_handle())?;
        let length = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || length == 0 || length > max as u64 {
            return Err(unsafe_record());
        }
        validate_record_security(file.as_raw_handle(), sid.as_ptr() as PSID)?;
        let identity = FileIdentity::from_handle(file.as_raw_handle(), &info)?;
        file.rewind()?;
        let mut bytes = Vec::with_capacity(max + 1);
        (&mut *file).take((max + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != length { return Err(unsafe_record()); }
        let after = file_info(file.as_raw_handle())?;
        if FileIdentity::from_handle(file.as_raw_handle(), &after)? != identity
            || after.nFileSizeHigh != info.nFileSizeHigh || after.nFileSizeLow != info.nFileSizeLow {
            return Err(unsafe_record());
        }
        Ok((bytes, identity))
    }

    fn read_record_file(file: &mut File) -> io::Result<(super::super::windows_record::Record, FileIdentity)> {
        use super::super::windows_record::{Record, MAX_BYTES};
        let (bytes, identity) = read_protected(file, MAX_BYTES)?;
        Ok((Record::parse(&bytes)?, identity))
    }

    // The validation/live stages cover multiple checks; they do not identify a syscall.
    #[derive(Clone, Copy, Debug)]
    enum AcquisitionStage {
        RecordAncestry,
        RecordName,
        RecordOpen,
        RecordValidation,
        ProcessOpen,
        ProcessAdmission,
    }
    impl AcquisitionStage {
        fn label(self) -> &'static str {
            match self {
                Self::RecordAncestry => "validate record ancestry",
                Self::RecordName => "encode record name",
                Self::RecordOpen => "open record (CreateFileW)",
                Self::RecordValidation => "validate opened record (security, contents and file identity)",
                Self::ProcessOpen => "open recorded process (OpenProcess)",
                Self::ProcessAdmission => "check recorded process identity and liveness",
            }
        }
        fn error(self, source: io::Error) -> io::Error {
            io::Error::new(source.kind(), AcquisitionError { stage: self, source })
        }
    }
    #[derive(Debug)]
    struct AcquisitionError {
        stage: AcquisitionStage,
        source: io::Error,
    }
    impl std::fmt::Display for AcquisitionError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}: {}", self.stage.label(), self.source)
        }
    }
    impl std::error::Error for AcquisitionError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&self.source) }
    }
    // io::Error::new retains kind, but its raw_os_error() is None. Retrieve the
    // original io::Error (and native code) via std::error::Error::source instead.

    /// Only a genuinely absent final record is None; unsafe/missing ancestry remains
    /// an error. Validation never creates, repairs, deletes or checks process liveness.
    pub(crate) fn read_validated_record(data_dir: &Path) -> io::Result<Option<ValidatedRecord>> {
        let path = data_dir.join(super::super::PID_FILE);
        let ancestry = record_ancestry(&path, false).map_err(|error| AcquisitionStage::RecordAncestry.error(error))?;
        let name = wide(path.as_os_str()).map_err(|error| AcquisitionStage::RecordName.error(error))?;
        let raw = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
            null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) { return Ok(None); }
            return Err(AcquisitionStage::RecordOpen.error(error));
        }
        let mut file = File::from(owned(raw).map_err(|error| AcquisitionStage::RecordOpen.error(error))?);
        let (record, identity) = read_record_file(&mut file)
            .map_err(|error| AcquisitionStage::RecordValidation.error(error))?;
        Ok(Some(ValidatedRecord { record, identity, path, file: Some(file), deletion_marked: false, _ancestry: ancestry }))
    }

    #[cfg(test)]
    mod recovery_contract_tests {
        use super::{require_complete_record, AcquisitionStage, FileIdentity};
        use super::super::super::windows_record::Record;

        #[test]
        fn acquisition_context_preserves_native_source_and_kind() {
            let original = std::io::Error::from_raw_os_error(87);
            let kind = original.kind();
            let message = original.to_string();
            let error = AcquisitionStage::ProcessOpen.error(original);
            assert_eq!(error.kind(), kind);
            assert_eq!(error.raw_os_error(), None);
            let source = std::error::Error::source(&error).unwrap()
                .downcast_ref::<std::io::Error>().unwrap();
            assert_eq!(source.raw_os_error(), Some(87));
            assert_eq!(source.kind(), kind);
            assert_eq!(source.to_string(), message);
            assert_eq!(error.to_string(), format!("open recorded process (OpenProcess): {message}"));
        }

        #[test]
        fn acquisition_context_labels_are_fixed_and_non_secret() {
            let stages = [
                (AcquisitionStage::RecordAncestry, "validate record ancestry"),
                (AcquisitionStage::RecordName, "encode record name"),
                (AcquisitionStage::RecordOpen, "open record (CreateFileW)"),
                (AcquisitionStage::RecordValidation, "validate opened record (security, contents and file identity)"),
                (AcquisitionStage::ProcessOpen, "open recorded process (OpenProcess)"),
                (AcquisitionStage::ProcessAdmission, "check recorded process identity and liveness"),
            ];
            // Synthetic only: no record/path is accepted by the contextualizer.
            let private_path = r"C:\private-synthetic-profile\daemon.pid";
            let capability = "synthetic-private-capability-0123456789";
            for (stage, label) in stages {
                let original = std::io::Error::from_raw_os_error(87);
                let message = original.to_string();
                let error = stage.error(original);
                let displayed = error.to_string();
                assert_eq!(displayed, format!("{label}: {message}"));
                assert!(!displayed.contains(private_path));
                assert!(!displayed.contains(capability));
                let debug = format!("{error:?}");
                assert!(!debug.contains(private_path));
                assert!(!debug.contains(capability));
            }
        }

        #[test]
        fn acquisition_context_preserves_non_native_validation_failure() {
            let error = AcquisitionStage::RecordValidation.error(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "synthetic unsafe provenance"));
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            let source = std::error::Error::source(&error).unwrap()
                .downcast_ref::<std::io::Error>().unwrap();
            assert_eq!(source.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(source.raw_os_error(), None);
            assert_eq!(source.to_string(), "synthetic unsafe provenance");
        }
        #[test]
        fn deletion_requires_full_file_and_full_launch_identity() {
            let identity = FileIdentity { volume: 7, id: [8; 16], created: 9 };
            let expected = Record::new(42, 123, [1; 16], [2; 32]).unwrap();
            assert!(require_complete_record(identity, &expected, identity, &expected).is_ok());
            for changed in [FileIdentity { volume: 10, ..identity },
                FileIdentity { id: [11; 16], ..identity }, FileIdentity { created: 12, ..identity }] {
                assert!(require_complete_record(identity, &expected, changed, &expected).is_err());
            }
            for changed in [Record::new(43, 123, [1; 16], [2; 32]).unwrap(),
                Record::new(42, 124, [1; 16], [2; 32]).unwrap(),
                Record::new(42, 123, [3; 16], [2; 32]).unwrap(),
                Record::new(42, 123, [1; 16], [4; 32]).unwrap()] {
                assert!(require_complete_record(identity, &expected, identity, &changed).is_err());
            }
        }
    }

    struct Descriptor(*mut std::ffi::c_void);
    impl Descriptor {
        fn for_user(sid: PSID) -> io::Result<Self> {
            let mut text = null_mut();
            unsafe { checked(ConvertSidToStringSidW(sid, &mut text))?; }
            let _text_owner = SecuritySnapshot(text.cast());
            let mut length = 0;
            while length < 512 && unsafe { *text.add(length) } != 0 { length += 1; }
            if length == 512 { return Err(unsafe_record()); }
            let user = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| unsafe_record())?;
            let sddl = wide(std::ffi::OsStr::new(&format!("O:{user}D:P(A;;FA;;;{user})")))?;
            let mut descriptor = null_mut();
            unsafe { checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1,
                &mut descriptor, null_mut()))?; }
            Ok(Self(descriptor))
        }
        fn new() -> io::Result<Self> {
            let text = wide(std::ffi::OsStr::new("D:P(A;;GA;;;OW)"))?;
            let mut descriptor = null_mut();
            unsafe { checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()))?; }
            Ok(Self(descriptor))
        }
        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0, bInheritHandle: 0 }
        }
        fn dacl(&self) -> io::Result<*mut ACL> {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = null_mut();
            unsafe { checked(GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted))?; }
            if present == 0 || dacl.is_null() { return Err(io::Error::other("private file ACL missing")); }
            Ok(dacl)
        }
    }
    impl Drop for Descriptor { fn drop(&mut self) { unsafe { LocalFree(self.0) }; } }

    #[cfg(test)]
    mod launch_tests {
        use super::*;

        #[test]
        fn daemon_creation_suppresses_console_without_changing_ownership_flags() {
            assert_eq!(DAEMON_CREATION_FLAGS,
                CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT);
            assert_eq!(DAEMON_CREATION_FLAGS & (CREATE_NEW_CONSOLE | DETACHED_PROCESS), 0);
        }

        #[test]
        fn transfer_list_matches_fd3_bootstrap_and_excludes_parent_handles() {
            let (parent, child) = crate::app_channel::windows::channel_pair().unwrap();
            let log = File::open(std::env::current_exe().unwrap()).unwrap();
            let transfers = Transfers::new(&log, &child).unwrap();
            let handles = transfers.handles();
            assert_eq!(handles.len(), 4);
            assert!(!handles.contains(&child.as_raw_handle()));
            let bytes = transfers.bootstrap().unwrap();
            assert_eq!(&bytes[4..8], &[65, 1, 1, 9]);
            for (index, handle) in handles.iter().enumerate() {
                let start = 8 + index * std::mem::size_of::<usize>();
                assert_eq!(&bytes[start..start + std::mem::size_of::<usize>()], &(*handle as usize).to_ne_bytes());
            }
            for handle in handles {
                let mut flags = 0;
                assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
                assert_ne!(flags & HANDLE_FLAG_INHERIT, 0);
            }
            parent.shutdown().unwrap();
        }
    }
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
