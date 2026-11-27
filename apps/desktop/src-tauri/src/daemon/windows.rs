//! Windows launch encoding and the native owned, channel-present process adapter.
//! Explicit transfer, suspended Job assignment and verification precede child execution.
//! The daemon lifecycle in daemon.rs drives these adapters, including owner-exit retirement.

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
pub(super) use native::{acquire_recovered_launch, ensure_record_directory, open_private_log, retire_if_owner_exited, spawn, RecoveredLaunch, SpawnFailure, WindowsChild};
#[cfg(all(windows, target_arch = "x86_64"))]
#[allow(unused_imports)] // No production selector.
pub(super) use native::spawn_explicit;
#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) use native::startup_profile;
#[cfg(all(windows, feature = "local-preview"))]
pub(super) use native::{create_private_preview_config, create_private_preview_directory};

#[cfg(windows)]
mod native {
    use super::{command_line, fd3_bootstrap};
    use super::super::{ChildEndpoint, ChildProcess, LaunchSpec};
    #[cfg(target_arch = "x86_64")]
    use super::super::windows_split_launch_plan::LaunchPlan;
    use std::borrow::Cow;
    #[cfg(windows_owner_observation)]
    use super::super::windows_owner_trace::{self, Event, Trace};
    use std::ffi::OsString;
    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitStatus;
    use std::ptr::{null, null_mut};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Globalization::CompareStringOrdinal;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::IO::*;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Pipes::*;
    use windows_sys::Win32::System::Threading::*;

    #[cfg(test)]
    mod admission_fixture {
        include!("windows_admission_fixture.rs");
    }

    // SDK winnt.h definitions, scoped here because the enabled windows-sys
    // namespaces do not expose them: ACE_HEADER.AceType and SID count are BYTEs.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
    const SID_MAX_SUB_AUTHORITIES: u8 = 15;
    // GetDriveTypeW's documented UINT return constant: DRIVE_FIXED = 3.
    const DRIVE_FIXED: u32 = 3;

    // Redirected stdio does not prevent Windows from allocating a console for Node.
    const DAEMON_CREATION_FLAGS: u32 =
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;

    const CLEANUP_WAIT: Duration = Duration::from_secs(2);
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
    const DATA_DIR_KEY: &str = "GENTLE_DOT_DATA_DIR";
    type EnvEntry = (Vec<u16>, Vec<u16>);

