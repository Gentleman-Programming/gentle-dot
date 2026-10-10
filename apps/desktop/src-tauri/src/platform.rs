//! Platform decisions for the desktop shell (design §9), kept pure so they are tested on
//! every OS: the GDK backend on Linux, who places the windows, the panel URL, and what a
//! second launch (`gentle-dot --toggle`) asks the running app to do.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Linux,
}

impl Os {
    pub const CURRENT: Os = if cfg!(target_os = "macos") { Os::MacOs } else { Os::Linux };

    /// Only macOS blurs the desktop behind the panel (`HudWindow`); Linux has no window effects.
    pub fn has_vibrancy(self) -> bool {
        self == Os::MacOs
    }
}

/// Window titles. Hyprland rules (`scripts/linux/hyprland/`) match them, so keep them stable.
pub const DOT_TITLE: &str = "Gentle Dot";
pub const PANEL_TITLE: &str = "Gentle Dot Panel";

/// The panel page. Without vibrancy, `effects=none` makes the UI paint an opaque background.
pub fn panel_url(os: Os) -> &'static str {
    if os.has_vibrancy() {
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

pub(crate) fn is_niri(env: &impl Fn(&str) -> Option<String>) -> bool {
    if set(env, "NIRI_SOCKET").is_some() {
        return true;
    }
    // XDG_CURRENT_DESKTOP is a colon-separated list; only an exact `niri` token
    // counts, so desktops that merely contain those letters do not match.
    set(env, "XDG_CURRENT_DESKTOP")
        .is_some_and(|desktop| desktop.split(':').any(|entry| entry.trim().eq_ignore_ascii_case("niri")))
}

fn is_wayland(env: &impl Fn(&str) -> Option<String>) -> bool {
    set(env, "WAYLAND_DISPLAY").is_some() || set(env, "XDG_SESSION_TYPE").as_deref() == Some("wayland")
}

/// `Some("x11")` when the app should run under XWayland: a Wayland session that is not
/// Hyprland or Niri (GNOME on Debian and Ubuntu), with XWayland available and no `GDK_BACKEND`
/// chosen by the user. Under X11 the app can place its windows, keep the Dot on top,
/// and snap it to an edge; native Wayland allows none of that.
pub fn forced_gdk_backend(env: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let wanted = is_wayland(&env)
        && !is_hyprland(&env)
        && !is_niri(&env)
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
    fn niri_stays_native_wayland() {
        // NIRI_SOCKET alone is enough, even without XDG_CURRENT_DESKTOP.
        let socket: &[(&str, &str)] = &[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("DISPLAY", ":0"),
            ("NIRI_SOCKET", "/run/user/1000/niri.wayland-1.1234.sock"),
        ];
        assert_eq!(forced_gdk_backend(env_of(socket)), None);
        assert!(compositor_places_windows(env_of(socket)));
        // Or an exact `niri` token in the colon-separated desktop list.
        for desktop in ["niri", "Niri", "NIRI", "gnome:niri", "niri:GNOME"] {
            let token = vec![
                ("XDG_SESSION_TYPE", "wayland"),
                ("WAYLAND_DISPLAY", "wayland-1"),
                ("DISPLAY", ":0"),
                ("XDG_CURRENT_DESKTOP", desktop),
            ];
            let env = move |key: &str| token.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string());
            assert_eq!(forced_gdk_backend(&env), None, "{desktop}");
            assert!(compositor_places_windows(&env), "{desktop}");
        }
    }

    #[test]
    fn niri_detection_is_not_a_substring_match() {
        // Tokens that merely contain `niri` are some other desktop: XWayland stays forced.
        for desktop in ["niriway", "aniri", "niri-extra", "gnome:niri-extra"] {
            let nearby = vec![
                ("XDG_SESSION_TYPE", "wayland"),
                ("WAYLAND_DISPLAY", "wayland-0"),
                ("DISPLAY", ":0"),
                ("XDG_CURRENT_DESKTOP", desktop),
            ];
            let env = move |key: &str| nearby.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string());
            assert_eq!(forced_gdk_backend(&env), Some("x11"), "{desktop}");
        }
        // An empty NIRI_SOCKET means nothing, like any other empty variable.
        let empty_socket: &[(&str, &str)] = &[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DISPLAY", ":0"),
            ("XDG_CURRENT_DESKTOP", "ubuntu:GNOME"),
            ("NIRI_SOCKET", ""),
        ];
        assert_eq!(forced_gdk_backend(env_of(empty_socket)), Some("x11"));
    }

    #[test]
    fn an_explicit_gdk_backend_wins_on_niri() {
        let x11_first: &[(&str, &str)] = &[
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("DISPLAY", ":0"),
            ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
            ("GDK_BACKEND", "x11,wayland"),
        ];
        assert_eq!(forced_gdk_backend(env_of(x11_first)), None);
        assert!(!compositor_places_windows(env_of(x11_first)));
    }

    #[test]
    fn niri_snippet_uses_stable_titles_and_toggle() {
        assert!(NIRI_KDL.contains("^Gentle Dot$"), "{NIRI_KDL}");
        assert!(NIRI_KDL.contains("^Gentle Dot Panel$"), "{NIRI_KDL}");
        assert!(NIRI_KDL.contains("gentle-dot"), "{NIRI_KDL}");
        assert!(NIRI_KDL.contains("--toggle"), "{NIRI_KDL}");
        assert!(NIRI_KDL.contains("Mod+Alt+D"), "{NIRI_KDL}");
        assert!(NIRI_KDL.contains("open-floating"), "{NIRI_KDL}");
        // The snippet must not claim an unobserved app-id nor steal Mod+Space:
        // only comments may mention them, never a rule or bind line.
        for line in NIRI_KDL.lines().map(str::trim) {
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            assert!(!line.contains("app-id"), "{line}");
            assert!(!line.contains("Mod+Space"), "{line}");
        }
    }

    const NIRI_KDL: &str = include_str!("../../../../scripts/linux/niri/gentle-dot.kdl");

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

    #[test]
    fn the_panel_uses_vibrancy_only_on_macos() {
        assert!(Os::MacOs.has_vibrancy());
        assert!(!Os::Linux.has_vibrancy());
        assert_eq!(panel_url(Os::MacOs), "index.html?surface=panel");
        assert_eq!(panel_url(Os::Linux), "index.html?surface=panel&effects=none");
    }

    #[test]
    fn current_os_matches_the_build_target() {
        assert_eq!(Os::CURRENT == Os::MacOs, cfg!(target_os = "macos"));
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
