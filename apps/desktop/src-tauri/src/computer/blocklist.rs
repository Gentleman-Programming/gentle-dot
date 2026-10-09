//! Apps no action may target (S24.4): Gentle Dot itself, System Settings, the login and
//! authorization prompts, Keychain Access, and the known password managers.

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

const BLOCKED: &[Entry] = &[
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

fn bundle_matches(bundle: &str, blocked: &str) -> bool {
    let (bundle, blocked) = (bundle.to_lowercase(), blocked.to_lowercase());
    bundle == blocked || bundle.strip_prefix(&blocked).is_some_and(|rest| rest.starts_with('.'))
}

/// Why `app` may not be targeted, or `None` when it may. `own_pid` catches Gentle Dot
/// when it runs unbundled (a development build has no bundle id).
pub fn blocked_reason(app: &AppIdentity, own_pid: i32) -> Option<&'static str> {
    if app.pid == own_pid {
        return Some(BLOCKED[0].label);
    }
    match &app.bundle_id {
        Some(bundle) => BLOCKED.iter().find(|e| e.bundles.iter().any(|b| bundle_matches(bundle, b))).map(|e| e.label),
        None => blocked_name(&app.name),
    }
}

/// The same check for `open_app`, which only has a name or a bundle id (`Keychain Access.app` too).
pub fn blocked_name(name_or_bundle: &str) -> Option<&'static str> {
    let name = name_or_bundle.trim().trim_end_matches('/');
    let name = name.rsplit('/').next().unwrap_or(name);
    let name = name.strip_suffix(".app").unwrap_or(name);
    BLOCKED
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
            assert_eq!(blocked_reason(&app(Some(bundle), "x"), OWN_PID), Some(label), "{bundle}");
        }
    }

    #[test]
    fn helpers_of_a_blocked_bundle_are_blocked() {
        assert_eq!(blocked_reason(&app(Some("com.apple.Passwords.MenuBarExtra"), "x"), OWN_PID), Some("Passwords"));
    }

    #[test]
    fn bundle_ids_compare_case_insensitively() {
        assert_eq!(blocked_reason(&app(Some("COM.APPLE.KEYCHAINACCESS"), "x"), OWN_PID), Some("Keychain Access"));
    }

    #[test]
    fn similar_prefixes_are_not_blocked() {
        assert_eq!(blocked_reason(&app(Some("com.apple.PasswordsX"), "x"), OWN_PID), None);
        assert_eq!(blocked_reason(&app(Some("com.lastpassword.app"), "x"), OWN_PID), None);
    }

    #[test]
    fn ordinary_apps_are_allowed() {
        assert_eq!(blocked_reason(&app(Some("com.apple.Safari"), "Safari"), OWN_PID), None);
        assert_eq!(blocked_reason(&app(None, "Some Tool"), OWN_PID), None);
    }

    #[test]
    fn gentle_dot_is_blocked_by_its_own_pid() {
        let unbundled = AppIdentity { pid: OWN_PID, bundle_id: None, name: "gentle-dot".into() };
        assert_eq!(blocked_reason(&unbundled, OWN_PID), Some("Gentle Dot"));
    }

    #[test]
    fn an_app_without_a_bundle_id_is_checked_by_name() {
        assert_eq!(blocked_reason(&app(None, "SecurityAgent"), OWN_PID), Some("SecurityAgent"));
        assert_eq!(blocked_reason(&app(None, "UserNotificationCenter"), OWN_PID), Some("UserNotificationCenter"));
        assert_eq!(blocked_reason(&app(None, "CoreServicesUIAgent"), OWN_PID), Some("CoreServicesUIAgent"));
    }

    #[test]
    fn open_app_names_and_bundle_ids_are_checked() {
        assert_eq!(blocked_name("System Settings"), Some("System Settings"));
        assert_eq!(blocked_name("system preferences"), Some("System Settings"));
        assert_eq!(blocked_name("Keychain Access.app"), Some("Keychain Access"));
        assert_eq!(blocked_name("com.bitwarden.desktop"), Some("Bitwarden"));
        assert_eq!(blocked_name(" 1password "), Some("1Password"));
        assert_eq!(blocked_name("Safari"), None);
        assert_eq!(blocked_name("com.apple.Safari"), None);
    }

    #[test]
    fn open_app_paths_are_checked_by_their_app_name() {
        assert_eq!(blocked_name("/System/Applications/System Settings.app"), Some("System Settings"));
        assert_eq!(blocked_name("/Applications/1Password.app/"), Some("1Password"));
        assert_eq!(blocked_name("/Applications/Safari.app"), None);
    }
}
