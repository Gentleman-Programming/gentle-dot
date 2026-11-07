//! Current-user DPAPI persistence. No plaintext fallback or automatic recovery.
//! Same-user processes remain trusted; publication does not promise crash durability.

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use super::windows_codec::{decode, encode, filename};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::Cryptography::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_LocalAppData};

pub struct WindowsDpapiStore {
    // None resolves KnownFolder only during an operation, not during construction.
    root: Option<PathBuf>,
    service: String,
    #[cfg(test)]
    fail_before_publish: std::sync::atomic::AtomicBool,
}
impl WindowsDpapiStore {
    pub fn new() -> Self {
        Self { root: None, service: SERVICE.into(),
            #[cfg(test)] fail_before_publish: std::sync::atomic::AtomicBool::new(false) }
    }
    #[cfg(test)]
    fn with_root(root: PathBuf, service: String) -> Self {
        Self { root: Some(root), service,
            fail_before_publish: std::sync::atomic::AtomicBool::new(false) }
    }
    fn context(&self) -> Result<Context, StoreError> {
        let root = match &self.root { Some(root) => root.clone(), None => local_app_data()?.join(SERVICE) };
        Context::new(root, &self.service)
    }
}
impl std::fmt::Debug for WindowsDpapiStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WindowsDpapiStore(<redacted>)")
    }
}
impl SecretStore for WindowsDpapiStore {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        let name = filename(&self.service, id)?;
        let context = self.context()?;
        // Validate the old encrypted binding before encryption or any temporary write.
        // Classic FileRenameInfo replacement requires a closed destination, even
        // when its handle shares DELETE. Release the validated file and secret now;
        // context retains the pinned ancestry and exclusive namespace lock throughout.
        drop(context.decode(&name, Some(id))?);
        let plaintext = Plain(encode(&self.service, id, secret)?);
        let ciphertext = protect(&plaintext.0)?;
        drop(plaintext);
        let temporary = format!("tmp-{}.pending", random_name()?);
        let mut file = context.open(&temporary, GENERIC_READ | GENERIC_WRITE | DELETE,
            CREATE_NEW, FILE_SHARE_READ | FILE_SHARE_DELETE)?.ok_or_else(unsafe_store)?;
        // Errors here are known precommit. Handle-based deletion cannot target a replacement.
        let prepared = (|| {
            file.write_all(&ciphertext).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            #[cfg(test)]
            if self.fail_before_publish.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(failure("synthetic prepublication failure", 0));
            }
            rename_buffer(&context.directory.join(&name))
        })();
        let mut rename = match prepared {
            Ok(rename) => rename,
            Err(error) => {
                // Recheck provenance on the exact still-owned handle; if unsafe,
                // retain the temporary rather than deleting any uncertain identity.
                if context.validate_file(&file).is_ok() { let _ = mark_delete(file.as_raw_handle()); }
                return Err(error);
            }
        };
        // Exactly one native replacement call. Once submitted, never retry or delete
        // the temp/target: failure may be an uncertain publication. Successful return
        // is final success, independent of any later handle closure/cleanup result.
        context.validate_file(&file)?;
        let ok = unsafe { SetFileInformationByHandle(file.as_raw_handle(), FileRenameInfo,
            rename.words.as_mut_ptr().cast(), rename.bytes) };
        if ok == 0 { return Err(native_error("DPAPI publication outcome uncertain")); }
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let name = filename(&self.service, id)?;
        Ok(self.context()?.decode(&name, Some(id))?.map(|(_, _, value)| value))
    }
    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        let name = filename(&self.service, id)?;
        let context = self.context()?;
        // The very handle whose ciphertext/binding was validated performs deletion.
        match context.decode(&name, Some(id))? {
            Some((file, _, _)) => { context.validate_file(&file)?; mark_delete(file.as_raw_handle())?; Ok(true) }
            None => Ok(false),
        }
    }
    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let context = self.context()?;
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(&context.directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().into_string().map_err(|_| unsafe_store())?;
            if name == "namespace.lock" || temporary_name(&name) { continue; }
            if !committed_name(&name) { return Err(unsafe_store()); }
            let (_, id, _) = context.decode(&name, None)?.ok_or_else(unsafe_store)?;
            ids.push(id);
        }
        ids.sort(); ids.dedup(); Ok(ids)
    }
}

