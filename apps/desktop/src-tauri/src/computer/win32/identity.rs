//! HWND -> PID -> query-limited executable identity and ordinary-session checks.
//! No titles, process-name lookup heuristics, privilege escalation or provider messages.
use std::mem::{offset_of, size_of, size_of_val};
use windows::{core::{BOOL, PWSTR}, Win32::{
    Foundation::{HANDLE, HWND, LPARAM},
    Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid, SID, TokenElevation,
        TokenIntegrityLevel, TokenSessionId, TokenUIAccess, TOKEN_INFORMATION_CLASS,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY},
    System::{Threading::{GetCurrentProcess, GetCurrentThreadId, OpenProcess,
        OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION}, StationsAndDesktops::{CloseDesktop,
        GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW,
        OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME}},
    UI::WindowsAndMessaging::{EnumWindows, GetAncestor, GetForegroundWindow,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, WindowFromPoint, GA_ROOT},
}};
use super::{context::{error, hwnd, point, Handle}, super::{blocklist::AppIdentity, coords::Point}};

pub(super) fn window_pid(window: HWND) -> Result<u32, String> {
    let mut pid = 0;
    // SAFETY: HWND is checked for liveness; pid is a valid output pointer. Recheck later
    // as HWNDs/PIDs can be recycled; retaining an integer is not retaining a native window.
    if window.0.is_null() || !unsafe { IsWindow(Some(window)) }.as_bool()
        || unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) } == 0 || pid == 0 {
        return Err("window owner unavailable".into());
    }
    Ok(pid)
}

pub(super) fn root(window: HWND) -> Result<HWND, String> {
    window_pid(window)?;
    // SAFETY: checked live HWND; root is validated rather than trusted if null.
    let root = unsafe { GetAncestor(window, GA_ROOT) };
    window_pid(root)?;
    Ok(root)
}

pub(super) fn foreground() -> Result<HWND, String> {
    // SAFETY: metadata query, not activation.
    root(unsafe { GetForegroundWindow() })
}

pub(super) fn window_at(at: Point) -> Result<HWND, String> {
    // SAFETY: finite physical coordinate in the caller's scoped DPI context.
    root(unsafe { WindowFromPoint(point(at)?) })
}

fn object_name(object: HANDLE) -> Result<String, String> {
    let mut name = [0u16; 128];
    let mut bytes = 0;
    // SAFETY: bounded UTF-16 output; byte capacity, not element count.
    unsafe { GetUserObjectInformationW(object, UOI_NAME, Some(name.as_mut_ptr().cast()),
        size_of::<[u16; 128]>() as u32, Some(&mut bytes)) }
        .map_err(|e| error("desktop identity query", e))?;
    let length = name.iter().position(|n| *n == 0).ok_or("desktop name exceeds limit")?;
    if bytes as usize > size_of::<[u16; 128]>() { return Err("desktop metadata exceeds limit".into()); }
    String::from_utf16(&name[..length]).map_err(|_| "invalid desktop identity".into())
}

pub(super) fn normal_desktop() -> Result<(), String> {
    struct InputDesktop(windows::Win32::System::StationsAndDesktops::HDESK);
    impl Drop for InputDesktop {
        fn drop(&mut self) { let _ = unsafe { CloseDesktop(self.0) }; }
    }
    // SAFETY: read-only handles. Only the opened input desktop is owned; station/thread
    // handles are borrowed and must not be closed. Never switch desktops.
    let input = InputDesktop(unsafe { OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS) }
        .map_err(|e| error("input desktop query", e))?);
    let thread = unsafe { GetThreadDesktop(GetCurrentThreadId()) }
        .map_err(|e| error("thread desktop query", e))?;
    let station = unsafe { GetProcessWindowStation() }
        .map_err(|e| error("window station query", e))?;
    if !object_name(HANDLE(station.0))?.eq_ignore_ascii_case("WinSta0")
        || !object_name(HANDLE(input.0.0))?.eq_ignore_ascii_case("Default")
        || !object_name(HANDLE(thread.0))?.eq_ignore_ascii_case("Default") {
        return Err("only the ordinary interactive desktop is supported".into());
    }
    Ok(())
}

fn token(process: HANDLE) -> Result<Handle, String> {
    let mut value = HANDLE::default();
    // SAFETY: valid process handle and out pointer; only TOKEN_QUERY, no adjustment.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut value) }
        .map_err(|e| error("process security query", e))?;
    Ok(Handle(value))
}

fn token_u32(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<u32, String> {
    let (mut value, mut bytes) = (0u32, 0u32);
    // SAFETY: all callers choose classes documented to return a DWORD (TokenElevation
    // is a one-DWORD TOKEN_ELEVATION); no variable-size reinterpretation here.
    unsafe { GetTokenInformation(token, class, Some((&mut value as *mut u32).cast()),
        size_of::<u32>() as u32, &mut bytes) }.map_err(|e| error("token query", e))?;
    if bytes != size_of::<u32>() as u32 { return Err("unexpected token metadata size".into()); }
    Ok(value)
}

fn integrity(token: HANDLE) -> Result<u32, String> {
    // usize alignment suffices for TOKEN_MANDATORY_LABEL. This buffer remains live for
    // every use of the SID pointer returned inside it; there is no SID lifetime escape.
    let mut buffer = [0usize; 128];
    let mut bytes = 0;
    unsafe { GetTokenInformation(token, TokenIntegrityLevel, Some(buffer.as_mut_ptr().cast()),
        size_of_val(&buffer) as u32, &mut bytes) }.map_err(|e| error("integrity query", e))?;
    let capacity = size_of_val(&buffer);
    if (bytes as usize) < size_of::<TOKEN_MANDATORY_LABEL>() || bytes as usize > capacity {
        return Err("unexpected integrity metadata size".into());
    }
    // SAFETY: size and alignment established above; the kernel fills this exact class.
    let label = unsafe { &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    let begin = buffer.as_ptr() as usize;
    let end = begin + bytes as usize;
    let sid = label.Label.Sid.0 as usize;
    let header = offset_of!(SID, SubAuthority);
    if sid < begin || sid.checked_add(header).is_none_or(|n| n > end) {
        return Err("invalid integrity SID bounds".into());
    }
    // SAFETY: the fixed SID header is in the returned buffer. Check its variable
    // subauthority extent before IsValidSid or GetSidSubAuthority can dereference it.
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) } as usize;
    if count == 0 || sid.checked_add(header + count * size_of::<u32>()).is_none_or(|n| n > end)
        || !unsafe { IsValidSid(label.Label.Sid) }.as_bool() {
        return Err("invalid integrity SID".into());
    }
    Ok(unsafe { *GetSidSubAuthority(label.Label.Sid, (count - 1) as u32) })
}

