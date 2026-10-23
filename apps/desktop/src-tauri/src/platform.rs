//! Platform decisions for the desktop shell (design §9), kept pure so they are tested on
//! every OS: the GDK backend on Linux, who places the windows, the panel URL, the home folder,
//! and what a second launch (`gentle-dot --toggle`) asks the running app to do.
//!
//! The OS-agnostic decisions live here; translating one into a Tauri type is the caller's job
//! (`shell.rs` maps [`WindowEffect`] onto `tauri::window::Effect`). The decisions stay pure over
//! injected values so they are tested on every OS; the one exception is [`WindowsBackdrop::current`],
//! which reads the Windows facts at runtime behind `cfg(target_os = "windows")` and fails closed.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Linux,
    Windows,
}

/// The backdrop the panel asks the window system for. macOS blurs with the `HudWindow` material.
/// Linux gets nothing, because neither X11 nor Wayland can be relied on to composite a
/// translucent panel. Windows asks for `Mica` only when every fact that makes it real holds —
/// Windows 11 (build ≥ 22000), transparency effects on, a local session, and DWM composition on —
/// and otherwise asks for nothing (see [`windows_panel_effect`] and [`WindowsBackdrop`]).
///
/// The gate is the mitigation, not a proof. Tauri applies at most one Windows material and throws
/// the result away (`tauri/src/vibrancy/windows.rs` scans the effect list with `find` and drops the
/// `window_vibrancy` result), so there is no `Acrylic` fallback and no way to read back whether
/// `Mica` landed. On a machine where the facts hold but the material is still silently dropped, the
/// panel keeps `effects=none` and paints its own background, so it stays readable; whether the blur
/// actually appears is only confirmable by eye.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEffect {
    HudWindow,
    Mica,
    None,
}

impl Os {
    pub const CURRENT: Os = if cfg!(target_os = "macos") {
        Os::MacOs
    } else if cfg!(target_os = "windows") {
        Os::Windows
    } else {
        Os::Linux
    };

    /// The panel's backdrop on this OS, from the Windows facts read once at launch. `None` means
    /// the panel must paint an opaque background. macOS and Linux ignore `facts`.
    pub fn panel_effect(self, facts: WindowsBackdrop) -> WindowEffect {
        match self {
            Os::MacOs => WindowEffect::HudWindow,
            Os::Linux => WindowEffect::None,
            Os::Windows => windows_panel_effect(facts),
        }
    }

    /// Whether the window system blurs the desktop behind the panel.
    pub fn has_panel_effect(self, facts: WindowsBackdrop) -> bool {
        self.panel_effect(facts) != WindowEffect::None
    }

    /// The panel shortcut a fresh install binds. macOS and Linux keep `Alt+Space`; Windows uses
    /// `Ctrl+Shift+Space`, because `Alt+Space` opens the window menu in every app and a global
    /// hotkey on it would take that menu away. The OS does not refuse it — measured on Windows 11,
    /// `RegisterHotKey` accepts `Alt+Space`; the conflict is what makes it a poor default.
    pub fn default_shortcut(self) -> &'static str {
        match self {
            Os::MacOs | Os::Linux => "Alt+Space",
            Os::Windows => "Ctrl+Shift+Space",
        }
    }
}

/// The user's home folder, from the variables this OS actually sets.
///
/// **Windows does not define `HOME`** — only MSYS and similar shells do — so an app started the
/// way a user starts it (Explorer, the Start menu, autostart) has none. Reading `HOME` alone
/// therefore left the data dir as a bare relative `.gentle-dot`, resolved against the working
/// directory, and the app never found its own token (W22). Windows sets `USERPROFILE`, with
/// `HOMEDRIVE` + `HOMEPATH` as the older pair; macOS and Linux set `HOME`.
///
/// `None` is the honest answer when nothing names a home, and the caller must fail rather than
/// invent a relative path.
pub fn home_dir(os: Os, env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    // A blank value is not a folder: `USERPROFILE=   ` must not become a home called `   `.
    let value = |key: &str| env(key).filter(|value| !value.trim().is_empty());
    match os {
        Os::Windows => value("USERPROFILE").map(PathBuf::from).or_else(|| {
            let drive = value("HOMEDRIVE")?;
            let rest = value("HOMEPATH")?;
            Some(PathBuf::from(format!("{drive}{rest}")))
        }),
        Os::MacOs | Os::Linux => value("HOME").map(PathBuf::from),
    }
}

