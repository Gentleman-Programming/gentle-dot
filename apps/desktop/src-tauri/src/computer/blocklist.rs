//! Apps no action may target (S24.4): Gentle Dot itself, System Settings, the login and
//! authorization prompts, Keychain Access, and the known password managers.
//!
//! Each platform has its own list. On Windows the bundle id is the executable's file name
//! (`Bitwarden.exe`), so a listed stem (`bitwarden`) blocks it by the same prefix rule.

/// The app an action targets: the frontmost app for keyboard actions, the owner of the
/// window under the point for pointer actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub name: String,
}

struct Entry {
    label: &'static str,
    /// A bundle id also blocks its helpers (`com.apple.Passwords` blocks `com.apple.Passwords.MenuBarExtra`).
    bundles: &'static [&'static str],
    names: &'static [&'static str],
}

pub const GENTLE_DOT_BUNDLE: &str = "dev.gentleman.gentle-dot";

/// The name Windows gives an app it does not identify (a process it does not let be queried, a
/// Store frame whose app is not found). It is blocked: an action aimed there is refused.
pub const UNIDENTIFIED: &str = "Unidentified app";

/// macOS.
const MACOS: &[Entry] = &[
    Entry { label: "Gentle Dot", bundles: &[GENTLE_DOT_BUNDLE], names: &["Gentle Dot"] },
    Entry {
        label: "System Settings",
        bundles: &["com.apple.systempreferences"],
        names: &["System Settings", "System Preferences"],
    },
    Entry { label: "SecurityAgent", bundles: &["com.apple.SecurityAgent"], names: &["SecurityAgent"] },
    Entry { label: "loginwindow", bundles: &["com.apple.loginwindow"], names: &["loginwindow"] },
    // System prompts: permission (TCC) requests, Touch ID and password sheets, and the
    // "open this app?" confirmations.
    Entry {
        label: "UserNotificationCenter",
        bundles: &["com.apple.UserNotificationCenter"],
        names: &["UserNotificationCenter"],
    },
    Entry {
        label: "LocalAuthentication",
        bundles: &["com.apple.LocalAuthentication.UIAgent"],
        names: &["LocalAuthenticationUIAgent"],
    },
    Entry {
        label: "CoreServicesUIAgent",
        bundles: &["com.apple.CoreServicesUIAgent"],
        names: &["CoreServicesUIAgent"],
    },
    Entry { label: "Keychain Access", bundles: &["com.apple.keychainaccess"], names: &["Keychain Access"] },
    Entry {
        label: "1Password",
        bundles: &["com.1password", "com.agilebits"],
        names: &["1Password", "1Password 7", "1Password 8"],
    },
    Entry { label: "Bitwarden", bundles: &["com.bitwarden"], names: &["Bitwarden"] },
    Entry { label: "Dashlane", bundles: &["com.dashlane"], names: &["Dashlane"] },
    Entry { label: "LastPass", bundles: &["com.lastpass"], names: &["LastPass"] },
    Entry { label: "Passwords", bundles: &["com.apple.Passwords"], names: &["Passwords"] },
];

/// Windows: Settings and Control Panel, Windows Security, the UAC, credential, and sign-in
/// prompts, Credential Manager, and the known password managers.
const WINDOWS: &[Entry] = &[
    Entry { label: "Gentle Dot", bundles: &["gentle-dot"], names: &["Gentle Dot"] },
    Entry { label: "Settings", bundles: &["systemsettings"], names: &["Settings", "Windows Settings"] },
    Entry { label: "Control Panel", bundles: &["control"], names: &["Control Panel"] },
    Entry {
        label: "Windows Security",
        bundles: &["sechealthui", "securityhealthsystray"],
        names: &["Windows Security"],
    },
    Entry { label: "User Account Control", bundles: &["consent"], names: &["User Account Control"] },
    Entry { label: "CredentialUIBroker", bundles: &["credentialuibroker"], names: &["CredentialUIBroker"] },
    Entry { label: "LogonUI", bundles: &["logonui"], names: &["LogonUI"] },
    Entry { label: "LockApp", bundles: &["lockapp"], names: &["LockApp"] },
    Entry { label: "Credential Manager", bundles: &[], names: &["Credential Manager"] },
    Entry { label: "1Password", bundles: &["1password"], names: &["1Password"] },
    Entry { label: "Bitwarden", bundles: &["bitwarden"], names: &["Bitwarden"] },
    Entry { label: "Dashlane", bundles: &["dashlane"], names: &["Dashlane"] },
    Entry { label: "LastPass", bundles: &["lastpass"], names: &["LastPass"] },
    Entry { label: "KeePass", bundles: &["keepass"], names: &["KeePass", "KeePass Password Safe"] },
    Entry { label: "KeePassXC", bundles: &["keepassxc"], names: &["KeePassXC"] },
    Entry { label: "an app Windows does not identify", bundles: &[], names: &[UNIDENTIFIED] },
];