fn ordinary_process(process: HANDLE) -> Result<(), String> {
    let target = token(process)?;
    // SAFETY: borrowed pseudo-handle, deliberately never closed.
    let current = token(unsafe { GetCurrentProcess() })?;
    let session = token_u32(current.0, TokenSessionId)?;
    if session == 0 || session != token_u32(target.0, TokenSessionId)?
        || token_u32(current.0, TokenElevation)? != 0 || token_u32(target.0, TokenElevation)? != 0
        || token_u32(current.0, TokenUIAccess)? != 0 || token_u32(target.0, TokenUIAccess)? != 0
        || integrity(target.0)? > integrity(current.0)? {
        return Err("elevated, UIAccess, other-session or higher-integrity targets are unsupported".into());
    }
    Ok(())
}

// Exact executable leaf identities derived from a queried image path, not title/PID
// name guesses. This is deliberately conservative and NOT a complete security denylist.
fn protected_executable(leaf: &str) -> bool {
    matches!(leaf, "gentle-dot.exe" | "systemsettings.exe" | "applicationframehost.exe"
        | "consent.exe" | "credentialuibroker.exe" | "logonui.exe" | "winlogon.exe" | "lockapp.exe"
        | "securityhealthsystray.exe" | "sechealthui.exe" | "lsass.exe"
        | "1password.exe" | "bitwarden.exe" | "keepass.exe" | "keepassxc.exe"
        | "dashlane.exe" | "lastpass.exe" | "keeperpasswordmanager.exe"
        | "cmd.exe" | "powershell.exe" | "pwsh.exe" | "windowsterminal.exe"
        | "taskmgr.exe" | "regedit.exe" | "mmc.exe" | "control.exe" | "runas.exe")
}

pub(super) fn identity(window: HWND) -> Result<AppIdentity, String> {
    let pid = window_pid(window)?;
    if pid == std::process::id() || pid > i32::MAX as u32 { return Err("own or invalid target process".into()); }
    // SAFETY: query-only process access, no inheritance, no VM read or privilege request.
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|e| error("target process query", e))?);
    ordinary_process(process.0)?;
    let mut path = [0u16; 32768];
    let mut length = path.len() as u32;
    unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()), &mut length) }.map_err(|e| error("executable identity query", e))?;
    if length == 0 || length as usize >= path.len() { return Err("executable identity exceeds limit".into()); }
    let path = String::from_utf16(&path[..length as usize]).map_err(|_| "invalid executable identity")?.to_lowercase();
    let bytes = path.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err("only local absolute executable identities are supported".into());
    }
    let leaf = path.rsplit('\\').next().ok_or("missing executable leaf")?;
    if !leaf.ends_with(".exe") || protected_executable(leaf) {
        // Only fixed-list names are exposed; arbitrary unsupported identities stay private.
        let reason = if protected_executable(leaf) { leaf } else { "unsupported executable suffix" };
        return Err(format!("protected executable target refused: {reason}"));
    }
    if window_pid(window)? != pid { return Err("target window changed owner".into()); }
    Ok(AppIdentity { pid: pid as i32, name: leaf.trim_end_matches(".exe").into(),
        bundle_id: Some(format!("win32:{path}")) })
}

/// Read-only, bounded top-level enumeration. No allocations or panics in the callback.
pub(super) fn windows() -> Result<Vec<usize>, String> {
    struct Rows { values: [usize; 512], length: usize, overflow: bool }
    unsafe extern "system" fn collect(window: HWND, parameter: LPARAM) -> BOOL {
        // SAFETY: EnumWindows is synchronous; parameter is the live stack Rows below.
        let rows = unsafe { &mut *(parameter.0 as *mut Rows) };
        if rows.length == rows.values.len() { rows.overflow = true; return BOOL(0); }
        rows.values[rows.length] = window.0 as usize;
        rows.length += 1;
        BOOL(1)
    }
    let mut rows = Rows { values: [0; 512], length: 0, overflow: false };
    let result = unsafe { EnumWindows(Some(collect), LPARAM((&mut rows as *mut Rows) as isize)) };
    if rows.overflow { return Err("top-level window enumeration exceeds 512 windows".into()); }
    result.map_err(|e| error("window enumeration", e))?;
    Ok(rows.values[..rows.length].to_vec())
}

pub(super) fn visible(window: usize) -> bool {
    unsafe { IsWindowVisible(hwnd(window)) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_executable_identity_is_exact_not_a_title_substring() {
        assert!(protected_executable("consent.exe"));
        assert!(protected_executable("bitwarden.exe"));
        assert!(protected_executable("lockapp.exe"));
        assert!(!protected_executable("my-bitwarden-notes.exe"));
        assert!(!protected_executable("notepad.exe"));
    }
}