/// The Windows facts that decide whether `Mica` is real, injected so the decision is pure and
/// tested on every OS. All four must hold: the material needs Windows 11 (build ≥ 22000), the
/// user's transparency setting, a local session (not Remote Desktop), and DWM composition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsBackdrop {
    /// The OS build number, e.g. 26100 for Windows 11 24H2.
    pub build: u32,
    /// `EnableTransparency` under the user's Personalize key.
    pub transparency: bool,
    /// Whether this is a Remote Desktop session.
    pub remote_session: bool,
    /// Whether DWM composition is enabled.
    pub composition: bool,
}

/// The first Windows build that has `Mica` at all (Windows 11).
pub const MICA_MIN_BUILD: u32 = 22000;

impl WindowsBackdrop {
    /// The fail-closed default: no facts means no `Mica`, so the panel is opaque and readable. A
    /// caller that cannot read the facts uses this rather than guessing.
    pub const fn unknown() -> Self {
        Self { build: 0, transparency: false, remote_session: false, composition: false }
    }

    /// Reads the facts from this Windows host, or [`unknown`](Self::unknown) if any read fails.
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            windows_facts::read().unwrap_or_else(Self::unknown)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Self::unknown()
        }
    }
}

/// `Mica` only when every fact holds; anything else is [`WindowEffect::None`]. This is the whole
/// decision (L36): asking is not proof, because Tauri gives no readback, so the gate uses the facts
/// that make the material real and otherwise keeps the panel opaque.
pub fn windows_panel_effect(facts: WindowsBackdrop) -> WindowEffect {
    let mica =
        facts.build >= MICA_MIN_BUILD && facts.transparency && !facts.remote_session && facts.composition;
    if mica {
        WindowEffect::Mica
    } else {
        WindowEffect::None
    }
}

/// The Windows fact reader: the one place in this module that names a platform crate. Every call
/// fails closed — an unreadable fact is [`WindowsBackdrop::unknown`], never a panic.
#[cfg(target_os = "windows")]
mod windows_facts {
    use super::WindowsBackdrop;
    use std::ptr;
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, STATUS_SUCCESS};
    use windows_sys::Win32::Graphics::Dwm::DwmIsCompositionEnabled;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;

    const PERSONALIZE: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const ENABLE_TRANSPARENCY: &str = "EnableTransparency";

    /// Reads all four facts, or `None` if any of them cannot be read.
    pub fn read() -> Option<WindowsBackdrop> {
        Some(WindowsBackdrop {
            build: os_build()?,
            transparency: transparency()?,
            remote_session: remote_session(),
            composition: composition()?,
        })
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The honest build number: `RtlGetVersion`, not `GetVersionExW`, which lies under a manifest.
    fn os_build() -> Option<u32> {
        let mut info = OSVERSIONINFOW::default();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        // SAFETY: `info` is an initialized, correctly sized OSVERSIONINFOW that outlives the call.
        let status = unsafe { RtlGetVersion(&mut info) };
        (status == STATUS_SUCCESS).then_some(info.dwBuildNumber)
    }

    fn transparency() -> Option<bool> {
        let subkey = wide(PERSONALIZE);
        let value = wide(ENABLE_TRANSPARENCY);
        let mut key = ptr::null_mut();
        // SAFETY: `subkey` is a NUL-terminated wide string, and `key` receives the opened handle.
        let opened = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut key) };
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut kind = 0u32;
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `key` is open, `value` is NUL-terminated, and `data`/`size` describe the u32 buffer.
        let read = unsafe {
            RegQueryValueExW(
                key,
                value.as_ptr(),
                ptr::null(),
                &mut kind,
                &mut data as *mut u32 as *mut u8,
                &mut size,
            )
        };
        // SAFETY: `key` came from a successful RegOpenKeyExW.
        unsafe { RegCloseKey(key) };
        (read == ERROR_SUCCESS && kind == REG_DWORD && size == 4).then_some(data != 0)
    }

    fn remote_session() -> bool {
        // `GetSystemMetrics` has no failure channel for this index; a non-zero answer means Remote
        // Desktop.
        // SAFETY: the call takes an index and returns an integer; no pointers are involved.
        unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
    }

    fn composition() -> Option<bool> {
        let mut enabled = 0;
        // SAFETY: `enabled` receives the composition flag.
        let hr = unsafe { DwmIsCompositionEnabled(&mut enabled) };
        (hr >= 0).then_some(enabled != 0)
    }
}