/// Each build uses its own platform's list; the tests check both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum Platform {
    MacOs,
    Windows,
}

#[cfg(not(windows))]
const PLATFORM: Platform = Platform::MacOs;
#[cfg(windows)]
const PLATFORM: Platform = Platform::Windows;

fn entries(platform: Platform) -> &'static [Entry] {
    match platform {
        Platform::MacOs => MACOS,
        Platform::Windows => WINDOWS,
    }
}

fn bundle_matches(bundle: &str, blocked: &str) -> bool {
    let (bundle, blocked) = (bundle.to_lowercase(), blocked.to_lowercase());
    bundle == blocked || bundle.strip_prefix(&blocked).is_some_and(|rest| rest.starts_with('.'))
}

/// Why `app` may not be targeted, or `None` when it may. `own_pid` catches Gentle Dot
/// when it runs unbundled (a development build has no bundle id).
pub fn blocked_reason(app: &AppIdentity, own_pid: i32) -> Option<&'static str> {
    blocked_reason_on(PLATFORM, app, own_pid)
}

fn blocked_reason_on(platform: Platform, app: &AppIdentity, own_pid: i32) -> Option<&'static str> {
    let blocked = entries(platform);
    if app.pid == own_pid {
        return Some(blocked[0].label);
    }
    match &app.bundle_id {
        Some(bundle) => blocked.iter().find(|e| e.bundles.iter().any(|b| bundle_matches(bundle, b))).map(|e| e.label),
        None => blocked_name_on(platform, &app.name),
    }
}

/// The same check for `open_app`, which only has a name or a bundle id (`Keychain Access.app` too,
/// or on Windows an executable or shortcut, by name or path).
pub fn blocked_name(name_or_bundle: &str) -> Option<&'static str> {
    blocked_name_on(PLATFORM, name_or_bundle)
}

/// The app name in a name, bundle id, or path: its last component without the app suffix.
fn app_name(platform: Platform, name_or_bundle: &str) -> &str {
    match platform {
        Platform::MacOs => {
            let name = name_or_bundle.trim().trim_end_matches('/');
            let name = name.rsplit('/').next().unwrap_or(name);
            name.strip_suffix(".app").unwrap_or(name)
        }
        Platform::Windows => {
            let name = name_or_bundle.trim().trim_end_matches(['/', '\\']);
            let name = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
            let lower = name.to_ascii_lowercase();
            [".exe", ".lnk"]
                .iter()
                .find(|suffix| lower.ends_with(*suffix))
                .map_or(name, |suffix| &name[..name.len() - suffix.len()])
        }
    }
}

