//! Current-user DPAPI persistence. No plaintext fallback or automatic recovery.
//! Same-user processes remain trusted; publication does not promise crash durability.

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use super::windows_codec::{decode, encode, filename};
use super::windows_legacy::{self as legacy, RECEIPT_ID, RECEIPT_NAME};
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
    fn publication_failure(&self) -> bool {
        #[cfg(test)]
        return self.fail_before_publish.load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        false
    }

    // All public operations hold the namespace lock through migration and their own
    // work. A pending receipt gates mutations, even after a partially published import.
    fn migrate(&self, context: &Context) -> Result<(), StoreError> {
        let prior = context.read_receipt()?;
        if let Some(value) = &prior {
            if legacy::receipt(value.expose())?.0 { return Ok(()); }
        }
        let directory = match &self.root {
            // Fixture-only legacy directory; never resolve a real profile in tests.
            Some(root) => root.join("legacy"),
            None => {
                let root = match std::env::var_os("LOCALAPPDATA") {
                    Some(value) => PathBuf::from(value),
                    None => local_app_data()?,
                };
                root.join("Gentle Dot")
            }
        };
        let snapshot = context.legacy_snapshot(&directory)?;
        let identity = legacy::snapshot(snapshot.bytes.as_deref());
        if let Some(value) = &prior {
            if legacy::receipt(value.expose())?.1 != identity { return Err(legacy::invalid()); }
        }
        let mut values = Vec::new();
        if let Some(bytes) = &snapshot.bytes {
            // Preflight ALL counts/encoded lengths/ciphertext budgets before any
            // base64 decode or DPAPI call. Retained plaintext has a separate budget.
            let entries = legacy::parse(bytes)?;
            values.try_reserve_exact(entries.len()).map_err(|_| legacy::invalid())?;
            let mut remaining = legacy::MAX_LEGACY_PLAINTEXT_BYTES;
            for (id, encrypted) in entries {
                let plain = unprotect_legacy(&encrypted, id.as_bytes(), remaining)?;
                remaining = legacy::plaintext_remaining(remaining, plain.0.len())?;
                let text = std::str::from_utf8(&plain.0).map_err(|_| StoreError::NotText)?;
                let mut owned = String::new();
                owned.try_reserve_exact(text.len()).map_err(|_| legacy::invalid())?;
                owned.push_str(text);
                let secret = Secret::new(owned);
                drop(plain);
                drop(Plain(encode(&self.service, &id, &secret)?));
                let name = filename(&self.service, &id)?;
                let existing = context.decode(&name, Some(&id))?;
                let missing = match existing {
                    Some((_, _, old)) if old.expose() == secret.expose() => false,
                    Some(_) => return Err(legacy::invalid()),
                    None => true,
                };
                values.push((id, name, secret, missing));
            }
        }
        // Unknown names or unrelated corrupt upstream objects must not be hidden by
        // a successful import. Never repair or overwrite an inadmissible namespace.
        context.validate_namespace()?;
        if snapshot.bytes.is_some() && prior.is_none() {
            context.publish_receipt(&format!("pending:{identity}"), false, self.publication_failure())?;
        }
        for (id, name, secret, missing) in values {
            if missing {
                context.publish_secret(&name, &id, &secret, false, self.publication_failure())?;
            }
        }
        // Legacy file and directory handles stay pinned, with no write/delete sharing,
        // until completion. Completion is the only permission for ordinary mutations.
        context.publish_receipt(&format!("complete:{identity}"),
            snapshot.bytes.is_some() || prior.is_some(), self.publication_failure())
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
        self.migrate(&context)?;
        // Release the validated destination before classic FileRenameInfo replacement.
        drop(context.decode(&name, Some(id))?);
        context.publish_secret(&name, id, secret, true, self.publication_failure())
    }
    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let name = filename(&self.service, id)?;
        let context = self.context()?;
        self.migrate(&context)?;
        Ok(context.decode(&name, Some(id))?.map(|(_, _, value)| value))
    }
    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        let name = filename(&self.service, id)?;
        let context = self.context()?;
        self.migrate(&context)?;
        // The very handle whose ciphertext/binding was validated performs deletion.
        match context.decode(&name, Some(id))? {
            Some((file, _, _)) => { context.validate_file(&file)?; mark_delete(file.as_raw_handle())?; Ok(true) }
            None => Ok(false),
        }
    }
    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let context = self.context()?;
        self.migrate(&context)?;
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(&context.directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().into_string().map_err(|_| unsafe_store())?;
            // migrate() has strictly validated the encrypted internal receipt.
            if name == "namespace.lock" || name == RECEIPT_NAME || temporary_name(&name) { continue; }
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
    protect_entropy(bytes, None)
}
fn protect_entropy(bytes: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, StoreError> {
    let input = blob(bytes)?;
    let entropy = entropy.map(blob).transpose()?;
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe { CryptProtectData(&input, null(),
        entropy.as_ref().map_or(null(), |value| value as *const _), null(), null(),
        CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    let code = unsafe { GetLastError() };
    let allocation = LocalAllocation { pointer: output.pbData.cast(), length: output.cbData as usize, plaintext: false };
    if ok == 0 { return Err(failure("DPAPI encryption failed", code)); }
    copy_bytes(allocation.pointer.cast(), allocation.length)
}
fn unprotect(bytes: &[u8]) -> Result<Plain, StoreError> {
    unprotect_entropy(bytes, None)
}
fn unprotect_legacy(bytes: &[u8], id: &[u8], remaining: usize) -> Result<Plain, StoreError> {
    if bytes.is_empty() || bytes.len() > legacy::MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY {
        return Err(legacy::invalid());
    }
    legacy::plaintext_remaining(remaining, 0)?;
    unprotect_bounded(bytes, Some(id), Some(remaining))
}
fn unprotect_entropy(bytes: &[u8], entropy: Option<&[u8]>) -> Result<Plain, StoreError> {
    unprotect_bounded(bytes, entropy, None)
}
fn unprotect_bounded(bytes: &[u8], entropy: Option<&[u8]>, limit: Option<usize>) -> Result<Plain, StoreError> {
    let input = blob(bytes)?;
    let entropy = entropy.map(blob).transpose()?;
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let mut description = null_mut();
    let ok = unsafe { CryptUnprotectData(&input, &mut description,
        entropy.as_ref().map_or(null(), |value| value as *const _), null(), null(),
        CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    let code = unsafe { GetLastError() };
    // Install both owners immediately, even on API failure. Wipe native plaintext
    // before LocalFree and wipe the Rust copy on every decode/validation exit.
    let allocation = LocalAllocation { pointer: output.pbData.cast(), length: output.cbData as usize, plaintext: true };
    let _description = LocalAllocation { pointer: description.cast(), length: 0, plaintext: false };
    if ok == 0 { return Err(failure("DPAPI decryption failed", code)); }
    // DPAPI allocates its own output: ciphertext admission bounds our input, not
    // Windows' internal allocator. Validate cbData BEFORE any Rust reserve/copy;
    // the installed native owner still wipes/frees oversized output on this exit.
    if let Some(remaining) = limit { legacy::plaintext_remaining(remaining, allocation.length)?; }
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
fn local_ntfs(directory: &Path) -> Result<(), StoreError> {
    let root_name = wide(directory.ancestors().last().ok_or_else(unsafe_store)?.as_os_str())?;
    if unsafe { GetDriveTypeW(root_name.as_ptr()) } != 3 { return Err(unsafe_store()); }
    let mut fs = [0u16; 32];
    checked(unsafe { GetVolumeInformationW(root_name.as_ptr(), null_mut(), 0, null_mut(), null_mut(), null_mut(), fs.as_mut_ptr(), fs.len() as u32) })?;
    if &fs[..5] != [78, 84, 70, 83, 0] { return Err(unsafe_store()); }
    Ok(())
}
// True only for the drive prefix: the root directory itself must still be pinned.
fn append_component(prefix: &mut PathBuf, component: Component<'_>) -> Result<bool, StoreError> {
    match component {
        Component::Prefix(p) => match p.kind() {
            std::path::Prefix::Disk(_) => { prefix.push(p.as_os_str()); return Ok(true); }
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
    Ok(false)
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
        local_ntfs(&directory)?;
        let mut guards = Vec::new();
        let mut prefix = PathBuf::new();
        for component in directory.components() {
            if append_component(&mut prefix, component)? { continue; }
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
        if !committed_name(name) && !temporary_name(name) && name != RECEIPT_NAME { return Err(unsafe_store()); }
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
    fn legacy_snapshot(&self, directory: &Path) -> Result<LegacySnapshot, StoreError> {
        if !directory.is_absolute() { return Err(unsafe_store()); }
        local_ntfs(directory)?;
        let mut directories = Vec::new();
        let mut prefix = PathBuf::new();
        for component in directory.components() {
            if append_component(&mut prefix, component)? { continue; }
            let path = wide(prefix.as_os_str())?;
            let raw = unsafe { CreateFileW(path.as_ptr(),
                FILE_READ_ATTRIBUTES | if prefix == directory { READ_CONTROL } else { 0 },
                FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            if raw == INVALID_HANDLE_VALUE {
                let code = unsafe { GetLastError() };
                if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
                    return Ok(LegacySnapshot { bytes: None, _directories: directories, _file: None });
                }
                return Err(failure("legacy DPAPI directory open failed", code));
            }
            let guard = owned(raw)?;
            info(guard.as_raw_handle(), true)?;
            if prefix == directory { legacy_owner(guard.as_raw_handle(), self.sid.as_ptr() as PSID)?; }
            directories.push(guard);
        }
        let path = wide(directory.join("secrets.dat").as_os_str())?;
        let raw = unsafe { CreateFileW(path.as_ptr(), GENERIC_READ | READ_CONTROL,
            FILE_SHARE_READ, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if code == ERROR_FILE_NOT_FOUND {
                return Ok(LegacySnapshot { bytes: None, _directories: directories, _file: None });
            }
            return Err(failure("legacy DPAPI snapshot open failed", code));
        }
        let mut file = File::from(owned(raw)?);
        info(file.as_raw_handle(), false)?;
        legacy_owner(file.as_raw_handle(), self.sid.as_ptr() as PSID)?;
        let bytes = read_bounded_limit(&mut file, Some(legacy::MAX_LEGACY_SNAPSHOT_BYTES))?;
        Ok(LegacySnapshot { bytes: Some(bytes), _directories: directories, _file: Some(file) })
    }
    fn publish_secret(&self, name: &str, id: &str, secret: &Secret, replace: bool, fail: bool) -> Result<(), StoreError> {
        let plaintext = Plain(encode(&self.service, id, secret)?);
        let ciphertext = protect(&plaintext.0)?;
        drop(plaintext);
        self.publish(name, &ciphertext, replace, fail)
    }
    fn read_receipt(&self) -> Result<Option<Secret>, StoreError> {
        let Some((_file, bytes)) = self.read(RECEIPT_NAME)? else { return Ok(None); };
        let plaintext = unprotect(&bytes)?;
        let (id, value) = decode(&legacy::receipt_service(&self.service), &plaintext.0)?;
        if id != RECEIPT_ID { return Err(legacy::invalid()); }
        legacy::receipt(value.expose())?;
        Ok(Some(value))
    }
    fn publish_receipt(&self, value: &str, replace: bool, fail: bool) -> Result<(), StoreError> {
        legacy::receipt(value)?;
        // Same envelope, native encryption, ACL admission, and publication as secrets;
        // the domain-separated service keeps this internal object out of the ID space.
        let plaintext = Plain(encode(&legacy::receipt_service(&self.service), RECEIPT_ID, &Secret::new(value))?);
        let ciphertext = protect(&plaintext.0)?;
        drop(plaintext);
        self.publish(RECEIPT_NAME, &ciphertext, replace, fail)
    }
    fn validate_namespace(&self) -> Result<(), StoreError> {
        for entry in std::fs::read_dir(&self.directory).map_err(io_error)? {
            let name = entry.map_err(io_error)?.file_name().into_string().map_err(|_| unsafe_store())?;
            if name == "namespace.lock" || temporary_name(&name) { continue; }
            if name == RECEIPT_NAME { self.read_receipt()?.ok_or_else(unsafe_store)?; continue; }
            if !committed_name(&name) { return Err(unsafe_store()); }
            drop(self.decode(&name, None)?.ok_or_else(unsafe_store)?);
        }
        Ok(())
    }
    fn publish(&self, name: &str, ciphertext: &[u8], replace: bool, fail: bool) -> Result<(), StoreError> {
        if !committed_name(name) && name != RECEIPT_NAME { return Err(unsafe_store()); }
        let temporary = format!("tmp-{}.pending", random_name()?);
        let mut file = self.open(&temporary, GENERIC_READ | GENERIC_WRITE | DELETE,
            CREATE_NEW, FILE_SHARE_READ | FILE_SHARE_DELETE)?.ok_or_else(unsafe_store)?;
        let prepared = (|| {
            file.write_all(ciphertext).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            if fail { return Err(failure("synthetic prepublication failure", 0)); }
            let mut rename = rename_buffer(&self.directory.join(name))?;
            // Imports never replace existing encrypted secrets. Only explicit put
            // and the validated pending -> complete transition permit replacement.
            unsafe { (*rename.words.as_mut_ptr().cast::<FILE_RENAME_INFO>()).Anonymous.ReplaceIfExists = replace; }
            Ok(rename)
        })();
        let mut rename = match prepared {
            Ok(rename) => rename,
            Err(error) => {
                if self.validate_file(&file).is_ok() { let _ = mark_delete(file.as_raw_handle()); }
                return Err(error);
            }
        };
        // One native attempt, no retry or pathname cleanup on uncertain outcomes.
        self.validate_file(&file)?;
        let ok = unsafe { SetFileInformationByHandle(file.as_raw_handle(), FileRenameInfo,
            rename.words.as_mut_ptr().cast(), rename.bytes) };
        if ok == 0 { return Err(native_error("DPAPI publication outcome uncertain")); }
        Ok(())
    }
    fn validate_file(&self, file: &File) -> Result<(), StoreError> {
        info(file.as_raw_handle(), false)?;
        security(file.as_raw_handle(), self.sid.as_ptr() as PSID)
    }
    fn read(&self, name: &str) -> Result<Option<(File, Vec<u8>)>, StoreError> {
        let Some(mut file) = self.open(name, GENERIC_READ | DELETE, OPEN_EXISTING, FILE_SHARE_READ | FILE_SHARE_DELETE)? else { return Ok(None); };
        let bytes = read_bounded(&mut file)?;
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
// The old store inherited profile ACLs; it cannot satisfy the new private DACL
// contract. Admit it ONLY as read-only ciphertext input with current-user ownership,
// pinned non-reparse ancestry, one link, and no write/delete sharing. New namespace
// objects (including receipts) still require the full security() contract unchanged.
struct LegacySnapshot {
    bytes: Option<Vec<u8>>,
    _directories: Vec<OwnedHandle>,
    _file: Option<File>,
}
fn legacy_owner(handle: HANDLE, expected: PSID) -> Result<(), StoreError> {
    let mut owner = null_mut();
    let mut descriptor = null_mut();
    let code = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
        &mut owner, null_mut(), null_mut(), null_mut(), &mut descriptor) };
    let _owner = LocalAllocation { pointer: descriptor, length: 0, plaintext: false };
    if code != ERROR_SUCCESS { return Err(failure("legacy DPAPI owner query failed", code)); }
    if owner.is_null() || unsafe { IsValidSid(owner) } == 0 || unsafe { EqualSid(owner, expected) } == 0 {
        return Err(unsafe_store());
    }
    Ok(())
}
fn read_bounded(file: &mut File) -> Result<Vec<u8>, StoreError> {
    read_bounded_limit(file, None)
}
fn read_bounded_limit(file: &mut File, limit: Option<usize>) -> Result<Vec<u8>, StoreError> {
    let before = info(file.as_raw_handle(), false)?;
    let length = ((before.nFileSizeHigh as u64) << 32) | before.nFileSizeLow as u64;
    // Legacy admission happens before length conversion, reserve, resize or read.
    // Ordinary upstream secret files retain their original DWORD contract.
    if limit.is_some_and(|limit| length > limit as u64) { return Err(legacy::invalid()); }
    // DPAPI's DWORD bound; exact-length read, never unbounded read_to_end growth.
    let length = usize::try_from(u32::try_from(length).map_err(|_| unsafe_store())?).map_err(|_| unsafe_store())?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| failure("DPAPI allocation failed", 0))?;
    bytes.resize(length, 0);
    file.read_exact(&mut bytes).map_err(io_error)?;
    let after = info(file.as_raw_handle(), false)?;
    if before.nFileSizeHigh != after.nFileSizeHigh || before.nFileSizeLow != after.nFileSizeLow { return Err(unsafe_store()); }
    Ok(bytes)
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

    // All migration fixtures live beneath unique injected temp roots. No production
    // constructor, profile resolution, cleanup, or plaintext store is involved.
    fn migration_fixture(entries: &[(&str, &str)]) -> (WindowsDpapiStore, PathBuf, Vec<u8>) {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-migration-{token}"));
        let store = WindowsDpapiStore::with_root(root.clone(), format!("synthetic-{token}"));
        let context = store.context().unwrap();
        let directory = root.join("legacy");
        let path = wide(directory.as_os_str()).unwrap();
        checked(unsafe { CreateDirectoryW(path.as_ptr(), &context.descriptor.attributes()) }).unwrap();
        let mut secrets = std::collections::BTreeMap::new();
        for (id, value) in entries {
            let bytes = protect_entropy(value.as_bytes(), Some(id.as_bytes())).unwrap();
            secrets.insert(*id, STANDARD.encode(bytes));
        }
        let bytes = serde_json::to_vec(&serde_json::json!({"secrets": secrets})).unwrap();
        let file_path = directory.join("secrets.dat");
        let path = wide(file_path.as_os_str()).unwrap();
        let mut file = File::from(owned(unsafe { CreateFileW(path.as_ptr(), GENERIC_WRITE | READ_CONTROL,
            0, &context.descriptor.attributes(), CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }).unwrap());
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        drop(file);
        drop(context);
        (store, file_path, bytes)
    }
    fn all_operations_refused(store: &dyn SecretStore) {
        assert!(store.get("a").is_err());
        assert!(store.put("a", &Secret::new("replacement")).is_err());
        assert!(store.delete("a").is_err());
        assert!(store.list_ids().is_err());
    }

    #[test]
    fn migration_empty_legacy_store_is_valid_for_every_public_operation() {
        for first in ["get", "put", "delete", "list"] {
            let (store, path, before) = migration_fixture(&[]);
            assert_eq!(before.as_slice(), br#"{"secrets":{}}"#);
            let public: &dyn SecretStore = &store;
            match first {
                "get" => assert!(public.get("new").unwrap().is_none()),
                "put" => public.put("new", &Secret::new("synthetic")).unwrap(),
                "delete" => assert!(!public.delete("new").unwrap()),
                "list" => assert!(public.list_ids().unwrap().is_empty()),
                _ => unreachable!(),
            }
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(public.list_ids().unwrap(), if first == "put" { vec!["new"] } else { vec![] });
            assert_eq!(public.delete("new").unwrap(), first == "put");
            assert!(public.list_ids().unwrap().is_empty());
            super::super::check_contract(public);
            assert_eq!(std::fs::read(&path).unwrap(), before);
            let reopened = WindowsDpapiStore::with_root(store.root.clone().unwrap(), store.service.clone());
            assert!(reopened.get("new").unwrap().is_none());
            assert!(!reopened.delete("new").unwrap());
            assert!(reopened.list_ids().unwrap().is_empty());
            reopened.put("new", &Secret::new("synthetic after reopen")).unwrap();
            assert_eq!(reopened.get("new").unwrap().unwrap().expose(), "synthetic after reopen");
            assert!(reopened.delete("new").unwrap());
            assert!(reopened.list_ids().unwrap().is_empty());
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn migration_preserves_old_bytes_hides_receipt_and_never_resurrects() {
        let (store, path, before) = migration_fixture(&[("a", "synthetic ✓"), ("b", "")]);
        let public: &dyn SecretStore = &store;
        assert_eq!(public.list_ids().unwrap(), vec!["a", "b"]);
        assert_eq!(public.get("a").unwrap().unwrap().expose(), "synthetic ✓");
        assert_eq!(public.get("b").unwrap().unwrap().expose(), "");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(public.delete("a").unwrap());
        assert!(public.delete("b").unwrap());
        let reopened = WindowsDpapiStore::with_root(store.root.clone().unwrap(), store.service.clone());
        assert!(reopened.get("a").unwrap().is_none());
        assert!(reopened.list_ids().unwrap().is_empty());
        // Completion does not read or revalidate the retained legacy file, even
        // when its bytes later change. Deletion must not become a legacy fallback.
        std::fs::write(&path, b"synthetic changed legacy input").unwrap();
        assert!(reopened.get("a").unwrap().is_none());
        reopened.put("completion", &Secret::new("public ID is independent")).unwrap();
        assert_eq!(reopened.list_ids().unwrap(), vec!["completion"]);
        assert_eq!(reopened.get("completion").unwrap().unwrap().expose(), "public ID is independent");
    }

    #[test]
    fn migration_initial_publication_failure_leaves_old_store_retryable() {
        let (store, path, before) = migration_fixture(&[("a", "legacy")]);
        store.fail_before_publish.store(true, std::sync::atomic::Ordering::SeqCst);
        all_operations_refused(&store);
        let context = store.context().unwrap();
        assert!(context.read_receipt().unwrap().is_none());
        assert!(context.read(&filename(&store.service, "a").unwrap()).unwrap().is_none());
        drop(context);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store.fail_before_publish.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(store.get("a").unwrap().unwrap().expose(), "legacy");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_nontext_plaintext_is_refused_before_publication() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let (store, path, _) = migration_fixture(&[]);
        let encrypted = protect_entropy(&[0xff], Some(b"a")).unwrap();
        let before = serde_json::to_vec(&serde_json::json!({"secrets": {"a": STANDARD.encode(encrypted)}})).unwrap();
        std::fs::write(&path, &before).unwrap();
        assert_eq!(store.get("a").unwrap_err(), StoreError::NotText);
        all_operations_refused(&store);
        assert!(store.context().unwrap().read_receipt().unwrap().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_preflight_rejects_every_entry_before_any_publication() {
        let (store, path, before) = migration_fixture(&[("a", "valid"), ("z", "invalid later")]);
        let mut json: serde_json::Value = serde_json::from_slice(&before).unwrap();
        // Valid base64/DPAPI ciphertext under the wrong entropy-bound ID.
        json["secrets"]["z"] = json["secrets"]["a"].clone();
        let corrupted = serde_json::to_vec(&json).unwrap();
        std::fs::write(&path, &corrupted).unwrap();
        all_operations_refused(&store);
        let context = store.context().unwrap();
        assert!(context.read_receipt().unwrap().is_none());
        assert!(context.decode(&filename(&store.service, "a").unwrap(), Some("a")).unwrap().is_none());
        drop(context);
        assert_eq!(std::fs::read(&path).unwrap(), corrupted);
        // Tampered native blob (also covers foreign-user/unreadable DPAPI failure
        // handling, not proof of an actual second Windows account).
        json["secrets"]["z"] = serde_json::Value::String("AQID".into());
        let corrupted = serde_json::to_vec(&json).unwrap();
        std::fs::write(&path, &corrupted).unwrap();
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&path).unwrap(), corrupted);
    }

    #[test]
    fn migration_different_upstream_secret_is_not_overwritten() {
        let (store, path, before) = migration_fixture(&[("a", "legacy"), ("b", "new")]);
        let context = store.context().unwrap();
        let name = filename(&store.service, "a").unwrap();
        context.publish_secret(&name, "a", &Secret::new("existing upstream"), false, false).unwrap();
        let encrypted = context.read(&name).unwrap().unwrap().1;
        drop(context);
        all_operations_refused(&store);
        let context = store.context().unwrap();
        assert_eq!(context.read(&name).unwrap().unwrap().1, encrypted);
        assert!(context.read_receipt().unwrap().is_none());
        assert!(context.read(&filename(&store.service, "b").unwrap()).unwrap().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_pending_resumes_only_identical_snapshot_and_entries() {
        let (store, path, before) = migration_fixture(&[("a", "legacy"), ("b", "second")]);
        let identity = legacy::snapshot(Some(&before));
        let context = store.context().unwrap();
        context.publish_receipt(&format!("pending:{identity}"), false, false).unwrap();
        let name = filename(&store.service, "a").unwrap();
        context.publish_secret(&name, "a", &Secret::new("legacy"), false, false).unwrap();
        let encrypted = context.read(&name).unwrap().unwrap().1;
        drop(context);
        store.fail_before_publish.store(true, std::sync::atomic::Ordering::SeqCst);
        all_operations_refused(&store); // fails before publishing missing b
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store.fail_before_publish.store(false, std::sync::atomic::Ordering::SeqCst);
        let changed = [before.as_slice(), b" "].concat(); // valid JSON, different snapshot
        std::fs::write(&path, &changed).unwrap();
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&path).unwrap(), changed);
        std::fs::write(&path, &before).unwrap();
        assert_eq!(store.list_ids().unwrap(), vec!["a", "b"]);
        let context = store.context().unwrap();
        assert_eq!(context.read(&name).unwrap().unwrap().1, encrypted);
        assert_eq!(context.read_receipt().unwrap().unwrap().expose(), format!("complete:{identity}"));
        drop(context);
        assert!(store.delete("a").unwrap());
        assert!(store.get("a").unwrap().is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_completion_failure_gates_mutations_and_is_retryable() {
        let (store, path, before) = migration_fixture(&[("a", "legacy")]);
        let context = store.context().unwrap();
        context.publish_receipt(&format!("pending:{}", legacy::snapshot(Some(&before))), false, false).unwrap();
        context.publish_secret(&filename(&store.service, "a").unwrap(), "a", &Secret::new("legacy"), false, false).unwrap();
        drop(context);
        store.fail_before_publish.store(true, std::sync::atomic::Ordering::SeqCst);
        all_operations_refused(&store); // all imported: only completion publication fails
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store.fail_before_publish.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(store.get("a").unwrap().unwrap().expose(), "legacy");
        assert!(store.delete("a").unwrap());
        assert!(store.get("a").unwrap().is_none());
    }

    #[test]
    fn migration_receipt_corruption_and_wrong_context_fail_closed() {
        for wrong in ["service", "id", "schema", "plaintext", "tamper"] {
            let (store, path, before) = migration_fixture(&[("a", "legacy")]);
            let context = store.context().unwrap();
            let identity = legacy::snapshot(Some(&before));
            let service = legacy::receipt_service(&store.service);
            let value = Secret::new(format!("complete:{identity}"));
            let bad_schema = Secret::new("v2:absent");
            let plaintext = Plain(encode(if wrong == "service" { "wrong-service" } else { &service },
                if wrong == "id" { "wrong-id" } else { RECEIPT_ID },
                if wrong == "schema" { &bad_schema } else { &value }).unwrap());
            let mut bytes = protect(&plaintext.0).unwrap();
            if wrong == "plaintext" { bytes = plaintext.0.clone(); }
            if wrong == "tamper" { bytes[0] ^= 1; }
            context.publish(RECEIPT_NAME, &bytes, false, false).unwrap();
            drop(context);
            all_operations_refused(&store);
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn migration_hardlinked_receipt_is_rejected_by_the_same_file_guards() {
        let (store, path, before) = migration_fixture(&[("a", "legacy")]);
        assert_eq!(store.get("a").unwrap().unwrap().expose(), "legacy");
        let context = store.context().unwrap();
        let receipt_path = context.directory.join(RECEIPT_NAME);
        let encrypted = context.read(RECEIPT_NAME).unwrap().unwrap().1;
        std::fs::hard_link(&receipt_path, context.directory.join("synthetic-receipt-alias")).unwrap();
        drop(context);
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&receipt_path).unwrap(), encrypted);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_legacy_bounds_and_hardlinks_are_refused() {
        let at_limit = "x".repeat(legacy::MAX_SECRET_BYTES);
        let (store, path, before) = migration_fixture(&[("a", &at_limit)]);
        assert_eq!(store.get("a").unwrap().unwrap().expose(), at_limit);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let huge = "x".repeat(legacy::MAX_SECRET_BYTES + 1);
        let (store, path, before) = migration_fixture(&[("a", &huge)]);
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let (store, path, before) = migration_fixture(&[("a", "legacy")]);
        std::fs::hard_link(&path, path.with_file_name("synthetic-alias")).unwrap();
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn migration_budget_rejections_leave_old_bytes_and_namespace_unchanged() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        // Exercise snapshot admission through public operations. Oversize input is
        // rejected from handle metadata, before reserving its file-sized buffer.
        let (store, path, original) = migration_fixture(&[("a", "legacy")]);
        let mut oversized = original.clone();
        oversized.resize(legacy::MAX_LEGACY_SNAPSHOT_BYTES + 1, b' ');
        std::fs::write(&path, &oversized).unwrap();
        assert_eq!(store.get("a").unwrap_err(), legacy::invalid());
        all_operations_refused(&store);
        assert_eq!(std::fs::read(&path).unwrap(), oversized);
        let context = store.context().unwrap();
        assert!(context.read_receipt().unwrap().is_none());
        assert!(context.read(&filename(&store.service, "a").unwrap()).unwrap().is_none());
        drop(context);
        drop(oversized);
        // Every case must fail with the migration-budget error, not a native
        // decryption error: parser preflight must run before the first DPAPI call.
        for case in ["count", "entry", "encoded", "aggregate"] {
            let (store, path, _) = migration_fixture(&[("a", "legacy")]);
            let mut entries = std::collections::BTreeMap::new();
            match case {
                "count" => {
                    for i in 0..=legacy::MAX_LEGACY_ENTRIES { entries.insert(format!("id-{i}"), "AA==".into()); }
                }
                "entry" => { entries.insert("a".into(), STANDARD.encode(vec![0; legacy::MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY + 1])); },
                "encoded" => {
                    let length = legacy::encoded_limit(legacy::MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY).unwrap() + 4;
                    entries.insert("a".into(), "A".repeat(length));
                }
                "aggregate" => {
                    let value = STANDARD.encode(vec![0; legacy::MAX_LEGACY_CIPHERTEXT_BYTES_PER_ENTRY]);
                    for i in 0..4 { entries.insert(format!("id-{i}"), value.clone()); }
                    entries.insert("overflow".into(), "AA==".into());
                }
                _ => unreachable!(),
            }
            let before = serde_json::to_vec(&serde_json::json!({"secrets": entries})).unwrap();
            std::fs::write(&path, &before).unwrap();
            assert_eq!(store.get("a").unwrap_err(), legacy::invalid());
            all_operations_refused(&store);
            assert_eq!(std::fs::read(&path).unwrap(), before);
            let context = store.context().unwrap();
            assert!(context.read_receipt().unwrap().is_none());
            assert!(context.read(&filename(&store.service, "a").unwrap()).unwrap().is_none());
        }
    }

    #[test]
    fn migration_plaintext_native_copy_honors_remaining_budget() {
        let at_limit = vec![b'x'; legacy::MAX_SECRET_BYTES];
        let encrypted = protect_entropy(&at_limit, Some(b"a")).unwrap();
        assert_eq!(unprotect_legacy(&encrypted, b"a", legacy::MAX_SECRET_BYTES).unwrap().0.len(), at_limit.len());
        assert!(matches!(unprotect_legacy(&encrypted, b"a", legacy::MAX_SECRET_BYTES - 1), Err(error) if error == legacy::invalid()));
        // These calls directly exercise the same native cbData admission used by
        // public migration, without needing an impossible >8 MiB plaintext input
        // that also fits an 8 MiB DPAPI-ciphertext budget including overhead.
        let empty = protect_entropy(b"", Some(b"a")).unwrap();
        assert!(unprotect_legacy(&empty, b"a", 0).unwrap().0.is_empty());
    }

    #[test]
    fn migration_absent_legacy_is_completed_without_creating_old_store() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dpapi-absent-{token}"));
        let store = WindowsDpapiStore::with_root(root.clone(), format!("synthetic-{token}"));
        assert!(store.get("a").unwrap().is_none());
        assert!(!root.join("legacy").exists());
        store.put("a", &Secret::new("new install")).unwrap();
        assert!(store.delete("a").unwrap());
        assert!(store.list_ids().unwrap().is_empty());
        let context = store.context().unwrap();
        assert_eq!(context.read_receipt().unwrap().unwrap().expose(), "complete:absent");
        drop(context);
        assert!(!root.join("legacy").exists());
    }

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
    #[ignore = "explicit Windows native publication check; injected temp fixture only"]
    fn isolated_local_app_data_publication() {
        let token = random_name().unwrap();
        let root = std::env::temp_dir().join(format!("gentle-dot-publication-test-{token}"));
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