fn failure(message: &'static str, code: u32) -> StoreError {
    StoreError::Failed(format!("{message} (native {code})"))
}
fn unsafe_store() -> StoreError { failure("unsafe DPAPI store object", 0) }
fn native_error(message: &'static str) -> StoreError { failure(message, unsafe { GetLastError() }) }
fn io_error(error: std::io::Error) -> StoreError {
    failure("DPAPI file operation failed", error.raw_os_error().unwrap_or(0) as u32)
}
fn checked(ok: i32) -> Result<(), StoreError> {
    if ok == 0 { Err(native_error("DPAPI native operation failed")) } else { Ok(()) }
}
fn owned(raw: HANDLE) -> Result<OwnedHandle, StoreError> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE { return Err(native_error("DPAPI handle open failed")); }
    // SAFETY: freshly returned native handle has one RAII owner.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn wide(value: &OsStr) -> Result<Vec<u16>, StoreError> {
    let mut units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) { return Err(unsafe_store()); }
    units.push(0); Ok(units)
}
fn random_name() -> Result<String, StoreError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| failure("DPAPI randomness unavailable", 0))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn committed_name(name: &str) -> bool { name.strip_suffix(".bin").is_some_and(|s| hex(s, 64)) }
fn temporary_name(name: &str) -> bool {
    name.strip_prefix("tmp-").and_then(|s| s.strip_suffix(".pending")).is_some_and(|s| hex(s, 32))
}
struct Plain(Vec<u8>);
impl Drop for Plain { fn drop(&mut self) { wipe(&mut self.0); } }
struct LocalAllocation { pointer: *mut std::ffi::c_void, length: usize, plaintext: bool }
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            if self.plaintext && self.length != 0 {
                // SAFETY: DPAPI owns these bytes until LocalFree. Bounded chunks
                // also respect Rust's slice/isize limit on 32-bit Windows.
                let mut offset = 0;
                while offset < self.length {
                    let count = (self.length - offset).min(isize::MAX as usize);
                    unsafe { wipe(std::slice::from_raw_parts_mut(self.pointer.cast::<u8>().add(offset), count)); }
                    offset += count;
                }
            }
            unsafe { LocalFree(self.pointer); }
        }
    }
}
fn blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, StoreError> {
    Ok(CRYPT_INTEGER_BLOB { cbData: u32::try_from(bytes.len()).map_err(|_| unsafe_store())?,
        pbData: bytes.as_ptr() as *mut u8 })
}
fn copy_bytes(pointer: *const u8, length: usize) -> Result<Vec<u8>, StoreError> {
    if pointer.is_null() || length > isize::MAX as usize { return Err(unsafe_store()); }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| failure("DPAPI allocation failed", 0))?;
    // SAFETY: caller owns a native buffer of the documented length.
    bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(pointer, length) });
    Ok(bytes)
}
fn protect(bytes: &[u8]) -> Result<Vec<u8>, StoreError> {
    let input = blob(bytes)?;
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(),
        CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    let code = unsafe { GetLastError() };
    let allocation = LocalAllocation { pointer: output.pbData.cast(), length: output.cbData as usize, plaintext: false };
    if ok == 0 { return Err(failure("DPAPI encryption failed", code)); }
    copy_bytes(allocation.pointer.cast(), allocation.length)
}
fn unprotect(bytes: &[u8]) -> Result<Plain, StoreError> {
    let input = blob(bytes)?;
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let mut description = null_mut();
    let ok = unsafe { CryptUnprotectData(&input, &mut description, null(), null(), null(),
        CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    let code = unsafe { GetLastError() };
    // Install both owners immediately, even on API failure. Wipe native plaintext
    // before LocalFree and wipe the Rust copy on every decode/validation exit.
    let allocation = LocalAllocation { pointer: output.pbData.cast(), length: output.cbData as usize, plaintext: true };
    let _description = LocalAllocation { pointer: description.cast(), length: 0, plaintext: false };
    if ok == 0 { return Err(failure("DPAPI decryption failed", code)); }
    Ok(Plain(copy_bytes(allocation.pointer.cast(), allocation.length)?))
}
fn local_app_data() -> Result<PathBuf, StoreError> {
    let mut pointer = null_mut();
    // KF_FLAG_DONT_VERIFY avoids touching the folder during this resolution.
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0x4000, null_mut(), &mut pointer) };
    struct TaskMemory(*mut u16);
    impl Drop for TaskMemory { fn drop(&mut self) { unsafe { CoTaskMemFree(self.0.cast()); } } }
    let owner = TaskMemory(pointer);
    if result < 0 || owner.0.is_null() { return Err(failure("LocalAppData resolution failed", result as u32)); }
    let mut length = 0;
    while unsafe { *owner.0.add(length) } != 0 { length += 1; }
    let text = unsafe { std::slice::from_raw_parts(owner.0, length) };
    Ok(PathBuf::from(std::ffi::OsString::from_wide(text)))
}