fn blocked_name_on(platform: Platform, name_or_bundle: &str) -> Option<&'static str> {
    let name = app_name(platform, name_or_bundle);
    entries(platform)
        .iter()
        .find(|e| {
            e.names.iter().any(|n| n.eq_ignore_ascii_case(name)) || e.bundles.iter().any(|b| bundle_matches(name, b))
        })
        .map(|e| e.label)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN_PID: i32 = 4242;

    fn mac_reason(app: &AppIdentity, own_pid: i32) -> Option<&'static str> {
        blocked_reason_on(Platform::MacOs, app, own_pid)
    }

    fn mac_name(name: &str) -> Option<&'static str> {
        blocked_name_on(Platform::MacOs, name)
    }

    fn windows_reason(app: &AppIdentity) -> Option<&'static str> {
        blocked_reason_on(Platform::Windows, app, OWN_PID)
    }

    fn windows_name(name: &str) -> Option<&'static str> {
        blocked_name_on(Platform::Windows, name)
    }

    fn app(bundle: Option<&str>, name: &str) -> AppIdentity {
        AppIdentity { pid: 100, bundle_id: bundle.map(str::to_string), name: name.into() }
    }

    #[test]
    fn every_listed_bundle_is_blocked() {
        let cases = [
            ("com.apple.systempreferences", "System Settings"),
            ("com.apple.SecurityAgent", "SecurityAgent"),
            ("com.apple.loginwindow", "loginwindow"),
            ("com.apple.keychainaccess", "Keychain Access"),
            ("com.1password.1password", "1Password"),
            ("com.agilebits.onepassword7", "1Password"),
            ("com.bitwarden.desktop", "Bitwarden"),
            ("com.dashlane.dashlanephonefinal", "Dashlane"),
            ("com.lastpass.LastPass", "LastPass"),
            ("com.apple.Passwords", "Passwords"),
            ("dev.gentleman.gentle-dot", "Gentle Dot"),
            ("com.apple.UserNotificationCenter", "UserNotificationCenter"),
            ("com.apple.LocalAuthentication.UIAgent", "LocalAuthentication"),
            ("com.apple.CoreServicesUIAgent", "CoreServicesUIAgent"),
        ];
        for (bundle, label) in cases {
            assert_eq!(mac_reason(&app(Some(bundle), "x"), OWN_PID), Some(label), "{bundle}");
        }
    }

    #[test]
    fn helpers_of_a_blocked_bundle_are_blocked() {
        assert_eq!(mac_reason(&app(Some("com.apple.Passwords.MenuBarExtra"), "x"), OWN_PID), Some("Passwords"));
    }

    #[test]
    fn bundle_ids_compare_case_insensitively() {
        assert_eq!(mac_reason(&app(Some("COM.APPLE.KEYCHAINACCESS"), "x"), OWN_PID), Some("Keychain Access"));
    }

    #[test]
    fn similar_prefixes_are_not_blocked() {
        assert_eq!(mac_reason(&app(Some("com.apple.PasswordsX"), "x"), OWN_PID), None);
        assert_eq!(mac_reason(&app(Some("com.lastpassword.app"), "x"), OWN_PID), None);
    }

    #[test]
    fn ordinary_apps_are_allowed() {
        assert_eq!(mac_reason(&app(Some("com.apple.Safari"), "Safari"), OWN_PID), None);
        assert_eq!(mac_reason(&app(None, "Some Tool"), OWN_PID), None);
    }

    #[test]
    fn gentle_dot_is_blocked_by_its_own_pid() {
        let unbundled = AppIdentity { pid: OWN_PID, bundle_id: None, name: "gentle-dot".into() };
        assert_eq!(mac_reason(&unbundled, OWN_PID), Some("Gentle Dot"));
    }

    #[test]
    fn an_app_without_a_bundle_id_is_checked_by_name() {
        assert_eq!(mac_reason(&app(None, "SecurityAgent"), OWN_PID), Some("SecurityAgent"));
        assert_eq!(mac_reason(&app(None, "UserNotificationCenter"), OWN_PID), Some("UserNotificationCenter"));
        assert_eq!(mac_reason(&app(None, "CoreServicesUIAgent"), OWN_PID), Some("CoreServicesUIAgent"));
    }

    #[test]
    fn open_app_names_and_bundle_ids_are_checked() {
        assert_eq!(mac_name("System Settings"), Some("System Settings"));
        assert_eq!(mac_name("system preferences"), Some("System Settings"));
        assert_eq!(mac_name("Keychain Access.app"), Some("Keychain Access"));
        assert_eq!(mac_name("com.bitwarden.desktop"), Some("Bitwarden"));
        assert_eq!(mac_name(" 1password "), Some("1Password"));
        assert_eq!(mac_name("Safari"), None);
        assert_eq!(mac_name("com.apple.Safari"), None);
    }

    #[test]
    fn open_app_paths_are_checked_by_their_app_name() {
        assert_eq!(mac_name("/System/Applications/System Settings.app"), Some("System Settings"));
        assert_eq!(mac_name("/Applications/1Password.app/"), Some("1Password"));
        assert_eq!(mac_name("/Applications/Safari.app"), None);
    }

    #[test]
    fn the_platform_list_is_the_one_this_build_targets() {
        assert_eq!(PLATFORM, if cfg!(windows) { Platform::Windows } else { Platform::MacOs });
    }

    #[test]
    fn every_listed_windows_executable_is_blocked() {
        let cases = [
            ("gentle-dot.exe", "Gentle Dot"),
            ("SystemSettings.exe", "Settings"),
            ("control.exe", "Control Panel"),
            ("SecHealthUI.exe", "Windows Security"),
            ("SecurityHealthSystray.exe", "Windows Security"),
            ("consent.exe", "User Account Control"),
            ("CredentialUIBroker.exe", "CredentialUIBroker"),
            ("LogonUI.exe", "LogonUI"),
            ("LockApp.exe", "LockApp"),
            ("1Password.exe", "1Password"),
            ("Bitwarden.exe", "Bitwarden"),
            ("Dashlane.exe", "Dashlane"),
            ("LastPass.exe", "LastPass"),
            ("KeePass.exe", "KeePass"),
            ("KeePassXC.exe", "KeePassXC"),
        ];
        for (exe, label) in cases {
            assert_eq!(windows_reason(&app(Some(exe), "x")), Some(label), "{exe}");
        }
    }

    #[test]
    fn similar_windows_executables_are_not_blocked() {
        for exe in ["notepad.exe", "controller.exe", "keepassword.exe", "explorer.exe", "chrome.exe"] {
            assert_eq!(windows_reason(&app(Some(exe), "x")), None, "{exe}");
        }
    }

    #[test]
    fn gentle_dot_is_blocked_by_its_own_pid_on_windows_too() {
        let own = AppIdentity { pid: OWN_PID, bundle_id: Some("whatever.exe".into()), name: "x".into() };
        assert_eq!(windows_reason(&own), Some("Gentle Dot"));
    }

    #[test]
    fn a_windows_app_without_an_executable_is_checked_by_name() {
        assert_eq!(windows_reason(&app(None, "Windows Security")), Some("Windows Security"));
        assert_eq!(windows_reason(&app(None, "Notepad")), None);
    }

    #[test]
    fn windows_open_app_names_executables_and_paths_are_checked() {
        assert_eq!(windows_name("Settings"), Some("Settings"));
        assert_eq!(windows_name(" credential manager "), Some("Credential Manager"));
        assert_eq!(windows_name("Bitwarden.exe"), Some("Bitwarden"));
        assert_eq!(windows_name(r"C:\Windows\System32\control.exe"), Some("Control Panel"));
        assert_eq!(windows_name(r"C:\Program Files\KeePass Password Safe 2\KeePass.exe"), Some("KeePass"));
        assert_eq!(windows_name(r"C:\Users\me\Desktop\1Password.lnk"), Some("1Password"));
        assert_eq!(windows_name("KeePass Password Safe"), Some("KeePass"));
        assert_eq!(windows_name("Notepad"), None);
        assert_eq!(windows_name(r"C:\Windows\notepad.exe"), None);
    }

    #[test]
    fn an_app_windows_does_not_identify_is_blocked_on_windows_only() {
        let unknown = AppIdentity { pid: 77, bundle_id: None, name: UNIDENTIFIED.into() };
        assert_eq!(windows_reason(&unknown), Some("an app Windows does not identify"));
        assert_eq!(mac_reason(&unknown, OWN_PID), None);
        // An identified app keeps its own verdict even if it happens to carry that name.
        assert_eq!(windows_reason(&app(Some("tool.exe"), UNIDENTIFIED)), None);
    }

    #[test]
    fn the_lists_stay_apart() {
        // macOS keeps exactly its list; Windows names do not block anything there, and back.
        assert_eq!(mac_name("Control Panel"), None);
        assert_eq!(mac_name("KeePass"), None);
        assert_eq!(windows_name("Keychain Access"), None);
        assert_eq!(windows_name("System Settings"), None);
    }
}
