//! Which windows are apps, which app a window is, and what `open_app` may launch, on Windows
//! (S24.2, S24.4). Plain rules over what `win` reads from the system, tested on every OS.

/// A top-level window as `win` reads it, front to back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopWindow {
    pub pid: i32,
    pub title: String,
    pub visible: bool,
    /// Hidden by the shell (a suspended Store app keeps a cloaked window).
    pub cloaked: bool,
    /// `WS_EX_TOOLWINDOW`: palettes and floating toolbars, not apps.
    pub tool: bool,
    /// `WS_EX_APPWINDOW`: shown on the taskbar even when owned.
    pub app_window: bool,
    /// Owned by another window (a dialog), so it is part of that window's app.
    pub owned: bool,
}

impl TopWindow {
    /// The taskbar's rule: a visible, titled window that is neither a tool window nor owned,
    /// unless it asks to be on the taskbar.
    pub fn is_app(&self) -> bool {
        self.visible && !self.cloaked && !self.title.trim().is_empty() && (self.app_window || (!self.tool && !self.owned))
    }
}

/// The processes with an app window, front to back, each once.
pub fn app_pids(windows: &[TopWindow]) -> Vec<i32> {
    let mut pids = Vec::new();
    for window in windows.iter().filter(|w| w.is_app()) {
        if !pids.contains(&window.pid) {
            pids.push(window.pid);
        }
    }
    pids
}

/// What `open_app` was asked for: an app's name, or a local program or shortcut by path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Name(String),
    Path(String),
}

/// `text` without `suffix`, compared ASCII case-insensitively.
pub fn strip_ci<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let cut = text.len().checked_sub(suffix.len())?;
    (text.is_char_boundary(cut) && text[cut..].eq_ignore_ascii_case(suffix)).then(|| &text[..cut])
}

/// `X:\` at the start: a path on one of this PC's drives.
fn drive_path(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

fn program_or_shortcut(text: &str) -> bool {
    strip_ci(text, ".exe").is_some() || strip_ci(text, ".lnk").is_some()
}

/// Reads what `open_app` was asked for. Only an app name, or the path of a program (.exe) or a
/// shortcut (.lnk) on a local drive; never a URL, a protocol (`ms-settings:`), a command line, a
/// network share, a script, or a document.
pub fn request(name: &str) -> Result<Request, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("`open_app` needs an app name.".into());
    }
    if name.chars().any(char::is_control) || name.ends_with('.') {
        return Err(format!("`{name}` is not an app name."));
    }
    let colons = name.matches(':').count();
    if colons > 1 || (colons == 1 && !drive_path(name)) {
        return Err(format!("`{name}` is not an app name: URLs and protocols cannot be opened."));
    }
    if name.contains(['"', '<', '>', '|', '&', '^', '%', '*', '?']) || name.contains(" /") || name.contains(" -") {
        return Err(format!("`{name}` is not an app name: command lines cannot be run."));
    }
    if name.contains(['\\', '/']) {
        let local = drive_path(name) && !name.contains('/') && !name.split('\\').any(|part| part == "..");
        if !local {
            return Err(format!("`{name}` is not an app: only programs on this PC's drives can be opened."));
        }
        if !program_or_shortcut(name) {
            return Err(format!("`{name}` is not an app: only programs (.exe) and shortcuts (.lnk) can be opened."));
        }
        return Ok(Request::Path(name.to_string()));
    }
    // A bare name with an extension must be a program or a shortcut (not `notes.txt` or `run.cmd`).
    if name.contains('.') && !program_or_shortcut(name) && name.rsplit('.').next().is_some_and(|ext| !ext.contains(' ')) {
        return Err(format!("`{name}` is not an app: only programs (.exe) and shortcuts (.lnk) can be opened."));
    }
    Ok(Request::Name(name.to_string()))
}

/// The Start menu shortcut named `name` (its file name without `.lnk`, any case).
pub fn shortcut_named<'a>(name: &str, shortcuts: &'a [String]) -> Option<&'a String> {
    let wanted = strip_ci(name, ".lnk").unwrap_or(name);
    shortcuts.iter().find(|path| {
        let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
        strip_ci(file, ".lnk").is_some_and(|stem| stem.eq_ignore_ascii_case(wanted))
    })
}