struct Descriptor(LocalAllocation);
impl Descriptor {
    fn for_user(sid: PSID) -> Result<Self, StoreError> {
        let mut text = null_mut();
        checked(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
        let _owner = LocalAllocation { pointer: text.cast(), length: 0, plaintext: false };
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 { length += 1; }
        let user = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| unsafe_store())?;
        let sddl = wide(OsStr::new(&format!("O:{user}D:P(A;;FA;;;{user})")))?;
        let mut pointer = null_mut();
        checked(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),
            SDDL_REVISION_1, &mut pointer, null_mut()) })?;
        Ok(Self(LocalAllocation { pointer, length: 0, plaintext: false }))
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.pointer, bInheritHandle: 0 }
    }
}
fn current_sid() -> Result<Vec<usize>, StoreError> {
    let mut token = null_mut();
    checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut size = 0;
    let ok = unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    if ok != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        || size < std::mem::size_of::<TOKEN_USER>() as u32 { return Err(unsafe_store()); }
    let mut words = aligned(size as usize)?;
    checked(unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, words.as_mut_ptr().cast(), size, &mut size) })?;
    let sid = unsafe { (*words.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    if unsafe { IsValidSid(sid) } == 0 { return Err(unsafe_store()); }
    let size = unsafe { GetLengthSid(sid) };
    if size == 0 || size > SECURITY_MAX_SID_SIZE as u32 { return Err(unsafe_store()); }
    let mut copy = aligned(size as usize)?;
    checked(unsafe { CopySid(size, copy.as_mut_ptr().cast(), sid) })?;
    Ok(copy)
}
fn aligned(bytes: usize) -> Result<Vec<usize>, StoreError> {
    let count = bytes.checked_add(std::mem::size_of::<usize>() - 1).ok_or_else(unsafe_store)? / std::mem::size_of::<usize>();
    let mut words = Vec::new();
    words.try_reserve_exact(count).map_err(|_| failure("DPAPI allocation failed", 0))?;
    words.resize(count, 0); Ok(words)
}
fn security(handle: HANDLE, expected: PSID) -> Result<(), StoreError> {
    let mut owner = null_mut(); let mut acl = null_mut(); let mut descriptor = null_mut();
    let code = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, null_mut(), &mut acl, null_mut(), &mut descriptor) };
    let _owner = LocalAllocation { pointer: descriptor, length: 0, plaintext: false };
    if code != ERROR_SUCCESS { return Err(failure("DPAPI security query failed", code)); }
    let mut control = 0; let mut revision = 0;
    // GetSecurityInfo returns a self-contained native descriptor retained above.
    unsafe {
        if descriptor.is_null() || owner.is_null() || IsValidSid(owner) == 0 || EqualSid(owner, expected) == 0
            || acl.is_null() || IsValidAcl(acl) == 0
            || GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED as u16 == 0 || (*acl).AceCount != 1 { return Err(unsafe_store()); }
        let mut raw = null_mut(); checked(GetAce(acl, 0, &mut raw))?;
        if raw.is_null() { return Err(unsafe_store()); }
        let header = &*raw.cast::<ACE_HEADER>();
        let offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if header.AceType != 0 || header.AceFlags != 0 || (header.AceSize as usize) < offset + 8 { return Err(unsafe_store()); }
        let sid = raw.cast::<u8>().add(offset);
        let count = *sid.add(1) as usize;
        if count > 15 || header.AceSize as usize != offset + 8 + count * 4
            || IsValidSid(sid.cast()) == 0 || EqualSid(sid.cast(), expected) == 0
            || (*raw.cast::<ACCESS_ALLOWED_ACE>()).Mask != FILE_ALL_ACCESS { return Err(unsafe_store()); }
    }
    Ok(())
}
fn info(handle: HANDLE, directory: bool) -> Result<BY_HANDLE_FILE_INFORMATION, StoreError> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    checked(unsafe { GetFileInformationByHandle(handle, &mut info) })?;
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1) { return Err(unsafe_store()); }
    Ok(info)
}
struct Context {
    directory: PathBuf,
    service: String,
    sid: Vec<usize>,
    descriptor: Descriptor,
    _ancestors: Vec<OwnedHandle>,
    _lock: File,
}
impl Context {
    fn new(root: PathBuf, service: &str) -> Result<Self, StoreError> {
        if !root.is_absolute() { return Err(unsafe_store()); }
        let sid = current_sid()?;
        let expected = sid.as_ptr() as PSID;
        let descriptor = Descriptor::for_user(expected)?;
        let namespace = filename(service, "namespace")?;
        let directory = root.join(namespace.trim_end_matches(".bin"));
        // Reject unsupported volumes before creating any owned directory.
        let root_name = wide(directory.ancestors().last().ok_or_else(unsafe_store)?.as_os_str())?;
        if unsafe { GetDriveTypeW(root_name.as_ptr()) } != 3 { return Err(unsafe_store()); }
        let mut fs = [0u16; 32];
        checked(unsafe { GetVolumeInformationW(root_name.as_ptr(), null_mut(), 0, null_mut(), null_mut(), null_mut(), fs.as_mut_ptr(), fs.len() as u32) })?;
        if &fs[..5] != [78, 84, 70, 83, 0] { return Err(unsafe_store()); }
        let mut guards = Vec::new();
        let mut prefix = PathBuf::new();
        for component in directory.components() {
            match component {
                Component::Prefix(p) => match p.kind() {
                    std::path::Prefix::Disk(_) => { prefix.push(p.as_os_str()); continue; }
                    _ => return Err(unsafe_store()),
                },
                Component::RootDir => prefix.push(component.as_os_str()),
                Component::Normal(name) => {
                    let units: Vec<u16> = name.encode_wide().collect();
                    if units.is_empty() || units.iter().any(|u| *u < 32 || [58, 47, 42, 63, 34, 60, 62, 124].contains(u))
                        || matches!(units.last(), Some(32 | 46)) { return Err(unsafe_store()); }
                    prefix.push(name);
                }
                _ => return Err(unsafe_store()),
            }
            let name = wide(prefix.as_os_str())?;
            let private = prefix == root || prefix == directory;
            if private && unsafe { CreateDirectoryW(name.as_ptr(), &descriptor.attributes()) } == 0 {
                let code = unsafe { GetLastError() };
                if code != ERROR_ALREADY_EXISTS { return Err(failure("DPAPI directory creation failed", code)); }
            }
            // No delete sharing pins every directory. Drive/profile ancestors need
            // not have private DACLs; only our root and namespace do. Write sharing
            // permits ordinary directory use without allowing ancestor rename/delete.
            let guard = owned(unsafe { CreateFileW(name.as_ptr(), FILE_READ_ATTRIBUTES | if private { READ_CONTROL } else { 0 },
                FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
            info(guard.as_raw_handle(), true)?;
            if private { security(guard.as_raw_handle(), expected)?; }
            guards.push(guard);
        }
        let lock_name = wide(directory.join("namespace.lock").as_os_str())?;
        let mut raw = unsafe { CreateFileW(lock_name.as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            0, &descriptor.attributes(), CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if code != ERROR_FILE_EXISTS && code != ERROR_ALREADY_EXISTS { return Err(failure("DPAPI namespace lock unavailable", code)); }
            raw = unsafe { CreateFileW(lock_name.as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                0, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        }
        // One nonblocking attempt: contention fails closed and never removes the lock.
        let lock = File::from(owned(raw)?);
        info(lock.as_raw_handle(), false)?;
        security(lock.as_raw_handle(), expected)?;
        Ok(Self { directory, service: service.into(), sid, descriptor, _ancestors: guards, _lock: lock })
    }
    fn open(&self, name: &str, access: u32, disposition: u32, share: u32) -> Result<Option<File>, StoreError> {
        if !committed_name(name) && !temporary_name(name) { return Err(unsafe_store()); }
        let path = wide(self.directory.join(name).as_os_str())?;
        let raw = unsafe { CreateFileW(path.as_ptr(), access | READ_CONTROL, share,
            &self.descriptor.attributes(), disposition, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if disposition == OPEN_EXISTING && code == ERROR_FILE_NOT_FOUND { return Ok(None); }
            return Err(failure("DPAPI secret file open failed", code));
        }
        let file = File::from(owned(raw)?);
        self.validate_file(&file)?;
        Ok(Some(file))
    }
    fn validate_file(&self, file: &File) -> Result<(), StoreError> {
        info(file.as_raw_handle(), false)?;
        security(file.as_raw_handle(), self.sid.as_ptr() as PSID)
    }
    fn read(&self, name: &str) -> Result<Option<(File, Vec<u8>)>, StoreError> {
        let Some(mut file) = self.open(name, GENERIC_READ | DELETE, OPEN_EXISTING, FILE_SHARE_READ | FILE_SHARE_DELETE)? else { return Ok(None); };
        let before = info(file.as_raw_handle(), false)?;
        let length = ((before.nFileSizeHigh as u64) << 32) | before.nFileSizeLow as u64;
        // DPAPI's native input bound, not a small product cap. Read exactly the
        // queried length without unbounded read_to_end growth on concurrent mutation.
        let length = usize::try_from(u32::try_from(length).map_err(|_| unsafe_store())?).map_err(|_| unsafe_store())?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| failure("DPAPI allocation failed", 0))?;
        bytes.resize(length, 0);
        file.read_exact(&mut bytes).map_err(io_error)?;
        let after = info(file.as_raw_handle(), false)?;
        if before.nFileSizeHigh != after.nFileSizeHigh || before.nFileSizeLow != after.nFileSizeLow { return Err(unsafe_store()); }
        Ok(Some((file, bytes)))
    }
    fn decode(&self, name: &str, expected: Option<&str>) -> Result<Option<(File, String, Secret)>, StoreError> {
        let Some((file, bytes)) = self.read(name)? else { return Ok(None); };
        let plaintext = unprotect(&bytes)?;
        let (id, value) = decode(&self.service, &plaintext.0)?;
        if expected.is_some_and(|expected| expected != id) || filename(&self.service, &id)? != name { return Err(unsafe_store()); }
        Ok(Some((file, id, value)))
    }
    #[cfg(test)]
    fn delete_owned_name(&self, name: &str, expected: &BY_HANDLE_FILE_INFORMATION) -> Result<(), StoreError> {
        let file = self.open(name, DELETE, OPEN_EXISTING, FILE_SHARE_READ | FILE_SHARE_DELETE)?.ok_or_else(unsafe_store)?;
        let observed = info(file.as_raw_handle(), false)?;
        if observed.dwVolumeSerialNumber != expected.dwVolumeSerialNumber
            || observed.nFileIndexHigh != expected.nFileIndexHigh || observed.nFileIndexLow != expected.nFileIndexLow
            || observed.ftCreationTime.dwHighDateTime != expected.ftCreationTime.dwHighDateTime
            || observed.ftCreationTime.dwLowDateTime != expected.ftCreationTime.dwLowDateTime { return Err(unsafe_store()); }
        mark_delete(file.as_raw_handle())
    }
}
fn mark_delete(handle: HANDLE) -> Result<(), StoreError> {
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    checked(unsafe { SetFileInformationByHandle(handle, FileDispositionInfo,
        (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(), std::mem::size_of_val(&disposition) as u32) })
}
struct RenameBuffer { words: Vec<usize>, bytes: u32 }
fn rename_buffer(path: &Path) -> Result<RenameBuffer, StoreError> {
    let name = wide(path.as_os_str())?;
    let units = &name[..name.len() - 1];
    let name_bytes = units.len().checked_mul(2).ok_or_else(unsafe_store)?;
    let storage_bytes = name.len().checked_mul(2).ok_or_else(unsafe_store)?;
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let bytes = offset.checked_add(storage_bytes).ok_or_else(unsafe_store)?.max(std::mem::size_of::<FILE_RENAME_INFO>());
    let bytes = u32::try_from(bytes).map_err(|_| unsafe_store())?;
    let mut words = aligned(bytes as usize)?;
    // Aligned FILE_RENAME_INFO plus its NUL-terminated UTF-16 tail. The submitted
    // bytes include the NUL; FileNameLength excludes it. RootDirectory is null
    // because the target is an absolute path.
    unsafe {
        let header = words.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        (*header).Anonymous.ReplaceIfExists = true;
        (*header).RootDirectory = null_mut();
        (*header).FileNameLength = u32::try_from(name_bytes).map_err(|_| unsafe_store())?;
        std::ptr::copy_nonoverlapping(name.as_ptr(), words.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(), name.len());
    }
    Ok(RenameBuffer { words, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Structural regression only: this does not establish the cause of a native
    // publication error. No filesystem operation or native rename is performed.
    fn assert_rename_buffer_terminated(alignment_padding: bool) {
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let word_bytes = std::mem::size_of::<usize>();
        let path = (0..word_bytes / 2).map(|extra| {
            PathBuf::from(format!("C:\\synthetic-✓界🦀\\{}.bin", "a".repeat(32 + extra)))
        }).find(|path| {
            let end = offset + path.as_os_str().encode_wide().count() * 2;
            end % word_bytes == if alignment_padding { word_bytes - 2 } else { 0 }
        }).expect("one UTF-16 length must cover the requested alignment case");
        assert!(path.is_absolute());
        let expected: Vec<u16> = path.as_os_str().encode_wide().collect();
        let name_bytes = expected.len() * 2;
        let name_end = offset + name_bytes;
        let required_bytes = name_end + 2;
        let rename = rename_buffer(&path).unwrap();
        // Use initialized Vec length, not allocator capacity: spare allocation
        // is neither initialized storage nor part of the declared native buffer.
        let storage_bytes = rename.words.len() * word_bytes;
        assert!(storage_bytes >= std::mem::size_of::<FILE_RENAME_INFO>());
        // SAFETY: aligned words contain a complete initialized header above.
        let header = unsafe { &*rename.words.as_ptr().cast::<FILE_RENAME_INFO>() };
        assert!(unsafe { header.Anonymous.ReplaceIfExists });
        assert!(header.RootDirectory.is_null());
        assert_eq!(header.FileNameLength as usize, name_bytes,
            "FileNameLength must exclude the UTF-16 NUL");
        assert!(storage_bytes >= required_bytes,
            "initialized storage must include the UTF-16 NUL (alignment padding: {alignment_padding})");
        assert!(rename.bytes as usize >= required_bytes,
            "declared native bytes must include the UTF-16 NUL even when alignment padding is zero-filled");
        assert!(rename.bytes as usize <= storage_bytes);
        // SAFETY: both declared bytes and initialized storage cover the name and
        // terminator before constructing this slice; its offset is u16-aligned.
        let actual = unsafe { std::slice::from_raw_parts(
            rename.words.as_ptr().cast::<u8>().add(offset).cast::<u16>(), expected.len() + 1) };
        assert_eq!(&actual[..expected.len()], expected.as_slice(),
            "absolute Unicode filename must be copied exactly");
        assert_eq!(actual[expected.len()], 0, "explicit trailing UTF-16 NUL required");
    }

    #[test]
    fn rename_buffer_terminator_without_alignment_padding() {
        assert_rename_buffer_terminated(false);
    }

    #[test]
    fn rename_buffer_terminator_with_alignment_padding() {
        assert_rename_buffer_terminated(true);
    }

    #[test]
    #[ignore = "explicit Windows native ACL rejection test; synthetic private root only"]
    fn existing_unprotected_acl_is_rejected_without_repair() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-acl-{token}"));
        let store = WindowsDpapiStore::with_root(root.clone(), format!("synthetic-{token}"));
        drop(store.context().unwrap());
        let path = wide(root.as_os_str()).unwrap();
        let handle = owned(unsafe { CreateFileW(path.as_ptr(), WRITE_DAC | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }).unwrap();
        let sid = current_sid().unwrap();
        let descriptor = Descriptor::for_user(sid.as_ptr() as PSID).unwrap();
        let mut present = 0; let mut defaulted = 0; let mut acl = null_mut();
        checked(unsafe { GetSecurityDescriptorDacl(descriptor.0.pointer, &mut present, &mut acl, &mut defaulted) }).unwrap();
        assert_ne!(present, 0);
        let code = unsafe { SetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(), null_mut(), acl, null_mut()) };
        assert_eq!(code, ERROR_SUCCESS);
        drop(handle);
        assert!(store.get("synthetic").is_err());
        // Deliberately retain this now-untrusted fixture; no repair or deletion.
    }

    #[test]
    #[ignore = "explicit Windows native reparse test; requires symlink permission/developer mode"]
    fn reparse_root_is_rejected() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-target-{token}"));
        let target = WindowsDpapiStore::with_root(root.clone(), format!("synthetic-{token}"));
        drop(target.context().unwrap());
        let link = std::env::temp_dir().join(format!("gentle-dpapi-link-{token}"));
        let name = wide(link.as_os_str()).unwrap();
        let destination = wide(root.as_os_str()).unwrap();
        assert_ne!(unsafe { CreateSymbolicLinkW(name.as_ptr(), destination.as_ptr(),
            SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) } as u8, 0);
        let store = WindowsDpapiStore::with_root(link, format!("synthetic-{token}"));
        assert!(store.get("synthetic").is_err());
        // Link and target retained: no uncertain pathname cleanup.
    }

    #[test]
    #[ignore = "child of cross_process_namespace_lock only; synthetic namespace"]
    fn namespace_lock_child() {
        let token = std::env::var("GENTLE_DPAPI_TEST_TOKEN").expect("parent test token required");
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        let root = std::env::temp_dir().join(format!("gentle-dpapi-cross-{token}"));
        assert!(root.is_dir());
        let store = WindowsDpapiStore::with_root(root, format!("synthetic-{token}"));
        match std::env::var("GENTLE_DPAPI_TEST_PHASE").unwrap().as_str() {
            "locked" => {
                assert!(store.get("value").is_err());
                assert!(store.put("other", &Secret::new("synthetic child")).is_err());
                assert!(store.delete("value").is_err());
                assert!(store.list_ids().is_err());
            }
            "released" => {
                assert_eq!(store.get("value").unwrap().unwrap().expose(), "synthetic parent");
                store.put("other", &Secret::new("synthetic child")).unwrap();
            }
            _ => panic!("invalid synthetic phase"),
        }
    }

    #[test]
    #[ignore = "explicit Windows cross-process lock test; fresh synthetic namespace"]
    fn cross_process_namespace_lock() {
        use std::os::windows::process::CommandExt;
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-cross-{token}"));
        let store = WindowsDpapiStore::with_root(root, format!("synthetic-{token}"));
        store.put("value", &Secret::new("synthetic parent")).unwrap();
        let run_child = |phase: &str| {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["secure_store::windows::tests::namespace_lock_child", "--exact", "--ignored"])
                .env("GENTLE_DPAPI_TEST_TOKEN", &token).env("GENTLE_DPAPI_TEST_PHASE", phase)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::inherit()).creation_flags(CREATE_NO_WINDOW)
                .spawn().unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "synthetic child failed: {status}");
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("synthetic child timeout");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        let held = store.context().unwrap();
        run_child("locked");
        drop(held);
        assert_eq!(store.list_ids().unwrap(), vec!["value"]);
        assert_eq!(store.get("value").unwrap().unwrap().expose(), "synthetic parent");
        run_child("released");
        assert_eq!(store.list_ids().unwrap(), vec!["other", "value"]);
        assert_eq!(store.get("other").unwrap().unwrap().expose(), "synthetic child");
        assert!(store.delete("other").unwrap());
        assert!(store.delete("value").unwrap());
    }

    #[test]
    #[ignore = "explicit Windows hardlink rejection test; retained synthetic fixtures"]
    fn hardlinked_secret_is_rejected_without_mutation() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-hardlink-{token}"));
        let service = format!("synthetic-{token}");
        let store = WindowsDpapiStore::with_root(root, service.clone());
        store.put("value", &Secret::new("synthetic original")).unwrap();
        let context = store.context().unwrap();
        let original = context.directory.join(filename(&service, "value").unwrap());
        let alias = context.directory.join(filename(&service, "alias").unwrap());
        let before = std::fs::read(&original).unwrap();
        std::fs::hard_link(&original, &alias).unwrap();
        drop(context);
        assert!(store.get("value").is_err());
        assert!(store.put("value", &Secret::new("synthetic replacement")).is_err());
        assert!(store.delete("value").is_err());
        assert!(store.list_ids().is_err());
        assert_eq!(std::fs::read(&original).unwrap(), before);
        assert_eq!(std::fs::read(&alias).unwrap(), before);
        // Retain the deliberately unsafe fixture; do not relax admission to clean it.
    }

    #[test]
    #[ignore = "explicit Windows submitted-rename failure test; retained synthetic ciphertext"]
    fn failed_submitted_rename_retains_pending_ciphertext() {
        use std::os::windows::fs::OpenOptionsExt;
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-publish-{token}"));
        let service = format!("synthetic-{token}");
        let store = WindowsDpapiStore::with_root(root, service.clone());
        store.put("value", &Secret::new("synthetic original")).unwrap();
        let context = store.context().unwrap();
        let directory = context.directory.clone();
        let target = directory.join(filename(&service, "value").unwrap());
        drop(context);
        let names = || {
            let mut names: Vec<_> = std::fs::read_dir(&directory).unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            names.sort(); names
        };
        let before = names();
        let original = std::fs::read(&target).unwrap();
        // Classic rename cannot replace this open destination. DELETE sharing still
        // allows the store's admission reads, so failure occurs at publication.
        let held = std::fs::OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).open(&target).unwrap();
        let error = store.put("value", &Secret::new("synthetic replacement")).unwrap_err();
        assert!(matches!(error, StoreError::Failed(ref message)
            if message.starts_with("DPAPI publication outcome uncertain (native ")));
        let after = names();
        let added: Vec<_> = after.iter().filter(|name| !before.contains(name)).collect();
        assert_eq!(added.len(), 1); // retained single attempt, not retry/cleanup
        assert!(temporary_name(added[0]));
        assert!(before.iter().all(|name| after.contains(name)));
        assert_eq!(std::fs::read(&target).unwrap(), original);
        drop(held);
        assert_eq!(store.get("value").unwrap().unwrap().expose(), "synthetic original");
        // This observed failure preserves the target; it is not a universal rollback guarantee.
    }

    #[test]
    #[ignore = "explicit synthetic LocalAppData publication check; never uses the production store"]
    fn isolated_local_app_data_publication() {
        let token = random_name().unwrap();
        let root = local_app_data().unwrap().join(format!("gentle-dot-publication-test-{token}"));
        assert!(!root.exists(), "synthetic root must be new");
        let service = format!("synthetic-publication-{token}");
        let store = WindowsDpapiStore::with_root(root.clone(), service.clone());
        println!("SYNTHETIC_ROOT {}", root.display());
        store.put("integrity-key", &Secret::new("synthetic-first-value")).unwrap();
        let second = WindowsDpapiStore::with_root(root, service);
        assert_eq!(second.get("integrity-key").unwrap().unwrap().expose(), "synthetic-first-value");
        println!("SYNTHETIC_CREATE_READBACK_OK");
        second.put("integrity-key", &Secret::new("synthetic-replacement-value")).unwrap();
        assert_eq!(store.get("integrity-key").unwrap().unwrap().expose(), "synthetic-replacement-value");
        println!("SYNTHETIC_REPLACE_READBACK_OK");
        // Retain synthetic ciphertext as evidence; no cleanup or retry on any failure.
    }

    #[test]
    #[ignore = "explicit Windows native synthetic test; never uses the production namespace"]
    fn isolated_native_contract() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-{token}"));
        let service = format!("synthetic-{token}");
        let store = WindowsDpapiStore::with_root(root.clone(), service.clone());
        assert_eq!(store.put("bad id", &Secret::new("synthetic")), Err(StoreError::InvalidId));
        assert_eq!(store.get("bad id").unwrap_err(), StoreError::InvalidId);
        assert_eq!(store.delete("bad id").unwrap_err(), StoreError::InvalidId);
        assert!(!root.exists());
        super::super::check_contract(&store);
        let large = format!("{{\"token\":\"{}\"}}", "synthetic-✓界".repeat(1024));
        store.put("large", &Secret::new(large.clone())).unwrap();
        let second = WindowsDpapiStore::with_root(root.clone(), service.clone());
        assert_eq!(second.get("large").unwrap().unwrap().expose(), large);
        // Both instances must release their validation handles before replacement.
        second.put("large", &Secret::new("synthetic replacement")).unwrap();
        assert_eq!(store.get("large").unwrap().unwrap().expose(), "synthetic replacement");
        store.put("large", &Secret::new(large.clone())).unwrap();
        assert_eq!(second.get("large").unwrap().unwrap().expose(), large);
        second.put("independent", &Secret::new("second instance")).unwrap();
        assert_eq!(store.list_ids().unwrap(), vec!["independent", "large"]);
        let held = store.context().unwrap();
        assert!(second.get("large").is_err()); // bounded fail-closed lock contention
        drop(held);
        store.fail_before_publish.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(store.put("large", &Secret::new("replacement")).is_err());
        store.fail_before_publish.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(second.get("large").unwrap().unwrap().expose(), large);

        // Swap ciphertext through validated, independently owned native handles.
        // Retain fixtures on any assertion failure; never recursively clean an uncertain path.
        let context = store.context().unwrap();
        let a = filename(&service, "large").unwrap();
        let b = filename(&service, "independent").unwrap();
        let bytes = context.read(&a).unwrap().unwrap().1;
        let (original, _, _) = context.decode(&b, Some("independent")).unwrap().unwrap();
        let identity = info(original.as_raw_handle(), false).unwrap();
        drop(original);
        let mut target = context.open(&b, GENERIC_WRITE, OPEN_EXISTING, FILE_SHARE_READ | FILE_SHARE_DELETE).unwrap().unwrap();
        target.set_len(0).unwrap();
        target.write_all(&bytes).unwrap();
        target.flush().unwrap();
        drop(target);
        assert!(context.decode(&b, None).is_err());
        // Corruption is refused too; cleanup uses the exact validated native handle.
        let mut target = context.open(&b, GENERIC_WRITE, OPEN_EXISTING, FILE_SHARE_READ | FILE_SHARE_DELETE).unwrap().unwrap();
        target.set_len(0).unwrap();
        target.write_all(b"synthetic corruption").unwrap();
        target.flush().unwrap();
        drop(target);
        assert!(context.decode(&b, None).is_err());
        context.delete_owned_name(&b, &identity).unwrap();
        drop(context);
        assert!(store.delete("large").unwrap());
        assert!(store.list_ids().unwrap().is_empty());
        // Leave the unique private directories and persistent lock file in place.
        // They contain no secrets and are deliberately not a recursive cleanup target.
    }
}