/// Window titles. Hyprland rules (`scripts/linux/hyprland/`) match them, so keep them stable.
pub const DOT_TITLE: &str = "Gentle Dot";
pub const PANEL_TITLE: &str = "Gentle Dot Panel";

/// The panel page for a resolved [`WindowEffect`]. Without a backdrop effect, `effects=none` makes
/// the UI paint an opaque background. Taking the effect rather than the OS is what keeps the URL
/// and the material the window asks for from disagreeing: both come from one resolution.
pub fn panel_url(effect: WindowEffect) -> &'static str {
    if effect != WindowEffect::None {
        "index.html?surface=panel"
    } else {
        "index.html?surface=panel&effects=none"
    }
}

fn set(env: &impl Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    env(key).filter(|value| !value.is_empty())
}

fn is_hyprland(env: &impl Fn(&str) -> Option<String>) -> bool {
    set(env, "HYPRLAND_INSTANCE_SIGNATURE").is_some()
        || set(env, "XDG_CURRENT_DESKTOP").is_some_and(|desktop| desktop.to_lowercase().contains("hyprland"))
}

fn is_wayland(env: &impl Fn(&str) -> Option<String>) -> bool {
    set(env, "WAYLAND_DISPLAY").is_some() || set(env, "XDG_SESSION_TYPE").as_deref() == Some("wayland")
}

/// `Some("x11")` when the app should run under XWayland: a Wayland session that is not
/// Hyprland (GNOME on Debian and Ubuntu), with XWayland available and no `GDK_BACKEND`
/// chosen by the user. Under X11 the app can place its windows, keep the Dot on top,
/// and snap it to an edge; native Wayland allows none of that.
pub fn forced_gdk_backend(env: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let wanted = is_wayland(&env)
        && !is_hyprland(&env)
        && set(&env, "DISPLAY").is_some()
        && set(&env, "GDK_BACKEND").is_none();
    wanted.then_some("x11")
}

/// Whether the app runs as a native Wayland client, where the compositor (Hyprland window
/// rules) places the windows and app-registered global shortcuts do not work. Read after
/// `forced_gdk_backend` is applied. `GDK_BACKEND` may be a list; GTK tries its first entry.
pub fn compositor_places_windows(env: impl Fn(&str) -> Option<String>) -> bool {
    if !is_wayland(&env) {
        return false;
    }
    match set(&env, "GDK_BACKEND") {
        Some(backend) => !backend.split(',').next().unwrap_or_default().trim().eq_ignore_ascii_case("x11"),
        None => true,
    }
}

/// What a launch asks for: `--toggle` toggles the panel (bind it to a desktop shortcut);
/// any other launch shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchRequest {
    Toggle,
    Show,
}