/// What a shortcut, an App Paths entry, or the search resolved to, when it is a program on a
/// local drive started with no arguments. Anything else (a script, a document, a command line,
/// a network share) is refused, so `open_app` only ever starts a program, as `open -a` does.
pub fn executable_target(path: &str, arguments: &str) -> Result<String, String> {
    let path = path.trim().trim_matches('"').trim();
    if !arguments.trim().is_empty() {
        return Err(format!("`{path}` is started with a command line, so it was not opened."));
    }
    let local = drive_path(path) && path.matches(':').count() == 1 && !path.contains('/') && !path.split('\\').any(|part| part == "..");
    if !local || strip_ci(path, ".exe").is_none() || path.ends_with(['.', ' ']) {
        return Err(format!("`{path}` is not a program on this PC's drives, so it was not opened."));
    }
    Ok(path.to_string())
}

/// Whether a running app answers to `name`: its name or its executable (with or without `.exe`).
pub fn answers_to(name: &str, app_name: &str, executable: Option<&str>) -> bool {
    let name = name.trim();
    let bare = |exe: &str| strip_ci(exe, ".exe").unwrap_or(exe).to_string();
    app_name.eq_ignore_ascii_case(name)
        || executable.is_some_and(|exe| exe.eq_ignore_ascii_case(name) || bare(exe).eq_ignore_ascii_case(&bare(name)))
}

/// The titles of the Control Panel page that holds saved credentials, which File Explorer hosts.
const CREDENTIAL_MANAGER_TITLES: &[&str] = &["Credential Manager", "Administrador de credenciales"];

/// The blocked page a File Explorer window shows, by its title: such a window is that page,
/// not File Explorer.
pub fn hosted_page(executable: Option<&str>, title: &str) -> Option<&'static str> {
    let explorer = executable.is_some_and(|exe| exe.eq_ignore_ascii_case("explorer.exe"));
    let title = title.trim();
    (explorer && CREDENTIAL_MANAGER_TITLES.iter().any(|t| t.eq_ignore_ascii_case(title))).then_some("Credential Manager")
}