    fn encode_entry(key: &str, value: &str) -> io::Result<EnvEntry> {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid launch environment"));
        }
        Ok((key.encode_utf16().collect(), value.encode_utf16().collect()))
    }

    fn bundled_environment(spec: &LaunchSpec, directory: &str,
        inherited: impl IntoIterator<Item = (OsString, OsString)>) -> io::Result<Vec<u16>> {
        let inherited = inherited.into_iter();
        #[cfg(windows_owner_observation)]
        let inherited = inherited.filter(|(key, _)| !key.to_str().is_some_and(windows_owner_trace::is_selector));
        let mut entries: Vec<EnvEntry> = inherited
            .map(|(key, value)| (key.encode_wide().collect(), value.encode_wide().collect())).collect();
        // Bundled mode overlays the actual stop record directory last. Only the
        // non-secret path is passed; nonce/capability remain file-only.
        let overrides = spec.envs.iter().map(|(key, value)| (key.as_str(), value.as_str()))
            .chain(std::iter::once((DATA_DIR_KEY, directory)));
        for (key, value) in overrides {
            #[cfg(windows_owner_observation)]
            if windows_owner_trace::is_selector(key) { continue; }
            let entry = encode_entry(key, value)?;
            if let Some(index) = find_env_key(&entries, &entry.0)? { entries[index] = entry; }
            else { entries.push(entry); }
        }
        environment_block(entries)
    }

    fn explicit_environment(env: &[(String, String)], directory: &str) -> io::Result<Vec<u16>> {
        let mut entries = Vec::with_capacity(env.len());
        for (key, value) in env {
            let entry = encode_entry(key, value)?;
            if find_env_key(&entries, &entry.0)?.is_some() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "duplicate explicit launch environment key"));
            }
            entries.push(entry);
        }
        let key: Vec<u16> = DATA_DIR_KEY.encode_utf16().collect();
        if !find_env_key(&entries, &key)?.is_some_and(|index| env[index].1 == directory) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "explicit launch data directory does not match stop record root"));
        }
        environment_block(entries)
    }

    fn find_env_key(entries: &[EnvEntry], key: &[u16]) -> io::Result<Option<usize>> {
        for (index, (existing, _)) in entries.iter().enumerate() {
            if compare_names(existing, key)? == std::cmp::Ordering::Equal { return Ok(Some(index)); }
        }
        Ok(None)
    }

    fn environment_block(mut entries: Vec<EnvEntry>) -> io::Result<Vec<u16>> {
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
            // Only absolute PATH entries: an empty or relative entry would resolve against the
            // current directory and could select a planted executable.
            path.as_deref().into_iter().flat_map(std::env::split_paths).filter(|dir| dir.is_absolute())
                .map(|dir| dir.join(&file))
                .find(|candidate| candidate.is_file())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "daemon executable not found in launch PATH"))?
        };
        // Windows absolute() also resolves drive-relative paths; cwd itself is unchanged.
        let absolute = std::path::absolute(path)?;
        wide(absolute.as_os_str())
    }

    /// Inputs from a trusted, validated private launch plan. The caller must establish
    /// path identity, ancestry, directory ownership and handle retention through use,
    /// including the matching stop record root. The launcher checks spelling and encoding
    /// only; it does not discover, provision or admit the runtime or private state.
    struct ExplicitChildContext<'a> {
        program: &'a str,
        args: &'a [String],
        cwd: &'a Path,
        env: &'a [(String, String)],
    }

    enum ChildContext<'a> {
        Bundled(&'a LaunchSpec),
        Explicit(ExplicitChildContext<'a>),
    }

    enum SpawnInput<'a> {
        Bundled(&'a LaunchSpec, &'a Path),
        #[cfg(target_arch = "x86_64")]
        Split(LaunchPlan, &'static SplitSlot),
    }

    #[derive(Debug)]
    struct PreparedChild {
        application: Vec<u16>,
        command: Vec<u16>,
        cwd: Option<Vec<u16>>,
        env: Vec<u16>,
    }

    impl ChildContext<'_> {
        fn prepare<I>(self, data_dir: &Path, inherited: impl FnOnce() -> I) -> io::Result<PreparedChild>
        where I: IntoIterator<Item = (OsString, OsString)> {
            let directory = || data_dir.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput,
                "Windows stop record directory must be Unicode"));
            match self {
                Self::Bundled(spec) => Ok(PreparedChild {
                    application: application(spec)?,
                    command: command_line(&spec.program, &spec.args)?,
                    cwd: None,
                    env: bundled_environment(spec, directory()?, inherited())?,
                }),
                Self::Explicit(context) => Ok(PreparedChild {
                    application: wide(explicit_path(Path::new(context.program))?.as_ref())?,
                    command: command_line(context.program, context.args)?,
                    cwd: Some(wide(explicit_path(context.cwd)?.as_ref())?),
                    env: explicit_environment(context.env, explicit_path(data_dir)?)?,
                }),
            }
        }
    }

    fn explicit_path(path: &Path) -> io::Result<&str> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidInput,
            "explicit launch path must be an ordinary absolute DOS path");
        // Keep the supplied drive-letter spelling verbatim. In particular, do not
        // call absolute() or normalize dot components or Win32 alias spellings.
        let text = path.to_str().ok_or_else(invalid)?;
        let bytes = text.as_bytes();
        if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\"
            || !text[3..].split('\\').all(|component| {
                if component.is_empty() || component.ends_with([' ', '.'])
                    || component.chars().any(|ch| ch < ' ' || "/:*?\"<>|".contains(ch)) {
                    return false;
                }
                let stem = component.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
                !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
                    && !stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT"))
                        .is_some_and(|suffix| matches!(suffix, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
            }) {
            return Err(invalid());
        }
        Ok(text)
    }

    #[cfg(test)]
    mod child_input_tests {
        use super::*;

        const PROGRAM: &str = r"C:\fixture runtime\node.exe";
        const CWD: &str = r"C:\fixture runtime";
        const DATA: &str = r"D:\fixture data";
        const DATA_KEY: &str = "GENTLE_DOT_DATA_DIR";

        fn entries(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
            pairs.iter().map(|&(key, value)| (key.into(), value.into())).collect()
        }

        fn explicit(program: &str, cwd: &str, pairs: &[(&str, &str)]) -> io::Result<PreparedChild> {
            ChildContext::Explicit(ExplicitChildContext {
                program, cwd: Path::new(cwd), args: &["inert argument".into()], env: &entries(pairs),
            }).prepare(Path::new(DATA), || -> std::iter::Empty<(OsString, OsString)> {
                panic!("explicit input must not consult inherited environment")
            })
        }

        fn invalid(result: io::Result<PreparedChild>, message: &str) {
            let error = result.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(error.to_string(), message);
        }

        #[test]
        fn exact_explicit_child_input_has_only_supplied_sorted_utf16_entries() {
            let prepared = explicit(PROGRAM, CWD, &[
                ("z", "🚀=é"), ("gentle_dot_data_dir", DATA), ("B", ""), ("a", "1"),
            ]).unwrap();
            assert_eq!(prepared.application, format!("{PROGRAM}\0").encode_utf16().collect::<Vec<_>>());
            assert_eq!(prepared.cwd.unwrap(), format!("{CWD}\0").encode_utf16().collect::<Vec<_>>());
            assert_eq!(prepared.command, format!("\"{PROGRAM}\" \"inert argument\"\0").encode_utf16().collect::<Vec<_>>());
            assert_eq!(prepared.env, format!("a=1\0B=\0gentle_dot_data_dir={DATA}\0z=🚀=é\0\0")
                .encode_utf16().collect::<Vec<_>>());
        }

        #[test]
        fn exact_explicit_child_input_rejects_invalid_or_duplicate_environment_entries() {
            for pair in [("", "x"), ("=C:", "x"), ("bad=key", "x"), ("bad\0key", "x"), ("ok", "bad\0value")] {
                invalid(explicit(PROGRAM, CWD, &[(DATA_KEY, DATA), pair]), "invalid launch environment");
            }
            for (left, right) in [("Example", "example"), ("É", "é"), (DATA_KEY, "gentle_dot_data_dir")] {
                let mut pairs = vec![(left, DATA), (right, DATA)];
                if left != DATA_KEY { pairs.push((DATA_KEY, DATA)); }
                invalid(explicit(PROGRAM, CWD, &pairs), "duplicate explicit launch environment key");
            }
        }

        #[test]
        fn exact_explicit_child_input_requires_the_record_root_verbatim() {
            invalid(explicit(PROGRAM, CWD, &[]), "explicit launch data directory does not match stop record root");
            for value in ["", r"d:\fixture data", "D:/fixture data", r"D:\fixture data\other"] {
                invalid(explicit(PROGRAM, CWD, &[(DATA_KEY, value)]), "explicit launch data directory does not match stop record root");
            }
        }

        #[test]
        fn exact_explicit_child_input_rejects_a_matching_drive_relative_record_root() {
            let data_dir = r"D:fixture data";
            let env = entries(&[(DATA_KEY, data_dir)]);
            let context = ChildContext::Explicit(ExplicitChildContext {
                program: PROGRAM, cwd: Path::new(CWD), args: &[], env: &env,
            });
            let prepared = context.prepare(Path::new(data_dir), || -> std::iter::Empty<(OsString, OsString)> {
                panic!("explicit input must not consult inherited environment")
            });
            invalid(prepared, "explicit launch path must be an ordinary absolute DOS path");
        }

        #[test]
        fn exact_explicit_child_input_rejects_nonordinary_paths_without_search_or_inheritance() {
            for path in ["node.exe", "", r"C:node.exe", r"\node.exe", r"\\server\share\node.exe",
                r"\\?\C:\node.exe", r"C:\x\..\node.exe", r"C:\x\.\node.exe", r"C:\x\\node.exe",
                r"C:\node.exe:alt", r"C:\node.exe ", r"C:\NUL.exe", "C:\\node\0.exe"] {
                invalid(explicit(path, CWD, &[(DATA_KEY, DATA), ("PATH", CWD)]), "explicit launch path must be an ordinary absolute DOS path");
                invalid(explicit(PROGRAM, path, &[(DATA_KEY, DATA)]), "explicit launch path must be an ordinary absolute DOS path");
            }
        }

        #[test]
        fn exact_explicit_child_input_preserves_bundled_overlay_and_inherited_cwd() {
            let spec = LaunchSpec { program: PROGRAM.into(), args: vec![], envs: entries(&[
                ("OVERLAY", "old"), ("Overlay", "new"), (DATA_KEY, "override"),
                ("GENTLE_DOT_CI_OWNER_PORT", "synthetic override"),
            ]) };
            let prepared = ChildContext::Bundled(&spec).prepare(Path::new(DATA), || [
                (OsString::from("inherited"), OsString::from("retained")),
                (OsString::from("overlay"), OsString::from("inherited value")),
                (OsString::from("gentle_dot_ci_owner_id"), OsString::from("synthetic inherited")),
            ]).unwrap();
            assert!(prepared.cwd.is_none());
            let expected = if cfg!(windows_owner_observation) {
                format!("{DATA_KEY}={DATA}\0inherited=retained\0Overlay=new\0\0")
            } else {
                format!("gentle_dot_ci_owner_id=synthetic inherited\0GENTLE_DOT_CI_OWNER_PORT=synthetic override\0{DATA_KEY}={DATA}\0inherited=retained\0Overlay=new\0\0")
            };
            assert_eq!(prepared.env, expected.encode_utf16().collect::<Vec<_>>());
        }
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

    // Reserve before CreateProcess so terminal uncertainty cannot exceed one guard.
    // Quarantine is process-local; exiting the app is not proof the child exited.
    #[cfg(target_arch = "x86_64")]
    enum SplitState { Available, Reserved, Quarantined { _plan: LaunchPlan } }
    #[cfg(target_arch = "x86_64")]
    struct SplitSlot(std::sync::Mutex<SplitState>);
    #[cfg(target_arch = "x86_64")]
    static SPLIT_SLOT: SplitSlot = SplitSlot::new();

    #[cfg(target_arch = "x86_64")]
    impl SplitSlot {
        const fn new() -> Self { Self(std::sync::Mutex::new(SplitState::Available)) }
        fn reserve(&'static self, plan: LaunchPlan) -> io::Result<SplitGuard> {
            let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
            if !matches!(*state, SplitState::Available) {
                return Err(io::Error::other("Windows split launch guard is already held"));
            }
            *state = SplitState::Reserved;
            Ok(SplitGuard { slot: self, plan: Some(plan), uncertain: false })
        }
    }

    #[cfg(target_arch = "x86_64")]
    struct SplitGuard {
        slot: &'static SplitSlot,
        plan: Option<LaunchPlan>,
        uncertain: bool,
    }
    #[cfg(target_arch = "x86_64")]
    impl Drop for SplitGuard {
        fn drop(&mut self) {
            let next = if self.uncertain {
                SplitState::Quarantined { _plan: self.plan.take().unwrap() }
            } else {
                drop(self.plan.take());
                SplitState::Available
            };
            *self.slot.0.lock().unwrap_or_else(|error| error.into_inner()) = next;
        }
    }

    #[cfg(test)]
    #[derive(Default, Debug)]
    struct Faults { assignment: bool, verification: bool, terminate: bool, wait: bool, query: bool }
    pub(crate) struct WindowsChild {
        #[cfg(target_arch = "x86_64")]
        split: Option<SplitGuard>,
        process: OwnedHandle,
        thread: Option<OwnedHandle>,
        job: OwnedHandle,
        pid: u32,
        assigned: bool,
        failed: bool,
        // Set once the daemon resumed. An established launch whose status later turns
        // uncertain is retained as failed (no replacement, no health) but still stops
        // through the authenticated, channel-open path, never as a failed startup.
        established: bool,
        record: Option<OwnedRecord>,
        // Reuse the authenticated client with a duplicate of the created process
        // handle, never a fresh PID lookup. Keep pending I/O installed on errors.
        stop: Option<RecoveredLaunch>,
        stopping: bool,
        force_requested: bool,
        // Completion survives record/channel-close failures and checked retries.
        completed: bool,
        #[cfg(windows_owner_observation)]
        trace: Option<Trace>,
        #[cfg(test)]
        faults: Faults,
    }
    impl std::fmt::Debug for WindowsChild {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.debug_struct("WindowsChild").field("pid", &self.pid)
                .field("assigned", &self.assigned).field("failed", &self.failed).finish_non_exhaustive()
        }
    }
    impl WindowsChild {
        pub(crate) fn reject_launch(&mut self) { self.failed = true; }
        fn status(&self) -> io::Result<Option<ExitStatus>> {
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    unsafe { checked(GetExitCodeProcess(self.process.as_raw_handle(), &mut code))?; }
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
        fn query(&self) -> io::Result<u32> {
            #[cfg(test)]
            if self.faults.query { return Err(io::Error::other("injected job query failure")); }
            job_active(&self.job)
        }
        fn terminate(&self) -> io::Result<()> {
            #[cfg(test)]
            if self.faults.terminate { return Err(io::Error::other("injected terminate failure")); }
            // Never PID-based: before assignment only the exact created process; afterward
            // only the anonymous retained Job. A nested-Job assignment error has no fallback.
            unsafe {
                checked(if self.assigned { TerminateJobObject(self.job.as_raw_handle(), 1) }
                    else { TerminateProcess(self.process.as_raw_handle(), 1) })
            }
        }
        fn complete(&mut self, grace: Duration) -> io::Result<()> {
            let deadline = Instant::now() + grace;
            let mut errors = Vec::new();
            loop {
                match self.status() {
                    Ok(Some(_)) => match self.query() {
                        Ok(0) if errors.is_empty() => { drop(self.thread.take()); return Ok(()); }
                        Ok(_) => {}
                        Err(error) if errors.is_empty() => errors.push(format!("job query: {error}")),
                        Err(_) => {}
                    },
                    Ok(None) => {}
                    Err(error) if errors.is_empty() => errors.push(format!("status: {error}")),
                    Err(_) => {}
                }
                // Observation errors do not bypass the owned termination attempt, and an
                // established launch never escalates before its EOF grace has elapsed.
                if Instant::now() >= deadline { break; }
                std::thread::sleep(Duration::from_millis(25));
            }
            if let Err(error) = self.terminate() { errors.push(format!("terminate: {error}")); }
            #[cfg(test)]
            let skip_wait = self.faults.wait;
            #[cfg(not(test))]
            let skip_wait = false;
            if skip_wait { errors.push("wait: injected completion failure".into()); }
            else {
                match unsafe { WaitForSingleObject(self.process.as_raw_handle(), CLEANUP_WAIT.as_millis() as u32) } {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => errors.push("wait: owned process completion not established".into()),
                    _ => errors.push(format!("wait: {}", io::Error::last_os_error())),
                }
            }
            let deadline = Instant::now() + CLEANUP_WAIT;
            loop {
                match self.query() {
                    Ok(0) => break,
                    Ok(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
                    Ok(_) => { errors.push("job query: owned Job is not empty".into()); break; }
                    Err(error) => { errors.push(format!("job query: {error}")); break; }
                }
            }
            if errors.is_empty() { drop(self.thread.take()); Ok(()) }
            else { Err(io::Error::other(errors.join("; "))) }
        }
    }
    impl ChildProcess for WindowsChild {
        #[cfg(target_arch = "x86_64")]
        fn readiness_alive(&self) -> bool {
            !self.launch_failed() && matches!(self.status(), Ok(None))
        }
        fn id(&self) -> u32 { self.pid }
        fn launch_failed(&self) -> bool { self.failed || self.stopping }
        fn shutdown_requires_channel(&self) -> bool { !self.failed || self.stopping || self.established }
        fn retain_failure(&mut self) { self.failed = true; }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if self.launch_failed() { return Err(io::Error::other("retained failed launch requires checked shutdown")); }
            let result = self.status();
            #[cfg(windows_owner_observation)]
            if let Some(trace) = self.trace.as_mut() { trace.status(&result); }
            result
        }
        fn kill(&mut self) -> io::Result<()> { self.terminate() }
        fn wait(&mut self) -> io::Result<ExitStatus> {
            if self.failed { return Err(io::Error::other("retained failed launch requires checked shutdown")); }
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) } {
                WAIT_OBJECT_0 => {}
                _ => return Err(io::Error::last_os_error()),
            }
            self.complete(Duration::ZERO)?;
            self.status()?.ok_or_else(|| io::Error::other("owned process completion missing"))
        }
        fn shutdown_owned(&mut self, grace: Duration) -> io::Result<()> {
            if self.completed { return self.finish_record(); }
            if self.failed && !self.stopping && !self.established {
                // Failed startup may never have installed its listener.
                self.complete(grace)?;
                self.completed = true;
                return self.finish_record();
            }
            self.stopping = true;
            // The caller owns the grace; the authenticated attempt never exceeds the cap.
            let deadline = Instant::now() + grace.min(RECOVERED_STOP_LIMIT);
            let graceful = if self.force_requested { false }
                else { self.graceful_owned_until(deadline).is_ok() };
            if !graceful {
                self.force_requested = true;
                // Even an early authentication failure gets the remaining grace. Only
                // the retained exact created process/Job can be terminated, never a PID
                // lookup, discovered process tree, or recovered record's alleged group.
                self.complete(deadline.saturating_duration_since(Instant::now()))?;
                if let Some(stop) = self.stop.as_mut() { stop.settle_owned_io(CLEANUP_WAIT)?; }
            }
            self.completed = true;
            if let Some(record) = self.stop.as_mut().and_then(|stop| stop.record.as_mut()) {
                drop(record.file.take());
            }
            self.finish_record()?;
            drop(self.thread.take());
            eprintln!("gentle-dot: owned Windows shutdown confirmed ({})",
                if graceful { "orderly" } else { "exact-Job fallback" });
            Ok(())
        }
        fn started_owned(&self) -> io::Result<u64> {
            let mut created: FILETIME = unsafe { std::mem::zeroed() };
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            unsafe { checked(GetProcessTimes(self.process.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user))?; }
            Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
        }
    }
    impl WindowsChild {
        fn graceful_owned_until(&mut self, deadline: Instant) -> io::Result<()> {
            if self.stop.is_none() {
                let published = self.record.as_ref()
                    .ok_or_else(|| recovery_error("owned Windows stop record is unavailable"))?;
                let record = read_validated_record(published.path.parent().ok_or_else(unsafe_record)?)?
                    .ok_or_else(|| recovery_error("owned Windows stop record is absent"))?;
                require_complete_record(published.identity.ok_or_else(unsafe_record)?,
                    &published.expected, record.identity, &record.record)?;
                let process = self.process.try_clone()?;
                self.stop = Some(RecoveredLaunch { record: Some(record), process: Some(process),
                    admitted: false, connect: None, write: None, attempted: false,
                    written: false, clean_exit: false });
                let stop = self.stop.as_mut().unwrap();
                stop.require_live()?;
                stop.admitted = true;
            }
            let stop = self.stop.as_mut().unwrap();
            stop.stop(deadline.saturating_duration_since(Instant::now()))?;
            // Recovery may accept an independently observed clean root exit. Owned
            // shutdown additionally requires a completed authenticated frame. EOF alone
            // is never authority, and clean managed root exit includes daemon fd3 drain.
            if !stop.written || !stop.clean_exit || stop.connect.is_some() || stop.write.is_some() {
                return Err(recovery_error("owned Windows authenticated stop/drain is unconfirmed"));
            }
            while self.query()? != 0 {
                if Instant::now() >= deadline {
                    return Err(recovery_error("owned Windows Job is not empty; record retained"));
                }
                std::thread::sleep(RECOVERY_POLL);
            }
            Ok(())
        }
    }
    impl Drop for WindowsChild {
        fn drop(&mut self) {
            // Ordinary production destruction, not probe proof: best effort only. Preserve
            // configured kill-on-last-Job-close through RAII even if explicit cleanup fails.
            // An unassigned failed child may remain suspended on persistent OS failure;
            // neither error nor closing a process handle is claimed to prove termination.
            #[cfg(target_arch = "x86_64")]
            if self.completed {
                if let Some(split) = self.split.as_mut() {
                    // Checked shutdown already proved root exit and Job drain.
                    split.uncertain = false;
                    return;
                }
            }
            let completion = self.complete(Duration::ZERO);
            #[cfg(target_arch = "x86_64")]
            if let Some(split) = self.split.as_mut() { split.uncertain = completion.is_err(); }
            if let Err(error) = completion {
                #[cfg(test)]
                if admission_fixture::quiet_drop() { return; }
                eprintln!("gentle-dot: owned Windows daemon cleanup was not confirmed: {error}");
            }
        }
    }
    #[cfg(all(test, target_arch = "x86_64"))]
    #[allow(unexpected_cfgs)] // windows_split_bridge_fixture exists only in the isolated QA build.
    mod split_bridge_tests {
        use super::*;
        use crate::daemon::windows_split_tree::PinnedTree;
        use sha2::{Digest, Sha256};
        use std::num::NonZeroU16;
        use std::os::windows::fs::OpenOptionsExt;

        // Only the restricted harness generates this exact file, in its source snapshot.
        const QA_INPUT: Option<(&str, &[u8])> = {
            #[cfg(windows_split_bridge_fixture)]
            { Some((env!("DOT_SPLIT_BRIDGE_QA_ROOT"), include_bytes!("../../tests/fixtures/split_bridge_child.exe"))) }
            #[cfg(not(windows_split_bridge_fixture))]
            { None }
        };

        fn qa_input() -> io::Result<(&'static Path, &'static [u8])> {
            QA_INPUT.map(|(root, bytes)| (Path::new(root), bytes)).ok_or_else(||
                io::Error::new(io::ErrorKind::NotFound, "run the restricted Windows bridge QA harness"))
        }

        #[cfg(not(windows_split_bridge_fixture))]
        #[test]
        fn exact_split_bridge_without_fixture_build_has_no_launch_input() {
            let error = qa_input().unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::NotFound);
            assert_eq!(error.to_string(), "run the restricted Windows bridge QA harness");
        }

        fn fixture() -> (LaunchPlan, PathBuf, PathBuf) {
            use std::io::Write;
            let (scratch, helper) = qa_input().expect("explicit native bridge QA only");
            let run = scratch.join(format!("bridge-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir(&run).unwrap();
            let root = run.join("runtime");
            let state = run.join("state");
            std::fs::create_dir_all(&state).unwrap();
            let member = root.join(r"bin\pi.exe");
            let files = ["bin/engram.exe", "bin/pi.exe", "bin/private-storage.exe", "daemon/cli.mjs",
                "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs", "node/node.exe", "ui/index.html"];
            let entries = files.map(|name| {
                let bytes = if name == "node/node.exe" { helper } else { b"inert" };
                let path = root.join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                File::options().create_new(true).write(true).open(&path).unwrap()
                    .write_all(bytes).unwrap();
                format!(r#"{{"path":"{name}","type":"file","size":{},"sha256":"{:x}"}}"#,
                    bytes.len(), Sha256::digest(&bytes))
            });
            let raw = format!(r#"{{"schema":1,"target":"windows-x64","shell":"5.0.0","pi":"1.6.0","files":[{}]}}"#,
                entries.join(","));
            let tree = PinnedTree::admit(&root, raw.as_bytes(), Sha256::digest(&raw).into()).unwrap();
            let plan = LaunchPlan::new(tree, state.clone(), NonZeroU16::new(4317).unwrap()).unwrap();
            (plan, state, member)
        }

        fn write_open(path: &Path) -> io::Result<File> {
            std::fs::OpenOptions::new().access_mode(FILE_WRITE_DATA).share_mode(7).open(path)
        }

        #[test]
        #[ignore = "requires restricted Windows bridge QA build; launches embedded inert fixture"]
        fn exact_split_bridge_publishes_in_plan_state_and_owns_tree_until_confirmed_exit() {
            let (plan, state, member) = fixture();
            assert!(!state.join("daemon.pid").exists());
            let (_parent, endpoint) = crate::app_channel::windows::channel_pair().unwrap();
            let mut child = (crate::daemon::windows::spawn_explicit)(plan,
                open_private_log(&state).unwrap(), &endpoint).unwrap();
            assert!(state.join("daemon.pid").is_file());
            assert_eq!(write_open(&member).unwrap_err().raw_os_error(), Some(32));
            assert_eq!(unsafe { WaitForSingleObject(child.process.as_raw_handle(), 5000) }, WAIT_OBJECT_0);
            assert!(child.wait().unwrap().success());
            drop(child);
            drop(write_open(&member).unwrap());
            // Leave the isolated test record and tree intact.
            assert!(state.join("daemon.pid").is_file());
        }

        #[test]
        #[ignore = "requires restricted Windows bridge QA build; launches embedded inert fixture"]
        fn exact_split_bridge_quarantine_retains_tree_and_refuses_another_reservation() {
            static SLOT: SplitSlot = SplitSlot::new();
            use std::io::{Read, Seek, Write};
            let (plan, state, member) = fixture();
            let mut record = File::options().create_new(true).read(true).write(true)
                .open(state.join("daemon.pid")).unwrap();
            record.write_all(b"existing inert record").unwrap();
            let (_parent, endpoint) = crate::app_channel::windows::channel_pair().unwrap();
            let failure = spawn_inner(SpawnInput::Split(plan, &SLOT), open_private_log(&state).unwrap(),
                &endpoint, Faults { query: true, ..Faults::default() }).unwrap_err();
            assert_eq!(failure.primary.raw_os_error(), Some(ERROR_FILE_EXISTS as i32));
            assert!(failure.cleanup.unwrap().to_string().contains("injected job query failure"));
            let child = failure.unfinished.expect("publish failure must return the unfinished owner");
            assert_eq!(write_open(&member).unwrap_err().raw_os_error(), Some(32));
            assert!(child.status().unwrap().is_some()); // Root exited, but the Job query is unconfirmed.
            drop(child);
            assert_eq!(write_open(&member).unwrap_err().raw_os_error(), Some(32));
            // The private-log helper reprotected the directory. Use the original
            // fixture handle to read its inert bytes, rather than reopening by path.
            record.rewind().unwrap();
            let mut bytes = Vec::new();
            record.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"existing inert record");
            let (other, _, other_member) = fixture();
            assert!(SLOT.reserve(other).is_err());
            drop(write_open(&other_member).unwrap());
        }
    }

    #[derive(Debug)]
    pub(crate) struct SpawnFailure {
        pub(crate) primary: io::Error,
        pub(crate) cleanup: Option<io::Error>,
        pub(crate) unfinished: Option<WindowsChild>,
    }
    impl From<io::Error> for SpawnFailure {
        fn from(primary: io::Error) -> Self { Self { primary, cleanup: None, unfinished: None } }
    }
    pub(crate) fn spawn(spec: &LaunchSpec, log: File, channel: &ChildEndpoint, data_dir: &Path) -> Result<WindowsChild, SpawnFailure> {
        #[cfg(test)]
        #[cfg(test)]
        { spawn_inner(SpawnInput::Bundled(spec, data_dir), log, channel, Faults::default()) }
        #[cfg(not(test))]
        { spawn_inner(SpawnInput::Bundled(spec, data_dir), log, channel) }
    }
    /// Consumes the sealed plan, using its private data root for both cwd and the record.
    #[cfg(target_arch = "x86_64")]
    #[allow(dead_code)] // No production selector.
    pub(in crate::daemon) fn spawn_explicit(plan: LaunchPlan, log: File,
        channel: &ChildEndpoint) -> Result<WindowsChild, SpawnFailure> {
        #[cfg(test)]
        { spawn_inner(SpawnInput::Split(plan, &SPLIT_SLOT), log, channel, Faults::default()) }
        #[cfg(not(test))]
        { spawn_inner(SpawnInput::Split(plan, &SPLIT_SLOT), log, channel) }
    }
    #[cfg(test)]
    fn spawn_with_faults(spec: &LaunchSpec, log: File, channel: &ChildEndpoint, faults: Faults) -> Result<WindowsChild, SpawnFailure> {
        // Existing fault cases fail before publication; no fixture record is created.
        spawn_inner(SpawnInput::Bundled(spec, Path::new("")), log, channel, faults)
    }
    fn spawn_inner(input: SpawnInput<'_>, log: File, channel: &ChildEndpoint, #[cfg(test)] faults: Faults) -> Result<WindowsChild, SpawnFailure> {
        #[cfg(windows_owner_observation)]
        let mut trace = match &input {
            SpawnInput::Bundled(..) => Trace::open(),
            #[cfg(target_arch = "x86_64")]
            SpawnInput::Split(..) => None,
        };
        #[cfg(target_arch = "x86_64")]
        let mut split = None;
        let (prepared, data_dir) = match input {
            SpawnInput::Bundled(spec, data_dir) => (ChildContext::Bundled(spec)
                .prepare(data_dir, std::env::vars_os)?, Cow::Borrowed(data_dir)),
            #[cfg(target_arch = "x86_64")]
            SpawnInput::Split(plan, slot) => {
                let data_dir = plan.data_dir();
                let prepared = ChildContext::Explicit(ExplicitChildContext {
                    program: plan.program(), args: plan.args(), cwd: data_dir, env: plan.env(),
                }).prepare(data_dir, std::iter::empty)?;
                let data_dir = Cow::Owned(data_dir.to_owned());
                split = Some(slot.reserve(plan)?);
                (prepared, data_dir)
            }
        };
        let PreparedChild { application, mut command, cwd, mut env } = prepared;
        let transfers = Transfers::new(&log, channel)?;
        let mut handles = transfers.handles();
        let mut reserved = transfers.bootstrap()?;
        let mut attributes = Attributes::new(&mut handles)?;
        let job = new_job()?;
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.StartupInfo.cbReserved2 = reserved.len() as u16;
        startup.StartupInfo.lpReserved2 = reserved.as_mut_ptr();
        startup.lpAttributeList = attributes.pointer();
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: all UTF-16, packed descriptor, exact handle-list and attribute buffers
        // remain stable through this call. Null cwd preserves the existing inherited cwd.
        let creation = unsafe {
            checked(CreateProcessW(application.as_ptr(), command.as_mut_ptr(), null(), null(), 1,
                DAEMON_CREATION_FLAGS, env.as_mut_ptr().cast(),
                cwd.as_ref().map_or(null(), |path| path.as_ptr()), &startup.StartupInfo, &mut process))
        };
        #[cfg(windows_owner_observation)]
        if let Some(trace) = trace.as_mut() {
            trace.preparation_failure = creation.as_ref().err().map(|_| Event::CreateFailed);
        }
        creation?;
        // CreateProcessW success guarantees these two handles. Acquire both immediately:
        // no fallible operation may strand the created process before its owner exists.
        let mut child = WindowsChild {
            process: unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
            thread: Some(unsafe { OwnedHandle::from_raw_handle(process.hThread) }), job,
            #[cfg(target_arch = "x86_64")]
            split: split.map(|mut guard| { guard.uncertain = true; guard }),
            pid: process.dwProcessId, assigned: false, failed: false, established: false, record: None, stop: None, stopping: false,
            force_requested: false, completed: false,
            #[cfg(windows_owner_observation)] trace,
            #[cfg(test)] faults,
        };
        #[cfg(windows_owner_observation)]
        let mut failure_event = Event::AssignFailed;
        let setup = (|| -> io::Result<()> {
            #[cfg(test)]
            if child.faults.assignment { return Err(io::Error::other("injected assignment failure")); }
            unsafe { checked(AssignProcessToJobObject(child.job.as_raw_handle(), child.process.as_raw_handle()))?; }
            child.assigned = true;
            #[cfg(windows_owner_observation)]
            { failure_event = Event::VerifyFailed; }
            #[cfg(test)]
            if child.faults.verification { return Err(io::Error::other("injected verification failure")); }
            let mut belongs = 0;
            unsafe { checked(IsProcessInJob(child.process.as_raw_handle(), child.job.as_raw_handle(), &mut belongs))?; }
            if belongs == 0 || job_active(&child.job)? != 1 {
                return Err(io::Error::other("suspended daemon Job ownership not established"));
            }
            // No execution until the exact suspended launch has a protected v1 record.
            // The publication helper installs ownership immediately after CREATE_NEW.
            #[cfg(windows_owner_observation)]
            { failure_event = Event::RecordFailed; }
            child.publish_record(&data_dir)?;
            // Name this app as the Job's only handle holder before the daemon can run.
            #[cfg(windows_owner_observation)]
            { failure_event = Event::PublishFailed; }
            publish_owner(&data_dir, &child.record.as_ref().unwrap().expected)?;
            #[cfg(windows_owner_observation)]
            { failure_event = Event::ResumeFailed; }
            let previous = unsafe { ResumeThread(child.thread.as_ref().unwrap().as_raw_handle()) };
            if previous == u32::MAX { return Err(io::Error::last_os_error()); }
            if previous != 1 { return Err(io::Error::other("unexpected daemon suspension state")); }
            child.established = true;
            drop(child.thread.take());
            Ok(())
        })();
        #[cfg(windows_owner_observation)]
        if let Some(trace) = child.trace.as_ref() {
            trace.launch(if setup.is_ok() { Event::Resumed } else { failure_event });
        }
        if let Err(primary) = setup {
            child.failed = true;
            return match child.shutdown_owned(Duration::ZERO) {
                Ok(()) => Err(SpawnFailure { primary, cleanup: None, unfinished: None }),
                Err(cleanup) => Err(SpawnFailure { primary, cleanup: Some(cleanup), unfinished: Some(child) }),
            };
        }
        Ok(child)
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
    fn unsafe_record_path(path: &Path) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData,
            format!("unsafe Windows stop record path: {}", path.display()))
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
        // Windows treats '/' as a path separator and forbids it inside component names, so
        // every '/' in the string is a separator. Tooling, .env files and cross-platform
        // config routinely spell data dirs with forward slashes; normalize before the shape
        // check so the same components are walked and pinned, instead of refusing a
        // separator spelling as an unsafe shape.
        let mut text: Vec<u16> = name[..name.len() - 1].to_vec();
        for code in &mut text {
            if *code == b'/' as u16 { *code = b'\\' as u16; }
        }
        if text.len() < 4 || text[1] != b':' as u16 || text[2] != b'\\' as u16
            || !((b'A' as u16..=b'Z' as u16).contains(&text[0])
                || (b'a' as u16..=b'z' as u16).contains(&text[0])) {
            return Err(unsafe_record_path(path));
        }
        let root = [text[0], text[1], text[2], 0];
        if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_FIXED { return Err(unsafe_record_path(path)); }
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
                return Err(unsafe_record_path(path));
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

    #[cfg(target_arch = "x86_64")]
    use super::super::startup_readiness::Profile;

    #[cfg(target_arch = "x86_64")]
    fn startup_metadata(path: &Path, directory: bool) -> io::Result<OwnedHandle> {
        let name = wide(path.as_os_str())?;
        let handle = owned(unsafe { CreateFileW(name.as_ptr(), FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
        let info = file_info(handle.as_raw_handle())?;
        if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || (!directory && info.nNumberOfLinks != 1) {
            return Err(unsafe_record());
        }
        Ok(handle)
    }

    #[cfg(target_arch = "x86_64")]
    fn startup_owner(handle: &OwnedHandle, expected: PSID) -> io::Result<bool> {
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        let result = unsafe { GetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(), null_mut(), &mut descriptor) };
        if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32)); }
        let _snapshot = SecuritySnapshot(descriptor);
        if descriptor.is_null() || owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
            return Err(unsafe_record());
        }
        Ok(unsafe { EqualSid(owner, expected) } != 0)
    }

    #[cfg(target_arch = "x86_64")]
    pub(in crate::daemon) fn startup_profile(data_dir: &Path) -> Profile {
        let Ok(sid) = current_user_sid() else { return Profile::Unknown };
        startup_profile_for(data_dir, sid.as_ptr() as PSID)
    }

    #[cfg(target_arch = "x86_64")]
    fn startup_profile_for(data_dir: &Path, expected: PSID) -> Profile {
        let uncertain = |error: io::Error| match error.kind() {
            io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => Profile::Unsafe,
            _ => Profile::Unknown,
        };
        // Pin the existing parents using the launch guard without mkdir. Only
        // absence of the final directory beneath verified parents means `new`.
        let _parents = match record_ancestry(data_dir, false) {
            Ok(parents) => parents,
            Err(error) => return uncertain(error),
        };
        let root = match startup_metadata(data_dir, true) {
            Ok(root) => root,
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => return Profile::New,
            Err(error) => return uncertain(error),
        };
        match startup_owner(&root, expected) {
            Ok(true) => {},
            Ok(false) => return Profile::OwnerMismatch,
            Err(error) => return uncertain(error),
        }
        let mut outcome = Profile::NoConflictFound;
        // Retain verified handles until the sample ends; never open for data access.
        let mut sample = Vec::new();
        for name in ["token", "connectors.json", "state.json"] {
            match startup_metadata(&data_dir.join(name), false).and_then(|file| {
                startup_owner(&file, expected).map(|owned| (file, owned))
            }) {
                Ok((file, true)) => sample.push(file),
                Ok((_, false)) => return Profile::OwnerMismatch,
                Err(error) => match uncertain(error) {
                    Profile::Unsafe => return Profile::Unsafe,
                    _ => outcome = Profile::Unknown,
                },
            }
        }
        outcome
    }

    #[cfg(all(test, target_arch = "x86_64"))]
    #[test]
    fn startup_readiness_checks_only_owned_fixture_metadata() {
        let sample = std::env::temp_dir().join(format!("dot-readiness-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let sid = current_user_sid().unwrap();
        let user = sid.as_ptr() as PSID;
        let descriptor = Descriptor::for_user(user).unwrap();
        let make_dir = |path: &Path| {
            let name = wide(path.as_os_str()).unwrap();
            unsafe { checked(CreateDirectoryW(name.as_ptr(), &descriptor.attributes())).unwrap(); }
        };
        make_dir(&sample);
        let root = sample.join("profile");
        assert_eq!(startup_profile(&root), Profile::New);
        assert!(!root.exists());
        make_dir(&root);
        assert_eq!(startup_profile(&root), Profile::Unknown);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let mut foreign = null_mut();
        let world = wide(std::ffi::OsStr::new("S-1-1-0")).unwrap(); // Everyone
        unsafe { checked(ConvertStringSidToSidW(world.as_ptr(), &mut foreign)).unwrap(); }
        let _foreign_owner = SecuritySnapshot(foreign);
        assert_eq!(startup_profile_for(&root, foreign), Profile::OwnerMismatch);
        let names = ["token", "connectors.json", "state.json"];
        for name in names {
            let mut file = private_file(&root.join(name), GENERIC_WRITE, CREATE_NEW, &descriptor).unwrap();
            std::io::Write::write_all(&mut file, b"inert").unwrap();
        }
        assert_eq!(startup_profile(&root), Profile::NoConflictFound);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), names.len());
        for name in names { assert_eq!(std::fs::read(root.join(name)).unwrap(), b"inert"); }
        std::fs::hard_link(root.join("token"), sample.join("linked-token")).unwrap();
        assert_eq!(startup_profile(&root), Profile::Unsafe);
        assert_eq!(std::fs::read(root.join("token")).unwrap(), b"inert");
        let unsafe_root = sample.join("unsafe");
        make_dir(&unsafe_root);
        make_dir(&unsafe_root.join("state.json"));
        assert_eq!(startup_profile(&unsafe_root), Profile::Unsafe);
        assert_eq!(std::fs::read_dir(&unsafe_root).unwrap().count(), 1);
        // Retain only the inert, current-user-owned fixture under the test app's temp root.
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

    const OWNER_FILE: &str = "daemon.owner";

    fn read_owner_file(file: &mut File) -> io::Result<super::super::windows_record::Owner> {
        use super::super::windows_record::{Owner, OWNER_MAX_BYTES};
        Owner::parse(&read_protected(file, OWNER_MAX_BYTES)?.0)
    }

    fn process_created(handle: HANDLE) -> io::Result<u64> {
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        unsafe { checked(GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user))?; }
        Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }

    /// Written only while this launch exclusively holds its newly created record and
    /// before the daemon resumes. A previous launch's witness, left without its record,
    /// has no authority and is removed by handle without following a reparse point.
    fn publish_owner(data_dir: &Path, record: &super::super::windows_record::Record) -> io::Result<()> {
        use super::super::windows_record::Owner;
        use std::io::Write;
        let path = data_dir.join(OWNER_FILE);
        let _ancestry = record_ancestry(&path, false)?;
        let name = wide(path.as_os_str())?;
        let stale = unsafe { CreateFileW(name.as_ptr(), DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
            null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if stale == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_FILE_NOT_FOUND as i32) { return Err(error); }
        } else {
            let stale = owned(stale)?;
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe { checked(SetFileInformationByHandle(stale.as_raw_handle(), FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of_val(&disposition) as u32))?; }
        }
        let owner = Owner::new(record.nonce(), unsafe { GetCurrentProcessId() },
            process_created(unsafe { GetCurrentProcess() })?)?;
        let sid = current_user_sid()?;
        let descriptor = Descriptor::for_user(sid.as_ptr() as PSID)?;
        // CREATE_NEW also fails while another reader defers the stale file's deletion.
        let mut file = File::from(owned(unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ, &descriptor.attributes(), CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?);
        file.write_all(&owner.encode())?;
        file.sync_all()?;
        if read_owner_file(&mut file)? != owner { return Err(unsafe_record()); }
        Ok(())
    }

    fn read_validated_owner(data_dir: &Path) -> io::Result<Option<super::super::windows_record::Owner>> {
        let path = data_dir.join(OWNER_FILE);
        let _ancestry = record_ancestry(&path, false)?;
        let name = wide(path.as_os_str())?;
        let raw = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
            null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) { return Ok(None); }
            return Err(error);
        }
        read_owner_file(&mut File::from(owned(raw)?)).map(Some)
    }

    fn snapshot_contains(pid: u32) -> io::Result<bool> {
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        unsafe { checked(Process32FirstW(snapshot.as_raw_handle(), &mut entry))?; }
        loop {
            if entry.th32ProcessID == pid { return Ok(true); }
            if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) { return Ok(false); }
                return Err(error);
            }
        }
    }

    enum Observed { Gone, Exited, Running(OwnedHandle) }
    /// Exact-identity state, never a termination route. OpenProcess error 87 alone is
    /// not absence: a full process snapshot must also lack the PID. A different creation
    /// time means the PID was reused, which the recorded process object cannot outlive.
    fn observe_process(pid: u32, created: u64) -> io::Result<Observed> {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) && !snapshot_contains(pid)? {
                return Ok(Observed::Gone);
            }
            return Err(error);
        }
        let process = owned(raw)?;
        if process_created(process.as_raw_handle())? != created { return Ok(Observed::Gone); }
        match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(Observed::Exited),
            WAIT_TIMEOUT => Ok(Observed::Running(process)),
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// Retires a stop record only when its bound witness names an app process that has
    /// exited. That process held the only handle to the launch's KILL_ON_JOB_CLOSE Job, and
    /// Windows closes a process's handles before signaling its exit, so the kernel already
    /// terminated every process in that Job. Nothing is terminated here; processes created
    /// outside the Job (WMI, Task Scheduler, COM) were never part of the owned group.
    ///
    /// Ok(false) only when there is no readable record or no witness at all (a legacy v1
    /// launch), which keeps the existing admission route. A witnessed launch whose owner
    /// lives, or whose witness is invalid, unbound or unverifiable, is refused: the recovered
    /// stop route proves only root exit, and a live owner keeps its Job's descendants alive.
    pub(crate) fn retire_if_owner_exited(data_dir: &Path) -> io::Result<bool> {
        let Ok(Some(mut record)) = read_validated_record(data_dir) else { return Ok(false) };
        let owner = match read_validated_owner(data_dir) {
            Ok(None) => return Ok(false),
            Ok(Some(owner)) => owner,
            Err(_) => return Err(recovery_error("Windows owner witness is invalid or unreadable; record retained")),
        };
        if !owner.binds(&record.record) {
            return Err(recovery_error("Windows owner witness does not match the recorded launch; record retained"));
        }
        match observe_process(owner.pid, owner.created) {
            Ok(Observed::Gone | Observed::Exited) => {}
            Ok(Observed::Running(_)) => return Err(recovery_error(
                "the previous launch's owning app is still running; record retained")),
            Err(_) => return Err(recovery_error("Windows owner state is unverifiable; record retained")),
        }
        // Termination is asynchronous and waits for pending I/O: never overlap a root that
        // is still finishing. A root that keeps running contradicts the proof; refuse.
        match observe_process(record.record.pid, record.record.created)? {
            Observed::Gone | Observed::Exited => {}
            Observed::Running(root) => match unsafe {
                WaitForSingleObject(root.as_raw_handle(), RECOVERED_STOP_LIMIT.as_millis() as u32)
            } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => return Err(recovery_error(
                    "recorded Windows root is still running after its owner exited; record retained")),
                _ => return Err(io::Error::last_os_error()),
            },
        }
        delete_exact_record(&record.path, &record.record, record.identity, &mut record.file, &mut record.deletion_marked)?;
        Ok(true)
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

    // Hard cap on any caller's stop budget: the stop deadline is also how long a
    // capability-bearing connection may be pending. Callers choose their own grace
    // (the lifecycle passes its shutdown grace); this module only shortens it.
    const RECOVERED_STOP_LIMIT: Duration = Duration::from_secs(10);
    const RECOVERY_POLL: Duration = Duration::from_millis(10);

    fn recovery_error(message: &'static str) -> io::Error { io::Error::other(message) }
    fn require_launch_identity(pid: u32, created: u64, observed_pid: u32, observed_created: u64) -> io::Result<()> {
        if pid != observed_pid || created != observed_created {
            return Err(recovery_error("recorded Windows process identity does not match"));
        }
        Ok(())
    }
    fn require_frame_size(transferred: u32) -> io::Result<()> {
        if transferred != 36 { return Err(recovery_error("Windows stop frame was not written exactly")); }
        Ok(())
    }

    /// Failure is not absence. Even a failed OpenProcess retains validated provenance;
    /// identity mismatch/death retains the opened handle without admitting a stop request.
    /// Neither this error nor its owner implements Debug (the record holds a capability).
    pub(crate) struct RecoveryFailure {
        pub(crate) error: io::Error,
        pub(crate) retained: Option<RecoveredLaunch>,
    }
    pub(crate) struct RecoveredLaunch {
        record: Option<ValidatedRecord>,
        process: Option<OwnedHandle>,
        admitted: bool,
        connect: Option<ConnectAttempt>,
        write: Option<PendingStopWrite>,
        attempted: bool,
        written: bool,
        clean_exit: bool,
    }

    pub(crate) fn acquire_recovered_launch(data_dir: &Path) -> Result<Option<RecoveredLaunch>, RecoveryFailure> {
        let record = match read_validated_record(data_dir) {
            Ok(None) => return Ok(None),
            Ok(Some(record)) => record,
            Err(error) => return Err(RecoveryFailure { error, retained: None }),
        };
        let mut owner = RecoveredLaunch { record: Some(record), process: None, admitted: false,
            connect: None, write: None, attempted: false, written: false, clean_exit: false };
        let acquisition = (|| -> io::Result<()> {
            let pid = owner.record.as_ref().unwrap().record.pid;
            // Exactly one non-inheritable open. No termination, enumeration, privilege
            // adjustment, or reopen-by-PID path exists, including on acquisition failure.
            owner.process = Some(owned(unsafe { OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) })
                .map_err(|error| AcquisitionStage::ProcessOpen.error(error))?);
            owner.require_live().map_err(|error| AcquisitionStage::ProcessAdmission.error(error))?;
            owner.admitted = true;
            Ok(())
        })();
        match acquisition {
            Ok(()) => Ok(Some(owner)),
            Err(error) => Err(RecoveryFailure { error, retained: Some(owner) }),
        }
    }

    impl RecoveredLaunch {
        fn process_handle(&self) -> io::Result<HANDLE> {
            self.process.as_ref().map(AsRawHandle::as_raw_handle)
                .ok_or_else(|| recovery_error("recorded Windows process handle was not acquired"))
        }
        fn require_identity(&self) -> io::Result<HANDLE> {
            let handle = self.process_handle()?;
            let pid = unsafe { GetProcessId(handle) };
            if pid == 0 { return Err(io::Error::last_os_error()); }
            let mut created: FILETIME = unsafe { std::mem::zeroed() };
            let mut exited = created; let mut kernel = created; let mut user = created;
            unsafe { checked(GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user))?; }
            let record = &self.record.as_ref().unwrap().record;
            require_launch_identity(record.pid, record.created, pid,
                ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)?;
            Ok(handle)
        }
        fn require_live(&self) -> io::Result<()> {
            let handle = self.require_identity()?;
            match unsafe { WaitForSingleObject(handle, 0) } {
                WAIT_TIMEOUT => Ok(()),
                WAIT_OBJECT_0 => Err(recovery_error("recorded Windows process is already exited")),
                _ => Err(io::Error::last_os_error()),
            }
        }
        fn observe_exit(&mut self) -> io::Result<bool> {
            let handle = self.require_identity()?;
            match unsafe { WaitForSingleObject(handle, 0) } {
                WAIT_TIMEOUT => Ok(false),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    unsafe { checked(GetExitCodeProcess(handle, &mut code))?; }
                    if code != 0 { return Err(recovery_error("recorded Windows process did not exit cleanly")); }
                    self.clean_exit = true;
                    Ok(true)
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
        pub(crate) fn delete_record(&mut self) -> io::Result<()> {
            if !self.clean_exit || self.connect.is_some() || self.write.is_some() || !self.observe_exit()? {
                return Err(recovery_error("recorded Windows clean exit/client drain is not established"));
            }
            let record = self.record.as_mut().unwrap();
            // Ancestry stays installed while the read guard is replaced by a separately
            // validated DELETE handle. Root completion never stands for descendant proof.
            delete_exact_record(&record.path, &record.record, record.identity,
                &mut record.file, &mut record.deletion_marked)
        }

        fn stop_until(&mut self, deadline: Instant) -> io::Result<()> {
            if !self.admitted { return Err(recovery_error("recorded Windows launch was not admitted")); }
            loop {
                // Resolve outstanding open/write results before considering clean exit.
                // Open-result delivery is not thread termination: worker owners remain
                // process-lifetime retained. Root exit never proves I/O cancellation.
                if let Some(write) = self.write.as_mut() {
                    if let Some(result) = write.poll()? {
                        self.write.take();
                        result?;
                        self.written = true;
                    }
                }
                if let Some(connect) = self.connect.as_mut() {
                    if let Some(result) = connect.poll()? {
                        self.connect.take();
                        let pipe = result?;
                        // A clean exit before the server check already achieved the stop.
                        // Return without writing: the opened pipe is dropped unauthenticated.
                        if self.observe_exit()? { return Ok(()); }
                        if Instant::now() >= deadline {
                            return Err(io::Error::new(io::ErrorKind::TimedOut, "Windows stop connection deadline elapsed"));
                        }
                        let mut server = 0;
                        unsafe { checked(GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server))?; }
                        let process = self.require_identity()?;
                        if server != unsafe { GetProcessId(process) } {
                            return Err(recovery_error("Windows stop pipe server identity does not match"));
                        }
                        // Verify the retained exact handle again immediately before send.
                        self.require_live()?;
                        if Instant::now() >= deadline {
                            return Err(io::Error::new(io::ErrorKind::TimedOut, "Windows stop write deadline elapsed"));
                        }
                        let frame = self.record.as_ref().unwrap().record.frame();
                        self.attempted = true;
                        self.write = Some(PendingStopWrite::submit(pipe, frame)?);
                    }
                }
                if self.connect.is_none() && self.write.is_none() {
                    if self.observe_exit()? { return Ok(()); }
                    if self.attempted && !self.written {
                        return Err(recovery_error("Windows stop write failed; replacement remains refused"));
                    }
                    if !self.attempted && Instant::now() < deadline {
                        self.require_live()?;
                        let name = wide(std::ffi::OsStr::new(&self.record.as_ref().unwrap().record.pipe_name()))?;
                        self.connect = Some(ConnectAttempt::start(name, deadline)?);
                    }
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "recorded Windows stop completion was not established"));
                }
                std::thread::sleep(RECOVERY_POLL.min(remaining));
            }
        }
        // Owned fallback only: settle native operations, not authenticated delivery or
        // worker/TLS retirement. ConnectAttempt retains its pinned inert worker lifetime.
        fn settle_owned_io(&mut self, timeout: Duration) -> io::Result<()> {
            let deadline = Instant::now() + timeout;
            if let Some(connect) = &self.connect { connect.cancel(); }
            if let Some(write) = &self.write { write.cancel()?; }
            loop {
                if let Some(connect) = &mut self.connect {
                    match connect.result.try_recv() {
                        Ok(result) => {
                            // A late open is closed, never converted into a stop write.
                            drop(result);
                            self.connect.take();
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {}
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => return Err(recovery_error(
                            "owned Windows stop connection result is unconfirmed")),
                    }
                }
                if let Some(write) = &mut self.write {
                    if write.poll()?.is_some() {
                        // Both delivered and aborted writes have ended kernel ownership.
                        self.write.take();
                    }
                }
                if self.connect.is_none() && self.write.is_none() { return Ok(()); }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(io::ErrorKind::TimedOut,
                        "owned Windows stop I/O completion is unconfirmed"));
                }
                std::thread::sleep(RECOVERY_POLL.min(remaining));
            }
        }
        /// One total bounded budget for connection, asynchronous write, and exact-root
        /// clean exit. Errors keep this owner installed; retries never reopen its PID or
        /// resend an uncertain/failed frame. No record is mutated by this method.
        pub(crate) fn stop(&mut self, timeout: Duration) -> io::Result<()> {
            let result = self.stop_until(Instant::now() + timeout.min(RECOVERED_STOP_LIMIT));
            if result.is_err() {
                if let Some(connect) = &self.connect { connect.cancel(); }
                if let Some(write) = &self.write {
                    if let Err(cancel) = write.cancel() {
                        return Err(recovery_error_with_cancel(result.unwrap_err(), cancel));
                    }
                }
            }
            result
        }
    }
    fn recovery_error_with_cancel(primary: io::Error, cancel: io::Error) -> io::Error {
        io::Error::other(format!("{primary}; Windows stop cancellation unconfirmed: {cancel}"))
    }
    impl Drop for RecoveredLaunch {
        fn drop(&mut self) {
            if self.connect.is_some() || self.write.is_some() {
                if let Some(connect) = &self.connect { connect.cancel(); }
                if let Some(write) = &self.write { let _ = write.cancel(); }
                // Defensive process-lifetime retention if a caller discards uncertainty.
                // Preserve provenance/process AND native/thread I/O owners together;
                // never join, close handles, or free kernel-referenced storage here.
                std::mem::forget(Box::new((self.record.take(), self.process.take(),
                    self.connect.take(), self.write.take())));
            }
        }
    }

    fn pin_recovery_module() -> io::Result<()> {
        // LibraryLoader is not an enabled windows-sys feature. Bind only this
        // documented Kernel32 ABI locally, without changing dependency features.
        // FROM_ADDRESS interprets lpModuleName as a code address, not a string;
        // PIN keeps our worker/drop code loaded until process exit, even in a DLL.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut HMODULE) -> i32;
        }
        const FROM_ADDRESS: u32 = 0x00000004;
        const PIN: u32 = 0x00000001;
        let mut module = null_mut();
        unsafe { checked(GetModuleHandleExW(FROM_ADDRESS | PIN,
            pin_recovery_module as *const () as *const u16, &mut module))?; }
        if module.is_null() { return Err(recovery_error("Windows recovery module lifetime was not retained")); }
        Ok(())
    }

    /// FILE_FLAG_OVERLAPPED does not make CreateFileW itself cancellable. Isolate
    /// that open on an explicitly owned worker; the controller never blocks joining it.
    /// At most one unresolved open exists per retained recovered owner. Workers never
    /// send frames; after result delivery their lifetime is retained until process exit.
    struct ConnectAttempt {
        thread: Option<std::thread::JoinHandle<()>>,
        result: std::sync::mpsc::Receiver<io::Result<OwnedHandle>>,
        cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }
    impl ConnectAttempt {
        fn start(name: Vec<u16>, deadline: Instant) -> io::Result<Self> {
            use std::sync::atomic::{AtomicBool, Ordering};
            pin_recovery_module()?;
            let cancelled = std::sync::Arc::new(AtomicBool::new(false));
            let flag = cancelled.clone();
            let (sender, result) = std::sync::mpsc::channel();
            let thread = std::thread::Builder::new().name("gentle-dot-stop-connect".into()).spawn(move || {
                let outcome = (|| -> io::Result<OwnedHandle> {
                    loop {
                        if flag.load(Ordering::Acquire) || Instant::now() >= deadline {
                            return Err(io::Error::new(io::ErrorKind::TimedOut, "Windows stop pipe connection unfinished"));
                        }
                        // Derived local name only. Narrow WRITE_DATA omits CREATE_PIPE_INSTANCE;
                        // null security attributes means non-inheritable. Identification SQOS
                        // prevents the server acquiring an impersonation/delegation token.
                        let raw = unsafe { CreateFileW(name.as_ptr(), FILE_WRITE_DATA, 0, null(), OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) };
                        if raw != INVALID_HANDLE_VALUE { return owned(raw); }
                        let error = io::Error::last_os_error();
                        if !matches!(error.raw_os_error(), Some(code) if code == ERROR_PIPE_BUSY as i32 || code == ERROR_FILE_NOT_FOUND as i32) {
                            return Err(error);
                        }
                        std::thread::sleep(RECOVERY_POLL.min(deadline.saturating_duration_since(Instant::now())));
                    }
                })();
                let _ = sender.send(outcome);
            })?;
            Ok(Self { thread: Some(thread), result, cancelled })
        }
        fn cancel(&self) { self.cancelled.store(true, std::sync::atomic::Ordering::Release); }
        fn poll(&mut self) -> io::Result<Option<io::Result<OwnedHandle>>> {
            // Delivery transfers the sole open result, not thread/TLS completion.
            // Neither is_finished nor join can establish a bounded retirement here.
            match self.result.try_recv() {
                Ok(result) => Ok(Some(result)),
                Err(std::sync::mpsc::TryRecvError::Empty) => Ok(None),
                Err(std::sync::mpsc::TryRecvError::Disconnected) =>
                    Ok(Some(Err(recovery_error("Windows stop connection result was not retained")))),
            }
        }
    }
    impl Drop for ConnectAttempt {
        fn drop(&mut self) {
            self.cancel();
            if self.thread.is_some() {
                // No portable nonblocking proof of OS-thread/TLS retirement exists.
                // Retain the worker, receiver and cancellation state until process exit,
                // even after delivery/disconnection. An unconsumed late handle stays
                // owned in the queue; the already-pinned module cannot unload beneath
                // the worker. Never join in the deadline-bearing controller or Drop.
                let (sender, empty) = std::sync::mpsc::channel(); drop(sender);
                std::mem::forget(Box::new((self.thread.take(),
                    std::mem::replace(&mut self.result, empty), self.cancelled.clone())));
            }
        }
    }

    struct StopWriteStorage {
        operation: std::cell::UnsafeCell<OVERLAPPED>,
        frame: [u8; 36],
        _event: OwnedHandle,
        pipe: OwnedHandle,
    }
    // SAFETY: the unique controller may move the Box between threads, never its
    // allocation. Only Windows accesses the mutable OVERLAPPED through UnsafeCell;
    // frame/event/pipe remain stable until independently observed completion.
    unsafe impl Send for StopWriteStorage {}
    struct PendingStopWrite { storage: Option<Box<StopWriteStorage>> }
    impl PendingStopWrite {
        fn submit(pipe: OwnedHandle, frame: [u8; 36]) -> io::Result<Self> {
            let event = owned(unsafe { CreateEventW(null(), 1, 0, null()) })?;
            let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
            operation.hEvent = event.as_raw_handle();
            let mut this = Self { storage: Some(Box::new(StopWriteStorage {
                operation: std::cell::UnsafeCell::new(operation), frame, _event: event, pipe })) };
            let storage = this.storage.as_ref().unwrap();
            // One message, one WriteFile, never partial-write retries. All referenced
            // storage is heap-stable before submission; NULL byte count for overlapped I/O.
            if unsafe { WriteFile(storage.pipe.as_raw_handle(), storage.frame.as_ptr(), 36,
                null_mut(), storage.operation.get()) } != 0 { return Ok(this); }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) { return Ok(this); }
            // WriteFile rejected submission: no outstanding OVERLAPPED was established.
            this.storage.take();
            Err(error)
        }
        fn poll(&mut self) -> io::Result<Option<io::Result<()>>> {
            let storage = self.storage.as_ref().unwrap();
            let mut transferred = 0;
            if unsafe { GetOverlappedResult(storage.pipe.as_raw_handle(), storage.operation.get(), &mut transferred, 0) } != 0 {
                self.storage.take();
                return Ok(Some(require_frame_size(transferred)));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) { return Ok(None); }
            if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) {
                self.storage.take();
                return Ok(Some(Err(error)));
            }
            // An unexpected query failure does not prove that kernel ownership ended.
            Err(error)
        }
        fn cancel(&self) -> io::Result<()> {
            let storage = self.storage.as_ref().unwrap();
            if unsafe { CancelIoEx(storage.pipe.as_raw_handle(), storage.operation.get()) } != 0 { return Ok(()); }
            let error = io::Error::last_os_error();
            // NOT_FOUND is not a completion result either. Storage stays retained.
            if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) { return Ok(()); }
            Err(error)
        }
    }
    impl Drop for PendingStopWrite {
        fn drop(&mut self) {
            if self.storage.is_some() {
                let _ = self.cancel();
                std::mem::forget(self.storage.take());
            }
        }
    }

    #[cfg(test)]
    mod recovery_contract_tests {
        use super::{require_complete_record, require_frame_size, require_launch_identity, AcquisitionStage, FileIdentity};
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
        #[test]
        fn pid_reuse_or_creation_mismatch_is_not_exact_identity() {
            assert!(require_launch_identity(42, 123, 42, 123).is_ok());
            assert!(require_launch_identity(42, 123, 43, 123).is_err());
            assert!(require_launch_identity(42, 123, 42, 124).is_err());
        }
        #[test]
        fn only_a_complete_single_frame_is_accepted() {
            assert!(require_frame_size(36).is_ok());
            for count in [0, 1, 35, 37, u32::MAX] { assert!(require_frame_size(count).is_err()); }
        }
    }

    /// Only for an exclusively new preview directory, never adoption or repair.
    #[cfg(feature = "local-preview")]
    pub(crate) fn create_private_preview_directory(path: &Path) -> io::Result<()> {
        let sid = current_user_sid()?;
        let descriptor = Descriptor::for_user(sid.as_ptr() as PSID)?;
        let name = wide(path.as_os_str())?;
        let attributes = descriptor.attributes();
        unsafe { checked(CreateDirectoryW(name.as_ptr(), &attributes)) }
    }

    /// Give only a newly created preview config explicit, protected TokenUser permissions.
    #[cfg(feature = "local-preview")]
    pub(crate) fn create_private_preview_config(path: &Path) -> io::Result<File> {
        let sid = current_user_sid()?;
        let descriptor = Descriptor::for_user(sid.as_ptr() as PSID)?;
        private_file(path, GENERIC_WRITE, CREATE_NEW, &descriptor)
    }

    #[cfg(all(test, feature = "local-preview"))]
    mod preview_directory_tests {
        use super::*;
        use std::cell::Cell;
        use std::time::{SystemTime, UNIX_EPOCH};

        fn user_owns(path: &Path, expected: PSID) -> io::Result<bool> {
            let name = wide(path.as_os_str())?;
            let handle = owned(unsafe { CreateFileW(name.as_ptr(), READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
            let mut owner = null_mut();
            let mut descriptor = null_mut();
            let result = unsafe { GetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(), null_mut(), &mut descriptor) };
            if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32)); }
            let _snapshot = SecuritySnapshot(descriptor);
            Ok(!owner.is_null() && unsafe { EqualSid(owner, expected) } != 0)
        }

        fn config_fixture(label: &str) -> (crate::preview::OwnedRoot, PathBuf) {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let parent = std::env::temp_dir().join(format!("dot-preview-config-{label}-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&parent).unwrap();
            let root = parent.join("gentle-dot-preview-config");
            let preview = crate::preview::prepare(crate::preview::IDENTIFIER,
                Some(crate::preview::PRODUCT_NAME), false, 0, Some(&root),
                |path| create_private_preview_directory(path).map_err(|error| error.to_string()),
                |path| crate::windows_process::private_directory(path).map_err(|error| error.to_string()),
            ).unwrap();
            (preview, parent)
        }

        fn config_access_masks(path: &Path) -> Vec<u32> {
            let file = File::open(path).unwrap();
            let sid = current_user_sid().unwrap();
            validate_record_security(file.as_raw_handle(), sid.as_ptr() as PSID).unwrap();
            let mut acl = null_mut();
            let mut descriptor = null_mut();
            let result = unsafe { GetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut descriptor) };
            assert_eq!(result, ERROR_SUCCESS);
            let _snapshot = SecuritySnapshot(descriptor);
            assert!(!acl.is_null());
            (0..unsafe { (*acl).AceCount }).map(|index| {
                let mut raw = null_mut();
                unsafe {
                    checked(GetAce(acl, index as u32, &mut raw)).unwrap();
                    (*raw.cast::<ACCESS_ALLOWED_ACE>()).Mask
                }
            }).collect()
        }

        #[test]
        fn preview_config_remains_private_and_readable_after_log_open() {
            let (preview, parent) = config_fixture("read");
            let config = crate::config::load_preview_config(&preview).unwrap();
            assert_eq!(config.port, 17417);
            let path = preview.data_dir().join("config.json");
            let before = std::fs::read(&path).unwrap();
            assert_eq!(before, b"{\n  \"memory\": \"private\"\n}\n");
            drop(crate::daemon::open_private_log(preview.data_dir()).unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), before,
                "log setup must leave the preview config readable and unchanged");
            assert_eq!(config_access_masks(&path), vec![0x001f01ff],
                "config must retain one explicit, protected full-access ACE for TokenUser only");
            std::fs::remove_dir_all(parent).unwrap();
        }

        #[test]
        fn preview_config_refuses_existing_file_without_changing_it() {
            use std::io::Write as _;
            let (preview, parent) = config_fixture("existing");
            let path = preview.data_dir().join("config.json");
            let sid = current_user_sid().unwrap();
            let descriptor = Descriptor::for_user(sid.as_ptr() as PSID).unwrap();
            let mut file = private_file(&path, GENERIC_WRITE, CREATE_NEW, &descriptor).unwrap();
            let before = b"{\"sentinel\":true,\"memory\":\"private\"}\n";
            file.write_all(before).unwrap();
            file.sync_all().unwrap();
            drop(file);
            let security = config_access_masks(&path);
            let count = std::fs::read_dir(preview.data_dir()).unwrap().count();
            assert!(crate::config::load_preview_config(&preview).is_err(),
                "fresh preview initialization must not adopt or rewrite an existing file");
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(config_access_masks(&path), security);
            assert_eq!(std::fs::read_dir(preview.data_dir()).unwrap().count(), count);
            std::fs::remove_dir_all(parent).unwrap();
        }

        #[test]
        fn preview_prepares_windows_and_webview_directories_before_first_use() {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let parent = std::env::temp_dir().join(format!("dot-preview-profile-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&parent).unwrap();
            let root = parent.join("gentle-dot-preview-profile");
            let preview = crate::preview::prepare(crate::preview::IDENTIFIER,
                Some(crate::preview::PRODUCT_NAME), false, 0, Some(&root),
                |path| create_private_preview_directory(path).map_err(|error| error.to_string()),
                |path| crate::windows_process::private_directory(path).map_err(|error| error.to_string()),
            ).unwrap();
            preview.prepare_environment(
                |path| create_private_preview_directory(path).map_err(|error| error.to_string()),
                |path| crate::windows_process::private_directory(path).map_err(|error| error.to_string()),
            ).unwrap();
            let sid = current_user_sid().unwrap();
            for path in [root.join("home").join("AppData").join("Roaming"),
                root.join("home").join("AppData").join("Local"), preview.webview_dir().join("EBWebView")] {
                // Model a Windows consumer's ordinary first-use mkdir, without repairing ownership.
                std::fs::create_dir_all(&path).unwrap();
                assert!(user_owns(&path, sid.as_ptr() as PSID).unwrap(),
                    "runtime profile directory must already belong to TokenUser");
            }
        }

        #[test]
        fn preview_directories_use_token_user_and_reject_existing_root() {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let parent = std::env::temp_dir().join(format!("dot-preview-owner-{}-{nonce}", std::process::id()));
            std::fs::create_dir(&parent).unwrap();
            let root = parent.join("gentle-dot-preview-owner");
            let calls = Cell::new(0);
            let admit = || crate::preview::prepare(crate::preview::IDENTIFIER,
                Some(crate::preview::PRODUCT_NAME), false, 0, Some(&root),
                |path| create_private_preview_directory(path).map_err(|error| error.to_string()), |path| {
                    calls.set(calls.get() + 1);
                    crate::windows_process::private_directory(path).map_err(|error| error.to_string())
                });
            let preview = admit().unwrap();
            preview.prepare_environment(
                |path| create_private_preview_directory(path).map_err(|error| error.to_string()),
                |path| crate::windows_process::private_directory(path).map_err(|error| error.to_string()),
            ).unwrap();
            let sid = current_user_sid().unwrap();
            assert!(user_owns(&root, sid.as_ptr() as PSID).unwrap(), "fresh preview root must belong to TokenUser");
            assert!(user_owns(&root.join("home"), sid.as_ptr() as PSID).unwrap(), "fresh preview home must belong to TokenUser");
            let sentinel = root.join("sentinel");
            std::fs::write(&sentinel, b"unchanged").unwrap();
            let entries = std::fs::read_dir(&root).unwrap().count();
            let before = calls.get();
            assert!(admit().is_err());
            assert_eq!(calls.get(), before, "existing root must not reach the protection callback");
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), entries);
            assert!(user_owns(&root, sid.as_ptr() as PSID).unwrap());
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
    fn private_file(path: &Path, access: u32, disposition: u32, descriptor: &Descriptor) -> io::Result<File> {
        let name = wide(path.as_os_str())?;
        let attributes = descriptor.attributes();
        let handle = owned(unsafe { CreateFileW(name.as_ptr(), access | READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        unsafe { checked(GetFileInformationByHandle(handle.as_raw_handle(), &mut info))?; }
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(io::Error::other("private daemon file must be regular and not a reparse point"));
        }
        let result = unsafe { SetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(), null_mut(), descriptor.dacl()?, null_mut()) };
        if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32)); }
        Ok(File::from(handle))
    }
    /// The daemon itself opens this directory by path (its token, config and logs), without
    /// an inherited handle. An OWNER RIGHTS entry would follow the owner, which is the
    /// Administrators group when an elevated app created it, and then shut out the same
    /// user unelevated. Both the directory and the log name the user's SID instead.
    pub(crate) fn open_private_log(data_dir: &Path) -> io::Result<File> {
        let sid = current_user_sid()?;
        let descriptor = Descriptor::for_user(sid.as_ptr() as PSID)?;
        if let Some(parent) = data_dir.parent().filter(|path| !path.as_os_str().is_empty()) { std::fs::create_dir_all(parent)?; }
        let name = wide(data_dir.as_os_str())?;
        let attributes = descriptor.attributes();
        if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) { return Err(error); }
        }
        // Repair the exact directory handle, not a path checked earlier. Omitting share-delete
        // keeps it from being renamed/replaced while the private log is opened beneath it.
        let directory = owned(unsafe { CreateFileW(name.as_ptr(), READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        unsafe { checked(GetFileInformationByHandle(directory.as_raw_handle(), &mut info))?; }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("private daemon directory must not be a reparse point"));
        }
        let result = unsafe { SetSecurityInfo(directory.as_raw_handle(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(), null_mut(), descriptor.dacl()?, null_mut()) };
        if result != ERROR_SUCCESS { return Err(io::Error::from_raw_os_error(result as i32)); }
        private_file(&data_dir.join("daemon.log"), FILE_APPEND_DATA | SYNCHRONIZE, OPEN_ALWAYS, &descriptor)
    }
    struct OwnedRecord {
        expected: super::super::windows_record::Record,
        identity: Option<FileIdentity>,
        path: PathBuf,
        file: Option<File>,
        _ancestry: Vec<OwnedHandle>,
        deletion_marked: bool,
    }
    impl WindowsChild {
        fn publish_record(&mut self, data_dir: &Path) -> io::Result<()> {
            use super::super::windows_record::Record;
            use std::io::Write;
            let mut random = [0u8; 48];
            getrandom::fill(&mut random).map_err(|_| recovery_error("launch record randomness unavailable"))?;
            let expected = Record::new(self.pid, self.started_owned()?,
                random[..16].try_into().unwrap(), random[16..].try_into().unwrap())?;
            let path = data_dir.join(super::super::PID_FILE);
            let ancestry = record_ancestry(&path, false)?;
            let sid = current_user_sid()?;
            let descriptor = Descriptor::for_user(sid.as_ptr() as PSID)?;
            let name = wide(path.as_os_str())?;
            let file = File::from(owned(unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ, &descriptor.attributes(), CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) })?);
            // Install before any information/write/flush query can fail. Never overwrite
            // an unresolved record, nor discard ownership of a partially written one.
            self.record = Some(OwnedRecord { expected, identity: None, path, file: Some(file),
                _ancestry: ancestry, deletion_marked: false });
            let record = self.record.as_mut().unwrap();
            let file = record.file.as_mut().unwrap();
            let info = file_info(file.as_raw_handle())?;
            record.identity = Some(FileIdentity::from_handle(file.as_raw_handle(), &info)?);
            file.write_all(&record.expected.encode())?;
            file.sync_all()?;
            // A writer must not survive ResumeThread: addon opens with FILE_SHARE_READ.
            drop(record.file.take());
            let raw = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
                null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            record.file = Some(File::from(owned(raw)?));
            let (observed, identity) = read_record_file(record.file.as_mut().unwrap())?;
            require_complete_record(record.identity.ok_or_else(unsafe_record)?, &record.expected, identity, &observed)

        }
        fn finish_record(&mut self) -> io::Result<()> {
            if self.record.is_none() { return Ok(()); }
            // Only this retained created-process/Job owner may retire a forced exit.
            // RecoveredLaunch::delete_record still requires its separate clean exit.
            if !self.completed || self.status()?.is_none() || self.query()? != 0 {
                return Err(recovery_error("owned Windows root/Job completion is unconfirmed; record retained"));
            }
            let pid = unsafe { GetProcessId(self.process.as_raw_handle()) };
            if pid == 0 { return Err(io::Error::last_os_error()); }
            let created = self.started_owned()?;
            let record = self.record.as_mut().unwrap();
            require_launch_identity(record.expected.pid, record.expected.created, pid, created)?;
            let identity = record.identity.ok_or_else(|| recovery_error("published Windows file identity is unconfirmed"))?;
            delete_exact_record(&record.path, &record.expected, identity, &mut record.file, &mut record.deletion_marked)
        }
    }

    fn delete_exact_record(path: &Path, expected: &super::super::windows_record::Record,
        identity: FileIdentity, guard: &mut Option<File>, marked: &mut bool) -> io::Result<()> {
        let name = wide(path.as_os_str())?;
        if !*marked {
            // Callers retain ancestry and checked exact-process completion throughout.
            // The old reader disallows DELETE; close only that guard before reopening.
            drop(guard.take());
            let raw = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | READ_CONTROL | DELETE,
                FILE_SHARE_READ, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            *guard = Some(File::from(owned(raw)?));
            let file = guard.as_mut().unwrap();
            let (observed, observed_identity) = read_record_file(file)?;
            require_complete_record(identity, expected, observed_identity, &observed)?;
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe { checked(SetFileInformationByHandle(file.as_raw_handle(), FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of_val(&disposition) as u32))?; }
            *marked = true;
            drop(guard.take());
        }
        // Mark-for-delete alone is not reclamation: another reader may defer deletion.
        // Only absence confirms retirement. Once marked, never delete a path replacement.
        let raw = unsafe { CreateFileW(name.as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
            null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) { return Ok(()); }
            return Err(error);
        }
        drop(owned(raw)?);
        Err(recovery_error("Windows launch record deletion/absence is not confirmed"))
    }

    #[cfg(test)]
    mod recovered_io_tests {
        use super::*;
        use super::super::super::windows_record::Record;
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Child, Command, Stdio};
        use std::sync::mpsc;

        const TEST_WAIT: Duration = Duration::from_secs(20);

        // Open through the real production worker with a generous scheduling budget,
        // then requeue its exact native result before testing a shorter stop deadline.
        fn ready_connection(fixture: &Fixture) -> ConnectAttempt {
            let name = wide(std::ffi::OsStr::new(&fixture.record.pipe_name())).unwrap();
            let mut connect = ConnectAttempt::start(name, Instant::now() + TEST_WAIT).unwrap();
            let pipe = connect.result.recv_timeout(TEST_WAIT).expect("stop worker did not connect").unwrap();
            let (sender, receiver) = mpsc::channel();
            sender.send(Ok(pipe)).unwrap();
            connect.result = receiver;
            connect
        }

        // Every panic path kills the helper. No wait()/reader join can hang the test.
        struct PipeHost(Child);
        impl PipeHost {
            fn exit(&mut self) -> std::process::ExitStatus {
                let deadline = Instant::now() + TEST_WAIT;
                loop {
                    if let Some(status) = self.0.try_wait().unwrap() { return status; }
                    assert!(Instant::now() < deadline, "foreign pipe host did not exit");
                    std::thread::sleep(RECOVERY_POLL);
                }
            }
        }
        impl Drop for PipeHost {
            fn drop(&mut self) { let _ = self.0.kill(); }
        }

        struct Fixture { dir: PathBuf, record: Record }
        impl Fixture {
            fn new() -> Self {
                let mut random = [0u8; 48];
                getrandom::fill(&mut random).unwrap();
                let mut created: FILETIME = unsafe { std::mem::zeroed() };
                let mut exited = created; let mut kernel = created; let mut user = created;
                unsafe { checked(GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited,
                    &mut kernel, &mut user)).unwrap(); }
                let record = Record::new(std::process::id(),
                    ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                    random[..16].try_into().unwrap(), random[16..].try_into().unwrap()).unwrap();
                let dir = std::env::temp_dir().join(format!("gd-recovery-{:032x}",
                    u128::from_le_bytes(random[..16].try_into().unwrap())));
                ensure_record_directory(&dir).unwrap();
                let fixture = Self { dir, record };
                fixture.write_record(&fixture.record);
                fixture
            }
            fn path(&self) -> PathBuf { self.dir.join(super::super::super::PID_FILE) }
            fn write_record(&self, record: &Record) {
                let sid = current_user_sid().unwrap();
                let descriptor = Descriptor::for_user(sid.as_ptr() as PSID).unwrap();
                let name = wide(self.path().as_os_str()).unwrap();
                let mut file = File::from(owned(unsafe { CreateFileW(name.as_ptr(), GENERIC_WRITE,
                    0, &descriptor.attributes(), CREATE_NEW, FILE_ATTRIBUTE_NORMAL, null_mut()) }).unwrap());
                file.write_all(&record.encode()).unwrap();
                file.sync_all().unwrap();
            }
            fn owner(&self) -> RecoveredLaunch {
                match acquire_recovered_launch(&self.dir) {
                    Ok(Some(owner)) => owner,
                    _ => panic!("fixture's exact live process must be admitted"),
                }
            }
            fn server(&self) -> OwnedHandle {
                let name = wide(std::ffi::OsStr::new(&self.record.pipe_name())).unwrap();
                let sid = current_user_sid().unwrap();
                let descriptor = Descriptor::for_user(sid.as_ptr() as PSID).unwrap();
                owned(unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1, 4096, 4096, 0, &descriptor.attributes()) }).unwrap()
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
        }

        fn connected_client(fixture: &Fixture, server: &OwnedHandle) -> OwnedHandle {
            let name = wide(std::ffi::OsStr::new(&fixture.record.pipe_name())).unwrap();
            let client = owned(unsafe { CreateFileW(name.as_ptr(), FILE_WRITE_DATA, 0, null(), OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) }).unwrap();
            let result = unsafe { ConnectNamedPipe(server.as_raw_handle(), null_mut()) };
            assert!(result != 0 || io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32));
            client
        }

        #[test]
        fn stop_deadline_and_cancellation_retain_pending_write_storage() {
            let fixture = Fixture::new();
            let server = fixture.server();
            let client = connected_client(&fixture, &server);
            let mut owner = fixture.owner();
            // Fill the real pipe's quota without a reader. Never rely on a specific
            // Windows minimum quota or on the first write completing synchronously.
            let fill_deadline = Instant::now() + TEST_WAIT;
            let pending = loop {
                assert!(Instant::now() < fill_deadline, "pipe quota did not become bounded backpressure");
                // A non-inheritable test-only duplicate lets each completed write
                // release its own handle without disconnecting the quota-fill client.
                let mut write = PendingStopWrite::submit(client.try_clone().unwrap(), fixture.record.frame()).unwrap();
                let probe_deadline = Instant::now() + Duration::from_millis(30);
                loop {
                    match write.poll().unwrap() {
                        Some(result) => { result.unwrap(); break; }
                        None if Instant::now() >= probe_deadline => break,
                        None => std::thread::sleep(Duration::from_millis(1)),
                    }
                }
                if write.storage.is_some() { break write; }
            };
            drop(client);
            owner.attempted = true;
            owner.write = Some(pending);
            let allocation = owner.write.as_ref().unwrap().storage.as_ref().unwrap().operation.get();
            let started = Instant::now();
            assert_eq!(owner.stop(Duration::from_millis(40)).unwrap_err().kind(), io::ErrorKind::TimedOut);
            assert!(started.elapsed() < TEST_WAIT, "stop ignored its bounded deadline");
            // CancelIoEx is only a request: even an already-completed cancellation
            // must not free kernel-referenced memory until poll observes completion.
            assert_eq!(owner.write.as_ref().unwrap().storage.as_ref().unwrap().operation.get(), allocation);
            owner.write.as_ref().unwrap().cancel().unwrap();
            assert_eq!(owner.write.as_ref().unwrap().storage.as_ref().unwrap().operation.get(), allocation);
            let completion_deadline = Instant::now() + TEST_WAIT;
            loop {
                if let Some(result) = owner.write.as_mut().unwrap().poll().unwrap() {
                    assert_eq!(result.unwrap_err().raw_os_error(), Some(ERROR_OPERATION_ABORTED as i32));
                    owner.write.take();
                    break;
                }
                assert!(Instant::now() < completion_deadline, "cancelled write did not settle");
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(owner.stop(Duration::from_millis(40)).is_err());
            assert!(owner.attempted && !owner.written);
            assert!(owner.connect.is_none() && owner.write.is_none());
            assert!(owner.record.is_some() && owner.process.is_some());
            assert!(owner.delete_record().is_err());
        }

        #[test]
        fn recovered_stop_sends_one_authenticated_frame_and_retains_timeout_state() {
            let fixture = Fixture::new();
            let server = fixture.server();
            let mut owner = fixture.owner();
            owner.connect = Some(ready_connection(&fixture));
            // The real worker has already delivered its connection, so scheduling it
            // cannot consume the two-second budget being tested below.
            // The pipe server is this exact recorded process. It deliberately stays
            // alive after receiving the authenticated frame, forcing a retained error.
            assert_eq!(owner.stop(Duration::from_secs(2)).unwrap_err().kind(), io::ErrorKind::TimedOut);
            assert!(owner.attempted && owner.written);
            assert_eq!(owner.stop(Duration::from_millis(40)).unwrap_err().kind(), io::ErrorKind::TimedOut);
            let mut available = 0;
            unsafe { checked(PeekNamedPipe(server.as_raw_handle(), null_mut(), 0, null_mut(),
                &mut available, null_mut())).unwrap(); }
            assert_eq!(available, 36, "a retry sent another authenticated frame");
            let mut frame = [0u8; 36];
            let mut read = 0;
            unsafe { checked(ReadFile(server.as_raw_handle(), frame.as_mut_ptr(), 36, &mut read, null_mut())).unwrap(); }
            assert_eq!(read, 36);
            assert_eq!(frame, fixture.record.frame());
            assert!(owner.record.is_some() && owner.process.is_some());
            assert!(owner.connect.is_none() && owner.write.is_none());
            assert!(owner.delete_record().is_err());
            assert!(fixture.path().exists());
        }

        #[test]
        fn recovered_stop_refuses_foreign_pipe_server_without_sending_frame() {
            let fixture = Fixture::new();
            let full_name = fixture.record.pipe_name();
            let bare_name = full_name.strip_prefix(r"\\.\pipe\").unwrap();
            // Only a generated lowercase-hex nonce enters this PowerShell literal.
            assert!(bare_name.strip_prefix("gentle-dot-stop-").unwrap()
                .bytes().all(|byte| byte.is_ascii_hexdigit()));
            let script = format!(r#"
$ErrorActionPreference = 'Stop'
$pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
    '{bare_name}', [System.IO.Pipes.PipeDirection]::InOut, 1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous)
try {{
    # Wait for a connection before announcing readiness: the refused client may
    # connect and close at once, before a later wait could begin.
    $connect = $pipe.WaitForConnectionAsync()
    [Console]::WriteLine('READY')
    if (-not $connect.Wait(20000)) {{ throw 'connection timeout' }}
    $buffer = New-Object byte[] 256
    $total = 0
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    # The refused client closes its end: a broken pipe ends the read like EOF does.
    try {{
        while ($timer.ElapsedMilliseconds -lt 20000) {{
            $read = $pipe.ReadAsync($buffer, 0, $buffer.Length)
            if (-not $read.Wait([int][Math]::Max(1, 20000 - $timer.ElapsedMilliseconds))) {{ break }}
            $count = $read.Result
            if ($count -eq 0) {{ break }}
            $total += $count
        }}
    }} catch {{ }}
    [Console]::WriteLine('BYTES:' + $total)
}} catch {{
    # Surface the host's failure in the test's assertion instead of losing it with stderr.
    [Console]::WriteLine('ERR:' + ($_.Exception.ToString() -replace '\s+', ' '))
}} finally {{ $pipe.Dispose() }}
"#);
            let system_root = std::env::var_os("SystemRoot").expect("Windows system directory missing");
            let powershell = PathBuf::from(system_root)
                .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
            let mut host = PipeHost(Command::new(powershell)
                .args(["-NoProfile", "-Command", &script])
                .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
                .spawn().expect("start foreign same-user pipe host"));
            assert_ne!(host.0.id(), fixture.record.pid);
            let stdout = host.0.stdout.take().unwrap();
            let (sender, lines) = mpsc::channel();
            // A blocking pipe read lives only on this observer; recv_timeout bounds
            // the controller, and PipeHost kills Q on every failure path.
            let _reader = std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    if sender.send(line).is_err() { break; }
                }
            });
            assert_eq!(lines.recv_timeout(TEST_WAIT).expect("foreign pipe readiness timed out").unwrap(), "READY");
            let mut owner = fixture.owner();
            owner.connect = Some(ready_connection(&fixture));
            let error = owner.stop(Duration::from_secs(2)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(error.to_string(), "Windows stop pipe server identity does not match");
            assert!(!owner.attempted && !owner.written);
            assert!(owner.connect.is_none() && owner.write.is_none());
            assert!(owner.record.is_some() && owner.process.is_some());
            assert_eq!(lines.recv_timeout(TEST_WAIT).expect("foreign pipe byte count timed out").unwrap(), "BYTES:0");
            assert!(host.exit().success());
            assert!(owner.delete_record().is_err());
            assert!(fixture.path().exists());
        }

        #[test]
        fn exact_deletion_refuses_replaced_file_and_changed_launch_identity() {
            let fixture = Fixture::new();
            let mut validated = read_validated_record(&fixture.dir).unwrap().unwrap();
            let identity = validated.identity;
            drop(validated.file.take());
            // Keep the old file alive under another name, so the replacement cannot
            // reuse its file ID even on filesystems with aggressive ID reuse.
            std::fs::rename(fixture.path(), fixture.dir.join("old-record")).unwrap();
            fixture.write_record(&fixture.record);
            assert!(delete_exact_record(&validated.path, &fixture.record, identity,
                &mut validated.file, &mut validated.deletion_marked).is_err());
            assert!(!validated.deletion_marked);
            assert!(validated.file.is_some());
            drop(validated.file.take());
            let mut replacement = read_validated_record(&fixture.dir).unwrap().unwrap();
            let changed = Record::new(fixture.record.pid, fixture.record.created + 1,
                [3; 16], [4; 32]).unwrap();
            assert!(delete_exact_record(&replacement.path, &changed, replacement.identity,
                &mut replacement.file, &mut replacement.deletion_marked).is_err());
            assert!(!replacement.deletion_marked);
            assert!(replacement.file.is_some());
            assert!(fixture.path().exists());
            drop(replacement);
            drop(validated);
        }
    }

    #[cfg(test)]
    mod owner_exit_tests {
        use super::*;
        use super::super::super::{windows_record, Daemon, PID_FILE};
        use crate::app_channel::windows::channel_pair;
        use std::{fs, thread};
        use std::sync::{mpsc, Arc};

        // Owner-exit recovery runs the launching app in a child copy of this test binary, so
        // killing that exact child handle (never a PID lookup) closes the only Job handle.
        const OWNER_HELPER: &str = "daemon::windows::native::owner_exit_tests::recovery_owner_helper";
        const OWNER_HELPER_DIR: &str = "GENTLE_DOT_TEST_RECOVERY_OWNER_DIR";
        const OWNER_FILE: &str = "daemon.owner";

        #[test]
        #[ignore = "launching-app child for owner-exit recovery tests; returns at once without its environment"]
        fn recovery_owner_helper() {
            let Some(dir) = std::env::var_os(OWNER_HELPER_DIR) else { return };
            let dir = PathBuf::from(dir);
            let script = r#"
const {spawn} = require('node:child_process');
// Outlive the Node root while still inheriting the retained outer owned Job.
const child = spawn(process.execPath, ['-e', "process.stdout.write('CHILD_READY\\n');setTimeout(()=>{},60000)"],
  {stdio:['ignore','pipe','ignore'],windowsHide:true,detached:true});
child.stdout.once('data', bytes => {
  if (bytes.toString() !== 'CHILD_READY\n') process.exit(75);
  console.log('DESCENDANT ' + child.pid);
});
setTimeout(()=>process.exit(74),60000);
"#;
            let launch = LaunchSpec { program: env!("GENTLE_DOT_BUILD_NODE").into(),
                args: vec!["-e".into(), script.into()], envs: vec![("NODE_OPTIONS".into(), String::new())] };
            let (_parent, endpoint) = channel_pair().unwrap();
            let child = super::spawn(&launch, super::open_private_log(&dir).unwrap(), &endpoint, &dir).unwrap();
            drop(endpoint);
            println!("OWNER_READY {}", child.id());
            thread::sleep(Duration::from_secs(60));
        }

        struct OwnerRun {
            helper: std::process::Child,
            dir: PathBuf,
            root: std::os::windows::io::OwnedHandle,
            descendant: std::os::windows::io::OwnedHandle,
        }
        impl Drop for OwnerRun {
            fn drop(&mut self) { let _ = self.helper.kill(); let _ = self.helper.wait(); }
        }
        // Test witness only, opened while the fixture reports the process live.
        fn open_witness(pid: u32) -> std::os::windows::io::OwnedHandle {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
            let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION
                | windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE, 0, pid) };
            assert!(!raw.is_null(), "fixture process witness");
            unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) }
        }
        fn exits_within(process: &std::os::windows::io::OwnedHandle, millis: u32) -> bool {
            use std::os::windows::io::AsRawHandle;
            let result = unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(process.as_raw_handle(), millis) };
            result == windows_sys::Win32::Foundation::WAIT_OBJECT_0
        }
        fn start_owner(name: &str) -> OwnerRun {
            let mut nonce = [0u8; 8];
            getrandom::fill(&mut nonce).unwrap();
            let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            let dir = std::env::temp_dir().join(format!("gentle-owner-{name}-{token}"));
            super::ensure_record_directory(&dir).unwrap();
            let mut helper = std::process::Command::new(std::env::current_exe().unwrap())
                .args([OWNER_HELPER, "--exact", "--ignored", "--nocapture", "--test-threads=1"])
                .env(OWNER_HELPER_DIR, &dir)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null()).spawn().unwrap();
            let stdout = helper.stdout.take().unwrap();
            let (lines, ready) = mpsc::channel();
            thread::spawn(move || {
                for line in io::BufRead::lines(io::BufReader::new(stdout)).map_while(Result::ok) {
                    if lines.send(line).is_err() { break; }
                }
            });
            let root: u32 = loop {
                let line = ready.recv_timeout(Duration::from_secs(30)).expect("owner helper readiness");
                // libtest prints `test <name> ... ` without a newline before the helper's output.
                if let Some((_, pid)) = line.split_once("OWNER_READY ") { break pid.trim().parse().unwrap(); }
            };
            let deadline = Instant::now() + Duration::from_secs(10);
            let descendant: u32 = loop {
                let log = fs::read_to_string(dir.join("daemon.log")).unwrap_or_default();
                if let Some(pid) = log.lines().find_map(|line| line.strip_prefix("DESCENDANT ")) {
                    break pid.trim().parse().unwrap();
                }
                assert!(Instant::now() < deadline, "fixture descendant readiness: {log}");
                thread::sleep(Duration::from_millis(20));
            };
            OwnerRun { root: open_witness(root), descendant: open_witness(descendant), helper, dir }
        }
        fn kill_owner(run: &mut OwnerRun) {
            run.helper.kill().unwrap();
            run.helper.wait().unwrap();
        }
        fn recovering_daemon(dir: &Path) -> Daemon {
            let mut daemon = Daemon::new(1, dir.to_path_buf(), None);
            daemon.health = Some(Arc::new(|| false));
            daemon
        }
        struct Sentinel(std::process::Child);
        impl Drop for Sentinel {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }

        #[test]
        fn owner_exit_retires_record_after_kernel_ends_owned_group() {
            use std::os::windows::process::CommandExt;
            // Same executable, independently launched: never part of the owned Job.
            let mut sentinel = Sentinel(std::process::Command::new(env!("GENTLE_DOT_BUILD_NODE"))
                .args(["-e", "setTimeout(()=>{},60000)"]).env_remove("NODE_OPTIONS")
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()).spawn().unwrap());
            let mut run = start_owner("exit");
            let record = fs::read(run.dir.join(PID_FILE)).unwrap();
            let witness = fs::read(run.dir.join(OWNER_FILE)).unwrap();
            // Guards: a live witnessed owner refuses retirement; only its exit plus root
            // exit permits exact deletion. Removing the live-owner check must fail here.
            let live = recovering_daemon(&run.dir);
            let error = live.windows_recovery_admission(&None).unwrap_err();
            assert_eq!(error, "Windows previous launch admission refused: \
                the previous launch's owning app is still running; record retained");
            assert_eq!(live.refusal(), Some(error));
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), record);
            assert_eq!(fs::read(run.dir.join(OWNER_FILE)).unwrap(), witness);
            assert!(!exits_within(&run.root, 0) && !exits_within(&run.descendant, 0), "nothing was stopped");
            drop(live);
            kill_owner(&mut run);
            let daemon = recovering_daemon(&run.dir);
            assert_eq!(daemon.windows_recovery_admission(&None), Ok(()));
            assert_eq!(daemon.refusal(), None);
            assert!(!run.dir.join(PID_FILE).exists(), "exact record retired");
            assert!(exits_within(&run.root, 0), "retirement waits for the recorded root");
            assert!(exits_within(&run.descendant, 5000), "the kernel ended the whole owned Job");
            assert_eq!(fs::read(run.dir.join(OWNER_FILE)).unwrap(), witness,
                "retirement leaves the witness without authority");
            assert!(!retire_if_owner_exited(&run.dir).unwrap(), "no record is a no-op");
            assert!(sentinel.0.try_wait().unwrap().is_none(), "same executable outside the Job survives");
        }

        #[test]
        fn record_without_owner_witness_is_not_retired_after_owner_exit() {
            // Guard: no witness returns Ok(false), not successful retirement or an error.
            let mut run = start_owner("legacy");
            let record = fs::read(run.dir.join(PID_FILE)).unwrap();
            fs::remove_file(run.dir.join(OWNER_FILE)).unwrap();
            assert!(!retire_if_owner_exited(&run.dir).unwrap(), "missing witness is a no-op even with a live root");
            assert!(run.dir.join(PID_FILE).exists());
            kill_owner(&mut run);
            assert!(exits_within(&run.root, 5000));
            assert!(!retire_if_owner_exited(&run.dir).unwrap(), "a legacy launch is not retired");
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), record,
                "legacy records still need authorized manual recovery");
            assert!(!run.dir.join(OWNER_FILE).exists());
            let daemon = recovering_daemon(&run.dir);
            let error = daemon.windows_recovery_admission(&None).unwrap_err();
            assert!(error.starts_with("Windows recorded launch admission refused:"), "{error}");
            assert_eq!(daemon.refusal(), Some(error));
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), record,
                "failed recovered admission retains the legacy record");
        }

        #[test]
        fn invalid_or_unbound_witness_refuses_and_retains_record() {
            // Guards: invalid witnesses fail closed; valid witnesses must bind this nonce.
            // Removing either refusal changes the asserted error or deletes the record.
            let mut run = start_owner("mismatch");
            let record = fs::read(run.dir.join(PID_FILE)).unwrap();
            let path = run.dir.join(OWNER_FILE);
            let witness = fs::read(&path).unwrap();
            // A damaged witness is not a legacy record: refuse rather than try the recovered stop.
            fs::write(&path, b"not an owner witness\n").unwrap();
            let daemon = recovering_daemon(&run.dir);
            let error = daemon.windows_recovery_admission(&None).unwrap_err();
            assert_eq!(error, "Windows previous launch admission refused: \
                Windows owner witness is invalid or unreadable; record retained");
            assert_eq!(daemon.refusal(), Some(error));
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), record);
            assert_eq!(fs::read(&path).unwrap(), b"not an owner witness\n");
            assert!(!exits_within(&run.root, 0) && !exits_within(&run.descendant, 0), "nothing was stopped");
            // A witness for another record proves nothing, even after this owner exits.
            let owner = windows_record::Owner::parse(&witness).unwrap();
            let unbound = windows_record::Owner::new([0x5a; 16], owner.pid, owner.created).unwrap().encode();
            fs::write(&path, &unbound).unwrap();
            kill_owner(&mut run);
            assert!(exits_within(&run.root, 5000));
            let daemon = recovering_daemon(&run.dir);
            let error = daemon.windows_recovery_admission(&None).unwrap_err();
            assert_eq!(error, "Windows previous launch admission refused: \
                Windows owner witness does not match the recorded launch; record retained");
            assert_eq!(daemon.refusal(), Some(error));
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), record);
            assert_eq!(fs::read(&path).unwrap(), unbound);
        }

        #[test]
        fn exited_witness_with_running_root_retains_record_and_refuses() {
            // Guard: owner exit alone is insufficient; a live root must time out, not retire.
            use std::os::windows::io::AsRawHandle;
            let run = start_owner("contradiction");
            let bytes = fs::read(run.dir.join(PID_FILE)).unwrap();
            let record = windows_record::Record::parse(&bytes).unwrap();
            // An exited process that never held the Job: its exit proves nothing about the root.
            let mut other = std::process::Command::new(env!("GENTLE_DOT_BUILD_NODE"))
                .args(["-e", ""]).env_remove("NODE_OPTIONS").stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
            other.wait().unwrap();
            let mut created: windows_sys::Win32::Foundation::FILETIME = unsafe { std::mem::zeroed() };
            let (mut exited, mut kernel, mut user) = (created, created, created);
            assert_ne!(unsafe { windows_sys::Win32::System::Threading::GetProcessTimes(other.as_raw_handle(),
                &mut created, &mut exited, &mut kernel, &mut user) }, 0);
            let created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
            let witness = windows_record::Owner::new(record.nonce(), other.id(), created).unwrap().encode();
            fs::write(run.dir.join(OWNER_FILE), &witness).unwrap();
            let daemon = recovering_daemon(&run.dir);
            let started = Instant::now();
            let error = daemon.windows_recovery_admission(&None).unwrap_err();
            assert_eq!(error, "Windows previous launch admission refused: \
                recorded Windows root is still running after its owner exited; record retained");
            assert_eq!(daemon.refusal(), Some(error));
            assert!(started.elapsed() >= Duration::from_secs(9), "bounded wait for the recorded root");
            assert_eq!(fs::read(run.dir.join(PID_FILE)).unwrap(), bytes);
            assert_eq!(fs::read(run.dir.join(OWNER_FILE)).unwrap(), witness);
            assert!(!exits_within(&run.root, 0) && !exits_within(&run.descendant, 0), "nothing was terminated");
        }
    }

    #[cfg(test)]
    mod launch_tests {
        use super::*;

        fn spec() -> LaunchSpec {
            LaunchSpec { program: std::env::current_exe().unwrap().to_str().unwrap().into(), args: vec![], envs: vec![] }
        }

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

        #[test]
        fn application_ignores_relative_and_empty_path_entries() {
            // cargo runs tests from the crate directory; target/ is ignored by git.
            let relative = PathBuf::from(format!(r"target\gd-relative-path-{}", std::process::id()));
            let absolute = std::env::temp_dir().join(format!("gd-absolute-path-{}", std::process::id()));
            for dir in [&relative, &absolute] {
                std::fs::create_dir_all(dir).unwrap();
                std::fs::write(dir.join("gd-probe-tool.exe"), b"").unwrap();
            }
            let spec = |path: String| LaunchSpec {
                program: "gd-probe-tool".into(),
                args: Vec::new(),
                envs: vec![("PATH".into(), path)],
            };
            let found = |path: String| application(&spec(path))
                .map(|wide| String::from_utf16(&wide[..wide.len() - 1]).unwrap());
            let only_relative = format!(";.;{}", relative.display());
            assert_eq!(found(only_relative).unwrap_err().kind(), io::ErrorKind::NotFound);
            let mixed = format!(";.;{};{}", relative.display(), absolute.display());
            let resolved = found(mixed).unwrap();
            assert!(resolved.ends_with(r"\gd-probe-tool.exe"));
            assert!(resolved.contains(&format!("gd-absolute-path-{}", std::process::id())));
            for dir in [&relative, &absolute] { let _ = std::fs::remove_dir_all(dir); }
        }

        #[test]
        fn private_log_directory_and_file_name_only_the_user() {
            // Owner and every DACL entry must be this user's SID, never OWNER RIGHTS: the
            // daemon reopens the directory by path, possibly unelevated (#128).
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            let root = std::env::temp_dir().join(format!("gentle-private-log-{token}"));
            let log = open_private_log(&root).unwrap();
            let sid = current_user_sid().unwrap();
            validate_record_security(log.as_raw_handle(), sid.as_ptr() as PSID).expect("log names only the user");
            let name = wide(root.as_os_str()).unwrap();
            let directory = owned(unsafe { CreateFileW(name.as_ptr(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }).unwrap();
            validate_record_security(directory.as_raw_handle(), sid.as_ptr() as PSID).expect("directory names only the user");
            // Reopening repairs, never loosens: the same check holds on the second call.
            drop(log);
            let log = open_private_log(&root).unwrap();
            validate_record_security(log.as_raw_handle(), sid.as_ptr() as PSID).unwrap();
            validate_record_security(directory.as_raw_handle(), sid.as_ptr() as PSID).unwrap();
        }

        #[test]
        fn retained_record_ancestry_blocks_renaming_an_ancestor() {
            let base = std::env::temp_dir().join(format!("gd-ancestry-pin-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(base.join(r"a\b")).unwrap();
            let held = record_ancestry(&base.join(r"a\b\daemon.pid"), false).unwrap();
            let renamed = base.join("a-renamed");
            let attempt = std::fs::rename(base.join("a"), &renamed);
            if attempt.is_ok() { let _ = std::fs::rename(&renamed, base.join("a")); }
            drop(held);
            let _ = std::fs::remove_dir_all(&base);
            assert!(attempt.is_err(), "an ancestor was renamed while the record ancestry was retained");
        }

        #[test]
        fn record_ancestry_admits_a_forward_slash_data_dir_spelling() {
            // Tooling, .env files and cross-platform config spell data dirs with '/'. Windows
            // itself treats every '/' as a separator, so admission must walk and pin the same
            // components as the backslash spelling instead of refusing the shape.
            let base = std::env::temp_dir().join(format!("gd-ancestry-slash-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(base.join(r"a\b")).unwrap();
            let forward = PathBuf::from(base.to_string_lossy().replace('\\', "/")).join("a/b/daemon.pid");
            let held = record_ancestry(&forward, false).unwrap();
            drop(held);
            let _ = std::fs::remove_dir_all(&base);
        }

        #[test]
        fn record_ancestry_names_the_path_when_rejecting_an_unsafe_shape() {
            // "unsafe provenance" sent testers hunting ACL problems that did not exist;
            // shape rejections must name the rejected path instead.
            let malformed = record_ancestry(Path::new("relative/daemon.pid"), false).unwrap_err();
            let message = malformed.to_string();
            assert!(message.contains("unsafe Windows stop record path"), "message was: {message}");
            assert!(message.contains("relative/daemon.pid"), "message was: {message}");
        }

        #[test]
        fn assignment_failure_never_resumes_and_cleans_owned_suspended_child() {
            let (parent, child) = crate::app_channel::windows::channel_pair().unwrap();
            let log = File::open(std::env::current_exe().unwrap()).unwrap();
            let failure = spawn_with_faults(&spec(), log, &child, Faults { assignment: true, ..Faults::default() }).unwrap_err();
            assert!(failure.primary.to_string().contains("injected assignment failure"));
            assert!(failure.unfinished.is_none());
            assert!(failure.cleanup.is_none());
            parent.shutdown().unwrap();
        }
        #[test]
        fn verification_failure_never_resumes_and_drains_owned_job() {
            let (parent, child) = crate::app_channel::windows::channel_pair().unwrap();
            let log = File::open(std::env::current_exe().unwrap()).unwrap();
            let failure = spawn_with_faults(&spec(), log, &child, Faults { verification: true, ..Faults::default() }).unwrap_err();
            assert!(failure.primary.to_string().contains("injected verification failure"));
            assert!(failure.unfinished.is_none());
            assert!(failure.cleanup.is_none());
            parent.shutdown().unwrap();
        }
        #[test]
        #[ignore = "explicit Windows checkout fd3 integration; synthetic processes and private record only"]
        fn production_fd3_drain_excludes_live_child_and_retires_owned_job() {
            use std::io::{Read, Write};
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            let root = std::env::temp_dir().join(format!("gentle-fd3-integration-{token}"));
            ensure_record_directory(&root).unwrap();
            let log_path = root.join("daemon.log");
            let release = root.join("release");
            let adapter = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/daemon/src/windows-app-channel.ts");
            // Production TS entry and package-local addon; no injected loader,
            // daemon startup, secret store, installed agent, or model is involved.
            let script = r#"
import { pathToFileURL } from 'node:url';
import { win32 } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const [adapter, release, token] = process.argv.slice(1);
const watchdog = setTimeout(() => { console.error('synthetic deadline'); process.exit(71); }, 20000);
const { WindowsAppChannel } = await import(pathToFileURL(adapter).href);
const { startWithWindowsStop } = await import(new URL('./windows-stop.ts', pathToFileURL(adapter)).href);
const channel = new WindowsAppChannel({ exclusiveFd3Startup: true, closeTimeoutMs: 5000 });
channel.on('error', () => { console.error('synthetic channel error'); process.exitCode = 72; });
const expected = Buffer.from(token);
await new Promise((resolve, reject) => {
  let bytes = Buffer.alloc(0);
  channel.on('data', function receive(part) {
    bytes = Buffer.concat([bytes, part]);
    if (bytes.length > expected.length) return reject(new Error('oversized challenge'));
    if (bytes.length === expected.length) {
      channel.off('data', receive);
      if (!bytes.equals(expected)) return reject(new Error('challenge mismatch'));
      resolve();
    }
  });
  channel.once('error', reject);
});
await new Promise((resolve, reject) => channel.write(Buffer.from('ack:' + token), e => e ? reject(e) : resolve()));
const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(73),20000)"],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const exited = once(child, 'exit');
const [ready] = await once(child.stdout, 'data');
if (ready.toString() !== 'ready\n' || child.exitCode !== null) throw new Error('child readiness');
let stopped;
const closed = new Promise(resolve => { stopped = resolve; });
const managed = await startWithWindowsStop(win32.join(process.env.GENTLE_DOT_DATA_DIR, 'daemon.pid'), async () => ({
  closed,
  async close() {
    // Only the authenticated listener may initiate drain. Parent-side EOF is failure.
    const drained = await channel.close('drain');
    if (drained.mode !== 'drain' || drained.drained !== true || child.exitCode !== null) throw new Error('drain witness');
    console.log('DRAINED_CHILD_ALIVE');
    await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); resolve(); } }, 10); });
    if (child.exitCode !== null) throw new Error('child exited before release');
    child.stdin.end();
    const [code, signal] = await exited;
    if (code !== 0 || signal !== null) throw new Error('child did not exit normally');
    stopped();
  },
}));
console.log('STOP_READY');
await managed.closed;
clearTimeout(watchdog);
console.log('NORMAL_EXIT');
"#;
            let launch = LaunchSpec {
                program: env!("GENTLE_DOT_BUILD_NODE").into(),
                args: vec!["--input-type=module".into(), "-e".into(), script.into(),
                    adapter.to_str().unwrap().into(), release.to_str().unwrap().into(), token.clone()],
                envs: vec![("NODE_OPTIONS".into(), String::new())],
            };
            let (parent, endpoint) = crate::app_channel::windows::channel_pair().unwrap();
            let mut child = spawn(&launch, open_private_log(&root).unwrap(), &endpoint, &root).unwrap();
            drop(endpoint); // No parent-side client alias may invalidate the EOF witness.
            struct CloseChannel(crate::app_channel::ChannelStream);
            impl Drop for CloseChannel {
                fn drop(&mut self) { let _ = self.0.shutdown(); }
            }
            let channel_guard = CloseChannel(parent);
            let mut stream = channel_guard.0.try_clone().unwrap();
            let challenge = token.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            let release_after_drain = release.clone();
            let reader = std::thread::spawn(move || {
                let result = (|| -> io::Result<()> {
                    stream.write_all(challenge.as_bytes())?;
                    let expected = format!("ack:{challenge}");
                    let mut reply = vec![0; expected.len()];
                    stream.read_exact(&mut reply)?;
                    if reply != expected.as_bytes() { return Err(io::Error::other("synthetic response mismatch")); }
                    let mut byte = [0];
                    if stream.read(&mut byte)? != 0 { return Err(io::Error::other("expected channel EOF")); }
                    // Release the live descendant only after daemon-side drain. The main
                    // thread stays in the production owned-stop path throughout.
                    std::fs::write(release_after_drain, b"release")?;
                    Ok(())
                })();
                let _ = tx.send(result);
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let log = std::fs::read_to_string(&log_path).unwrap();
                if log.lines().any(|line| line == "STOP_READY") { break; }
                assert!(Instant::now() < deadline, "missing authenticated listener readiness: {log}");
                std::thread::sleep(Duration::from_millis(10));
            }
            // No EOF or release has been initiated by the parent. Both processes must
            // be live when the existing production method sends authenticated shutdown.
            assert!(child.status().unwrap().is_none());
            assert!(child.query().unwrap() >= 2);
            assert!(!release.exists());
            child.shutdown_owned(Duration::from_secs(10))
                .expect("authenticated owned shutdown before fd3 closure");
            assert!(!child.force_requested, "orderly shutdown must not enter the force path");
            child.shutdown_owned(Duration::ZERO).expect("checked orderly retry");
            rx.recv_timeout(Duration::from_secs(10)).expect("bounded fd3 exchange/drain").unwrap();
            reader.join().unwrap();
            assert!(child.status().unwrap().unwrap().success());
            assert_eq!(child.query().unwrap(), 0);
            assert!(std::fs::read_to_string(&log_path).unwrap().lines()
                .any(|line| line == "DRAINED_CHILD_ALIVE"));
            assert!(!root.join("daemon.pid").exists());
            channel_guard.0.shutdown().unwrap();
            assert!(std::fs::read_to_string(&log_path).unwrap().lines().any(|line| line == "NORMAL_EXIT"));
            // Retain this synthetic log/release directory; no recursive cleanup.
        }

        fn owned_fixture(script: &str) -> (WindowsChild, crate::app_channel::ChannelStream, PathBuf) {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let token: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
            let root = std::env::temp_dir().join(format!("gentle-owned-stop-{token}"));
            ensure_record_directory(&root).unwrap();
            let launch = LaunchSpec {
                program: env!("GENTLE_DOT_BUILD_NODE").into(),
                args: vec!["-e".into(), script.into()],
                envs: vec![("NODE_OPTIONS".into(), String::new())],
            };
            let (parent, endpoint) = crate::app_channel::windows::channel_pair().unwrap();
            let child = spawn(&launch, open_private_log(&root).unwrap(), &endpoint, &root).unwrap();
            drop(endpoint);
            (child, parent, root)
        }

        fn force_group_with_unrelated_sentinel(root_exits: bool) {
            use std::os::windows::process::CommandExt;
            // Same executable, independently launched: never included in the owned Job.
            struct Sentinel(std::process::Child);
            impl Drop for Sentinel {
                fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
            }
            let mut sentinel = Sentinel(std::process::Command::new(env!("GENTLE_DOT_BUILD_NODE"))
                .args(["-e", "setTimeout(()=>{},30000)"])
                .env_remove("NODE_OPTIONS").creation_flags(CREATE_NO_WINDOW)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()).spawn().unwrap());
            let script = format!(r#"
const {{spawn}} = require('node:child_process');
// Outlive the Node root while still inheriting the retained outer owned Job.
const child = spawn(process.execPath, ['-e', "process.stdout.write('CHILD_READY\\n');setTimeout(()=>{{}},30000)"],
  {{stdio:['ignore','pipe','ignore'],windowsHide:true,detached:true}});
child.stdout.once('data', bytes => {{
  if (bytes.toString() !== 'CHILD_READY\n') process.exit(75);
  console.log('READY'); {}
}});
setTimeout(()=>process.exit(74),30000);
"#, if root_exits { "process.exit(0);" } else { "" });
            let (mut child, parent, root) = owned_fixture(&script);
            // Two Node starts on a cold CI runner can take more than 5 s; this only bounds the wait.
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let ready = std::fs::read_to_string(root.join("daemon.log")).unwrap().lines().any(|l| l == "READY");
                if ready && (!root_exits || child.status().unwrap().is_some()) { break; }
                assert!(Instant::now() < deadline, "synthetic root/descendant not ready");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(child.query().unwrap() >= if root_exits { 1 } else { 2 });
            assert!(sentinel.0.try_wait().unwrap().is_none());
            let stopping = Instant::now();
            child.shutdown_owned(Duration::from_millis(50)).unwrap();
            assert!(stopping.elapsed() >= Duration::from_millis(50), "force must wait out grace");
            assert_eq!(child.status().unwrap().unwrap().code(), Some(if root_exits { 0 } else { 1 }));
            assert_eq!(child.query().unwrap(), 0);
            assert!(!root.join("daemon.pid").exists());
            assert!(child.stop.as_ref().is_none_or(|stop| stop.connect.is_none() && stop.write.is_none()));
            assert!(sentinel.0.try_wait().unwrap().is_none(), "same executable is not ownership");
            // A later parent-channel failure must not make retry require clean exit.
            child.shutdown_owned(Duration::ZERO).unwrap();
            parent.shutdown().unwrap();
        }

        #[test]
        fn owned_force_stops_root_and_descendants_not_same_executable() {
            force_group_with_unrelated_sentinel(false);
        }

        #[test]
        fn exited_root_still_requires_owned_descendant_completion() {
            force_group_with_unrelated_sentinel(true);
        }

        #[test]
        fn uncertain_status_keeps_an_established_launch_on_the_channel_open_stop() {
            let (mut child, parent, root) = owned_fixture("setTimeout(()=>{},30000)");
            assert!(child.established);
            // What the lifecycle does when an established launch's status query fails.
            child.retain_failure();
            assert!(child.launch_failed(), "uncertain status still refuses replacement and health");
            assert!(child.try_wait().is_err());
            assert!(child.shutdown_requires_channel(), "an established launch is not a failed startup");
            // No stop listener here: the authenticated attempt fails and the force path
            // waits out the caller's grace instead of the failed-startup zero grace.
            let stopping = Instant::now();
            child.shutdown_owned(Duration::from_millis(200)).unwrap();
            assert!(stopping.elapsed() >= Duration::from_millis(200), "established stop must honor its grace");
            assert!(child.force_requested);
            assert_eq!(child.query().unwrap(), 0);
            assert!(!root.join("daemon.pid").exists());
            parent.shutdown().unwrap();
        }

        #[test]
        fn owned_force_failures_retain_record_and_allow_checked_retry() {
            for faults in [
                Faults { terminate: true, ..Faults::default() },
                Faults { wait: true, ..Faults::default() },
                Faults { query: true, ..Faults::default() },
            ] {
                let (mut child, parent, root) = owned_fixture("setTimeout(()=>{},30000)");
                child.faults = faults;
                assert!(child.shutdown_owned(Duration::from_millis(50)).is_err());
                assert!(child.launch_failed());
                assert!(child.try_wait().is_err());
                assert!(root.join("daemon.pid").exists());
                child.faults = Faults::default();
                child.shutdown_owned(Duration::ZERO).unwrap();
                assert!(child.status().unwrap().is_some());
                assert_eq!(child.query().unwrap(), 0);
                assert!(!root.join("daemon.pid").exists());
                parent.shutdown().unwrap();
            }
        }

        #[test]
        fn multiple_cleanup_failures_retain_owner_until_checked_retry() {
            let (parent, child) = crate::app_channel::windows::channel_pair().unwrap();
            let log = File::open(std::env::current_exe().unwrap()).unwrap();
            let mut failure = spawn_with_faults(&spec(), log, &child, Faults {
                assignment: true, terminate: true, wait: true, query: true, ..Faults::default()
            }).unwrap_err();
            let detail = failure.cleanup.as_ref().unwrap().to_string();
            assert!(detail.contains("terminate") && detail.contains("wait") && detail.contains("job query"));
            let mut owner = failure.unfinished.take().unwrap();
            assert!(owner.launch_failed());
            // Never resumed: cleanup may close the channel first, its listener may not exist.
            assert!(!owner.shutdown_requires_channel());
            assert!(owner.try_wait().is_err());
            owner.faults = Faults::default();
            owner.shutdown_owned(Duration::ZERO).unwrap();
            assert_eq!(job_active(&owner.job).unwrap(), 0);
            assert!(owner.status().unwrap().is_some());
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