/// Reads the arguments of a launch, `args[0]` being the program.
pub fn launch_request(args: &[String]) -> LaunchRequest {
    if args.iter().skip(1).any(|arg| arg == "--toggle") {
        LaunchRequest::Toggle
    } else {
        LaunchRequest::Show
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    const GNOME_WAYLAND: &[(&str, &str)] = &[
        ("XDG_SESSION_TYPE", "wayland"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("DISPLAY", ":0"),
        ("XDG_CURRENT_DESKTOP", "ubuntu:GNOME"),
    ];

    #[test]
    fn gnome_on_wayland_runs_under_xwayland() {
        assert_eq!(forced_gdk_backend(env_of(GNOME_WAYLAND)), Some("x11"));
        assert!(!compositor_places_windows(env_of(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DISPLAY", ":0"),
            ("GDK_BACKEND", "x11"),
        ])));
    }

    #[test]
    fn hyprland_stays_native_wayland() {
        let omarchy: &[(&str, &str)] = &[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("DISPLAY", ":1"),
            ("XDG_CURRENT_DESKTOP", "Hyprland"),
            ("HYPRLAND_INSTANCE_SIGNATURE", "abc"),
            ("GDK_BACKEND", "wayland,x11,*"),
        ];
        assert_eq!(forced_gdk_backend(env_of(omarchy)), None);
        assert!(compositor_places_windows(env_of(omarchy)));
        // Hyprland is recognized by its instance signature even without XDG_CURRENT_DESKTOP.
        let bare: &[(&str, &str)] =
            &[("WAYLAND_DISPLAY", "wayland-1"), ("DISPLAY", ":1"), ("HYPRLAND_INSTANCE_SIGNATURE", "abc")];
        assert_eq!(forced_gdk_backend(env_of(bare)), None);
        assert!(compositor_places_windows(env_of(bare)));
    }

    #[test]
    fn an_explicit_gdk_backend_is_respected() {
        let wayland: &[(&str, &str)] = &[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DISPLAY", ":0"),
            ("GDK_BACKEND", "wayland"),
        ];
        assert_eq!(forced_gdk_backend(env_of(wayland)), None);
        assert!(compositor_places_windows(env_of(wayland)));
        // A list: GTK tries the first entry.
        let x11_first: &[(&str, &str)] =
            &[("WAYLAND_DISPLAY", "wayland-0"), ("DISPLAY", ":0"), ("GDK_BACKEND", "x11,wayland")];
        assert_eq!(forced_gdk_backend(env_of(x11_first)), None);
        assert!(!compositor_places_windows(env_of(x11_first)));
    }

    #[test]
    fn wayland_without_xwayland_is_left_alone() {
        let no_x: &[(&str, &str)] = &[("XDG_SESSION_TYPE", "wayland"), ("WAYLAND_DISPLAY", "wayland-0")];
        assert_eq!(forced_gdk_backend(env_of(no_x)), None);
        assert!(compositor_places_windows(env_of(no_x)));
    }

    #[test]
    fn x11_sessions_and_macos_place_their_own_windows() {
        let x11: &[(&str, &str)] = &[("XDG_SESSION_TYPE", "x11"), ("DISPLAY", ":0")];
        assert_eq!(forced_gdk_backend(env_of(x11)), None);
        assert!(!compositor_places_windows(env_of(x11)));
        assert_eq!(forced_gdk_backend(env_of(&[])), None);
        assert!(!compositor_places_windows(env_of(&[])));
    }

    #[test]
    fn toggle_argument_toggles_the_panel() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(launch_request(&args(&["gentle-dot", "--toggle"])), LaunchRequest::Toggle);
        assert_eq!(launch_request(&args(&["/opt/gentle-dot", "--verbose", "--toggle"])), LaunchRequest::Toggle);
        assert_eq!(launch_request(&args(&["gentle-dot"])), LaunchRequest::Show);
        assert_eq!(launch_request(&args(&["gentle-dot", "toggle", "--toggled"])), LaunchRequest::Show);
        // The program path is never read as an argument.
        assert_eq!(launch_request(&args(&["--toggle"])), LaunchRequest::Show);
        assert_eq!(launch_request(&[]), LaunchRequest::Show);
    }

    /// Windows 11 with every fact that makes `Mica` real: build 26100, transparency on, a local
    /// session, composition on.
    const WINDOWS_11: WindowsBackdrop =
        WindowsBackdrop { build: 26100, transparency: true, remote_session: false, composition: true };

    #[test]
    fn every_os_picks_its_own_panel_backdrop() {
        // macOS always blurs; Linux never gets an effect; Windows asks only when its facts allow it.
        assert_eq!(Os::MacOs.panel_effect(WindowsBackdrop::unknown()), WindowEffect::HudWindow);
        assert_eq!(Os::Windows.panel_effect(WindowsBackdrop::unknown()), WindowEffect::None);
        assert_eq!(Os::Windows.panel_effect(WINDOWS_11), WindowEffect::Mica);
        assert_eq!(Os::Linux.panel_effect(WINDOWS_11), WindowEffect::None);
        // The URL follows the resolved effect, not the OS.
        assert_eq!(panel_url(WindowEffect::HudWindow), "index.html?surface=panel");
        assert_eq!(panel_url(WindowEffect::Mica), "index.html?surface=panel");
        assert_eq!(panel_url(WindowEffect::None), "index.html?surface=panel&effects=none");
    }

    #[test]
    fn mica_is_asked_for_only_when_every_window_fact_holds() {
        assert_eq!(windows_panel_effect(WINDOWS_11), WindowEffect::Mica);
        // At the Windows 11 threshold the material exists; one build below it does not.
        assert_eq!(
            windows_panel_effect(WindowsBackdrop { build: MICA_MIN_BUILD, ..WINDOWS_11 }),
            WindowEffect::Mica
        );
        assert_eq!(
            windows_panel_effect(WindowsBackdrop { build: MICA_MIN_BUILD - 1, ..WINDOWS_11 }),
            WindowEffect::None
        );
        // Each fact on its own turns the request off.
        assert_eq!(
            windows_panel_effect(WindowsBackdrop { transparency: false, ..WINDOWS_11 }),
            WindowEffect::None
        );
        assert_eq!(
            windows_panel_effect(WindowsBackdrop { remote_session: true, ..WINDOWS_11 }),
            WindowEffect::None
        );
        assert_eq!(
            windows_panel_effect(WindowsBackdrop { composition: false, ..WINDOWS_11 }),
            WindowEffect::None
        );
        // The fail-closed default: no facts read means no material.
        assert_eq!(windows_panel_effect(WindowsBackdrop::unknown()), WindowEffect::None);
    }

    #[test]
    fn a_windows_backdrop_that_is_not_mica_leaves_the_panel_opaque() {
        // The defect this guards (L8): a translucent panel whose requested material was ignored is
        // unreadable, and Tauri cannot report whether the effect applied. The material and the URL
        // come from one resolved value, so they cannot disagree.
        let cases = [
            WindowsBackdrop { build: 21999, ..WINDOWS_11 },
            WindowsBackdrop { build: 0, transparency: false, remote_session: false, composition: false },
            WindowsBackdrop { transparency: false, ..WINDOWS_11 },
            WindowsBackdrop { remote_session: true, ..WINDOWS_11 },
            WindowsBackdrop { composition: false, ..WINDOWS_11 },
        ];
        for facts in cases {
            let effect = Os::Windows.panel_effect(facts);
            assert_eq!(effect, WindowEffect::None, "{facts:?}");
            assert!(!Os::Windows.has_panel_effect(facts), "{facts:?}");
            assert!(panel_url(effect).ends_with("effects=none"), "{facts:?}");
        }
        // With every fact holding it asks for `Mica`, and the URL leaves the background to the UI.
        let effect = Os::Windows.panel_effect(WINDOWS_11);
        assert_eq!(effect, WindowEffect::Mica);
        assert!(Os::Windows.has_panel_effect(WINDOWS_11));
        assert!(!panel_url(effect).ends_with("effects=none"));
    }

    /// `has_panel_effect` *is* `panel_effect(..) != None`, so asserting that pair only restates
    /// the definition. The two functions that can actually disagree are `panel_effect`, which
    /// picks the material, and `panel_url`, which decides whether the UI paints its own
    /// background; that is what this test cross-checks for every OS and fact combination.
    #[test]
    fn the_url_agrees_with_the_effect_the_os_chose() {
        for os in [Os::MacOs, Os::Windows, Os::Linux] {
            for facts in [WindowsBackdrop::unknown(), WINDOWS_11] {
                let effect = os.panel_effect(facts);
                assert_eq!(
                    !panel_url(effect).ends_with("effects=none"),
                    effect != WindowEffect::None,
                    "{os:?} {facts:?}"
                );
            }
        }
    }

    #[test]
    fn every_os_picks_its_own_default_shortcut() {
        // Alt+Space opens the window menu on Windows, so the default must not name it there.
        assert_eq!(Os::Windows.default_shortcut(), "Ctrl+Shift+Space");
        assert_eq!(Os::MacOs.default_shortcut(), "Alt+Space");
        assert_eq!(Os::Linux.default_shortcut(), "Alt+Space");
    }

    #[test]
    fn the_home_comes_from_the_variables_this_os_sets() {
        assert_eq!(
            home_dir(Os::Windows, env_of(&[("USERPROFILE", r"C:\Users\me")])),
            Some(PathBuf::from(r"C:\Users\me"))
        );
        // The older pair, joined the way Windows renders it.
        assert_eq!(
            home_dir(Os::Windows, env_of(&[("HOMEDRIVE", "C:"), ("HOMEPATH", r"\Users\me")])),
            Some(PathBuf::from(r"C:\Users\me"))
        );
        assert_eq!(home_dir(Os::Windows, env_of(&[("USERPROFILE", "   ")])), None);
        // The W22 bug: a Windows GUI launch has no HOME, and that must never become a relative path.
        assert_eq!(home_dir(Os::Windows, env_of(&[("HOME", "/home/me")])), None);
        assert_eq!(home_dir(Os::Windows, env_of(&[("HOMEDRIVE", "C:")])), None);
        assert_eq!(home_dir(Os::Linux, env_of(&[("HOME", "/home/me")])), Some(PathBuf::from("/home/me")));
        assert_eq!(home_dir(Os::MacOs, env_of(&[("HOME", "/Users/me")])), Some(PathBuf::from("/Users/me")));
        // The other direction too: Unix does not read USERPROFILE.
        assert_eq!(home_dir(Os::Linux, env_of(&[("USERPROFILE", r"C:\Users\me")])), None);
        assert_eq!(home_dir(Os::MacOs, env_of(&[])), None);
    }

    #[test]
    fn current_os_matches_the_build_target() {
        let expected = if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        };
        assert_eq!(Os::CURRENT, expected);
    }

    #[test]
    fn window_titles_are_distinct_for_hyprland_rules() {
        assert_ne!(DOT_TITLE, PANEL_TITLE);
        for snippet in [HYPRLAND_LUA, HYPRLAND_CONF] {
            assert!(snippet.contains(&format!("^({DOT_TITLE})$")), "{snippet}");
            assert!(snippet.contains(&format!("^({PANEL_TITLE})$")), "{snippet}");
            assert!(snippet.contains("gentle-dot --toggle"), "{snippet}");
        }
    }

    const HYPRLAND_LUA: &str = include_str!("../../../../scripts/linux/hyprland/gentle-dot.lua");
    const HYPRLAND_CONF: &str = include_str!("../../../../scripts/linux/hyprland/gentle-dot.conf");
}