/// Whether the window in front stands for an app window being brought forward: the same process
/// (`front_pid`, `pid`) and the same root owner (`front_owner`, `owner`, as addresses), as when the
/// app shows its own dialog. A window that vanished reads as process 0 and owner 0, so two vanished
/// windows never match (that would report an app in front with nothing there).
pub fn fronts_same_app(front_pid: i32, pid: i32, front_owner: usize, owner: usize) -> bool {
    front_pid != 0 && front_owner != 0 && front_pid == pid && front_owner == owner
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(pid: i32, title: &str) -> TopWindow {
        TopWindow { pid, title: title.into(), visible: true, cloaked: false, tool: false, app_window: false, owned: false }
    }

    #[test]
    fn a_window_counts_as_in_front_only_with_a_real_process() {
        // The window itself, or another window of its process under the same owner (its dialog).
        assert!(fronts_same_app(7, 7, 100, 100));
        assert!(!fronts_same_app(7, 8, 100, 100));
        assert!(!fronts_same_app(7, 7, 100, 200));
        // Both windows gone: no process (0) and no owner (0) on either side is not a match.
        assert!(!fronts_same_app(0, 0, 0, 0));
        assert!(!fronts_same_app(0, 0, 100, 100));
    }

    #[test]
    fn a_visible_titled_window_is_an_app() {
        assert!(window(1, "Notepad").is_app());
    }

    #[test]
    fn hidden_cloaked_untitled_tool_and_owned_windows_are_not_apps() {
        assert!(!TopWindow { visible: false, ..window(1, "x") }.is_app());
        assert!(!TopWindow { cloaked: true, ..window(1, "x") }.is_app());
        assert!(!window(1, "  ").is_app());
        assert!(!TopWindow { tool: true, ..window(1, "x") }.is_app());
        assert!(!TopWindow { owned: true, ..window(1, "x") }.is_app());
    }

    #[test]
    fn an_app_window_flag_puts_even_tool_or_owned_windows_on_the_list() {
        assert!(TopWindow { tool: true, app_window: true, ..window(1, "x") }.is_app());
        assert!(TopWindow { owned: true, app_window: true, ..window(1, "x") }.is_app());
        assert!(!TopWindow { app_window: true, visible: false, ..window(1, "x") }.is_app());
    }

    #[test]
    fn each_app_is_listed_once_front_to_back() {
        let windows = [window(7, "Chrome"), TopWindow { tool: true, ..window(9, "Palette") }, window(3, "Notepad"), window(7, "Chrome 2")];
        assert_eq!(app_pids(&windows), [7, 3]);
    }

    #[test]
    fn app_names_and_local_program_or_shortcut_paths_are_accepted() {
        for name in ["Notepad", "chrome.exe", "Visual Studio Code", "Notepad++", "Tool.LNK", "Microsoft Edge"] {
            assert_eq!(request(name), Ok(Request::Name(name.into())), "{name}");
        }
        for path in [r"C:\Program Files\App\app.exe", r"C:\Users\me\Desktop\Tool.LNK", r"D:\Tools\x.EXE"] {
            assert_eq!(request(path), Ok(Request::Path(path.into())), "{path}");
        }
        assert_eq!(request("  Notepad "), Ok(Request::Name("Notepad".into())));
        // Any Unicode name is read without panicking.
        assert_eq!(request("a€"), Ok(Request::Name("a€".into())));
        assert_eq!(request("€:"), Err("`€:` is not an app name: URLs and protocols cannot be opened.".into()));
    }

    #[test]
    fn urls_protocols_command_lines_scripts_documents_and_shares_are_refused() {
        for name in [
            "", "  ", "ms-settings:", "ms-settings:privacy", "https://example.com", "file:///C:/x.exe", "cmd /c del x",
            "powershell -c x", "a & b", "a | b", "%COMSPEC%", "x*.exe", "notes.txt", "payload.cmd", "run.bat", "x.vbs",
            "chrome.exe.", "a\u{7}b", r"C:\x\notes.txt", r"\\server\share\app.exe", r"C:\a:b.exe", r"C:\x\..\Windows\cmd.exe",
            "C:/x/app.exe", r"tools\app.exe",
        ] {
            assert!(request(name).is_err(), "{name:?} should be refused");
        }
        assert!(request("ms-settings:").unwrap_err().contains("protocols"));
        assert!(request("cmd /c del x").unwrap_err().contains("command lines"));
        assert!(request("payload.cmd").unwrap_err().contains("only programs"));
    }

    #[test]
    fn a_start_menu_shortcut_is_found_by_its_name_in_any_case() {
        let shortcuts = [r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk".to_string(), r"C:\Users\me\Start Menu\Programs\Notes\NOTES.LNK".to_string()];
        assert_eq!(shortcut_named("google chrome", &shortcuts), Some(&shortcuts[0]));
        assert_eq!(shortcut_named("Notes.lnk", &shortcuts), Some(&shortcuts[1]));
        assert_eq!(shortcut_named("Chrome", &shortcuts), None);
    }

    #[test]
    fn only_a_local_program_started_without_arguments_is_launched() {
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        assert_eq!(executable_target(chrome, ""), Ok(chrome.into()));
        assert_eq!(executable_target(&format!("\"{chrome}\""), "  "), Ok(chrome.into()));
        assert!(executable_target(r"C:\Windows\System32\cmd.exe", "/c del x").unwrap_err().contains("command line"));
        for target in [r"C:\x\run.cmd", r"C:\x\notes.txt", r"\\server\share\app.exe", r"C:\x\a.exe:stream", r"C:\x\..\y\a.exe", "app.exe", r"C:\x\a.exe.", ""] {
            assert!(executable_target(target, "").is_err(), "{target:?} should be refused");
        }
    }

    #[test]
    fn suffixes_compare_case_insensitively_and_safely() {
        assert_eq!(strip_ci("Tool.LnK", ".lnk"), Some("Tool"));
        assert_eq!(strip_ci("a.Exe", ".exe"), Some("a"));
        assert_eq!(strip_ci("exe", ".exe"), None);
        assert_eq!(strip_ci("€exe", ".exe"), None);
    }

    #[test]
    fn a_file_explorer_window_showing_credential_manager_is_that_page() {
        assert_eq!(hosted_page(Some("explorer.exe"), "Credential Manager"), Some("Credential Manager"));
        assert_eq!(hosted_page(Some("EXPLORER.EXE"), " administrador de credenciales "), Some("Credential Manager"));
        assert_eq!(hosted_page(Some("explorer.exe"), "Downloads"), None);
        assert_eq!(hosted_page(Some("notepad.exe"), "Credential Manager"), None);
        assert_eq!(hosted_page(None, "Credential Manager"), None);
    }

    #[test]
    fn a_running_app_answers_to_its_name_or_executable() {
        assert!(answers_to("notepad", "Notepad", Some("Notepad.exe")));
        assert!(answers_to("NOTEPAD.EXE", "Notepad", Some("Notepad.exe")));
        assert!(answers_to("Google Chrome", "Google Chrome", Some("chrome.exe")));
        assert!(answers_to("chrome", "Google Chrome", Some("chrome.exe")));
        assert!(!answers_to("chrom", "Google Chrome", Some("chrome.exe")));
        assert!(!answers_to("Notepad", "Paint", None));
        assert!(answers_to("notepad", "Notepad", Some("NOTEPAD.Exe")));
    }
}
