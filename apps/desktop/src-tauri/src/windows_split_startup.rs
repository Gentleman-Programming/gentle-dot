//! Early Windows split-runtime admission. Verification alone never grants launch.

#[path = "daemon/windows_pinned_file.rs"]
mod windows_pinned_file;
#[path = "daemon/windows_split_manifest.rs"]
mod windows_split_manifest;
#[path = "daemon/windows_split_tree.rs"]
mod windows_split_tree;
#[cfg(test)]
#[path = "windows_split_launch_plan.rs"]
mod windows_split_launch_plan;

use std::path::PathBuf;
use windows_split_tree::PinnedTree;

struct InventoryExpectation<'a> {
    bytes: &'a [u8],
    sha256: [u8; 32],
}

// Future trusted builds can embed independently authenticated inventory bytes
// and their pin here. Do not derive the pin from the bytes being checked.
const TRUSTED_INVENTORY: Option<InventoryExpectation<'static>> = None;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    MissingInventory,
    RootUnavailable,
    InventoryRejected,
    LaunchNotWired,
}

impl Refusal {
    pub(super) fn diagnostic(&self) -> &'static str {
        match self {
            Self::MissingInventory => "Gentle Dot split runtime: no trusted inventory pin compiled in.",
            Self::RootUnavailable => "Gentle Dot split runtime: private component root unavailable.",
            Self::InventoryRejected => "Gentle Dot split runtime: component inventory verification failed.",
            Self::LaunchNotWired => "Gentle Dot split runtime: verified component; private launch is not wired.",
        }
    }
}

fn preflight(
    expectation: Option<InventoryExpectation<'_>>,
    resolve_root: impl FnOnce() -> Option<PathBuf>,
) -> Result<PinnedTree, Refusal> {
    let expectation = expectation.ok_or(Refusal::MissingInventory)?;
    let root = resolve_root().ok_or(Refusal::RootUnavailable)?;
    PinnedTree::admit(&root, expectation.bytes, expectation.sha256)
        .map_err(|_| Refusal::InventoryRejected)
}

fn refuse_start(
    expectation: Option<InventoryExpectation<'_>>,
    resolve_root: impl FnOnce() -> Option<PathBuf>,
) -> Refusal {
    match preflight(expectation, resolve_root) {
        Ok(_held) => Refusal::LaunchNotWired,
        Err(refusal) => refusal,
    }
}

pub(super) fn startup_refusal() -> Refusal {
    // No production root resolver until T2 establishes a fixed private root.
    refuse_start(TRUSTED_INVENTORY, || None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::cell::Cell;
    use std::fs::{self, OpenOptions};
    use std::num::NonZeroU16;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::Path;
    use windows_split_launch_plan::{LaunchPlan, PlanError};
    use std::time::{SystemTime, UNIX_EPOCH};

    const MEMBER: &str = "bin/pi.exe";
    const CORE: [&str; 7] = [
        "bin/engram.exe",
        MEMBER,
        "bin/private-storage.exe",
        "daemon/cli.mjs",
        "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
        "node/node.exe",
        "ui/index.html",
    ];

    fn fixture() -> (PathBuf, String) {
        let base = PathBuf::from(std::env::var_os("DOT_SPLIT_STARTUP_TEST_SCRATCH").unwrap());
        assert!(base.is_absolute());
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = base.join(format!("startup-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let files = CORE.map(|path| {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"abc").unwrap();
            format!(
                r#"{{"path":"{path}","type":"file","size":3,"sha256":"{:x}"}}"#,
                Sha256::digest(b"abc"),
            )
        });
        let inventory = format!(
            "{{\"schema\":1,\"target\":\"windows-x64\",\"shell\":\"5.0.0\",\"pi\":\"1.6.0\",\"files\":[{}]}}\n",
            files.join(","),
        );
        (root, inventory)
    }

    fn expectation(raw: &str) -> InventoryExpectation<'_> {
        InventoryExpectation {
            bytes: raw.as_bytes(),
            sha256: Sha256::digest(raw).into(),
        }
    }

    #[test]
    fn missing_compiled_pin_refuses_without_resolving_root() {
        let refusal = refuse_start(None, || panic!("resolver must not run without a pin"));
        assert_eq!(refusal, Refusal::MissingInventory);
        assert_eq!(startup_refusal(), refusal);
        assert_eq!(
            refusal.diagnostic(),
            "Gentle Dot split runtime: no trusted inventory pin compiled in."
        );
    }

    #[test]
    fn exact_synthetic_preflight_holds_files_but_still_refuses_launch() {
        let (root, raw) = fixture();
        let file = root.join(MEMBER);
        let attempt = |access| OpenOptions::new().access_mode(access).share_mode(7).open(&file);
        let held = preflight(Some(expectation(&raw)), || Some(root.clone())).expect("exact tree");
        const WRITE_AND_DELETE: [u32; 2] = [2, 0x0001_0000];
        for access in WRITE_AND_DELETE {
            assert_eq!(attempt(access).unwrap_err().raw_os_error(), Some(32));
        }
        drop(held);
        for access in WRITE_AND_DELETE {
            drop(attempt(access).expect("access released"));
        }
        let refusal = refuse_start(Some(expectation(&raw)), || Some(root));
        assert_eq!(refusal, Refusal::LaunchNotWired);
        assert_eq!(
            refusal.diagnostic(),
            "Gentle Dot split runtime: verified component; private launch is not wired."
        );
        drop(attempt(2).expect("refused launch retains no handles"));
        assert_eq!(fs::read(file).unwrap(), b"abc");
    }

    fn plan(root: &std::path::Path, raw: &str, state: PathBuf) -> Result<LaunchPlan, PlanError> {
        let held = preflight(Some(expectation(raw)), || Some(root.to_owned())).expect("exact tree");
        LaunchPlan::new(held, state, NonZeroU16::new(4317).unwrap())
    }

    #[test]
    fn split_plan_uses_only_admitted_paths_and_explicit_environment() {
        let (root, raw) = fixture();
        // A shared text prefix is not a shared path component.
        let state = root.with_file_name(format!("{}-state", root.file_name().unwrap().to_str().unwrap()));
        fs::create_dir(&state).unwrap();

        let launch = plan(&root, &raw, state.clone()).expect("separate state");
        assert_eq!(Path::new(launch.program()), root.join(r"node\node.exe"));
        assert_eq!(launch.args(), [root.join(r"daemon\cli.mjs").to_str().unwrap()]);
        assert_eq!(launch.data_dir(), state);
        assert_eq!(launch.env(), &[
            ("GENTLE_DOT_RUNTIME".into(), root.to_str().unwrap().to_owned()),
            ("GENTLE_DOT_DATA_DIR".into(), state.to_str().unwrap().to_owned()),
            ("GENTLE_DOT_PORT".into(), "4317".into()),
            ("PATH".into(), format!(r"{0}\bin;{0}\node", root.display())),
        ]);
        assert!(fs::read_dir(&state).unwrap().next().is_none());
        drop(launch);
        drop(preflight(Some(expectation(&raw)), || Some(root)).expect("unchanged tree"));
    }

    #[test]
    fn split_plan_refuses_ambiguous_or_overlapping_state() {
        let (root, raw) = fixture();
        for state in [r"state", r"D:state", r"\\host\share\state", r"\\?\D:\state", r"\\.\D:\state",
            "D:/state", r"D:\x\.\state", r"D:\x\..\state", r"D:\x\\state", "D:\\state\\",
            r"D:\state.", r"D:\state ", r"D:\state:stream", r"D:\LONGNA~1", r"D:\nul.txt"] {
            assert!(matches!(plan(&root, &raw, state.into()), Err(PlanError::StatePath)), "{state}");
        }
        let upper_root = PathBuf::from(root.to_str().unwrap().to_ascii_uppercase());
        for state in [root.clone(), upper_root.clone(), upper_root.join("new-state"),
            upper_root.parent().unwrap().to_owned()] {
            assert!(matches!(plan(&root, &raw, state.clone()), Err(PlanError::StateOverlap)), "{state:?}");
        }
        assert!(!root.join("new-state").exists());
        drop(preflight(Some(expectation(&raw)), || Some(root)).expect("unchanged tree"));
    }

    #[test]
    fn split_plan_owns_write_and_delete_guards_until_drop() {
        let (root, raw) = fixture();
        let state = root.with_extension("state");
        fs::create_dir(&state).unwrap();
        let launch = plan(&root, &raw, state).expect("exact tree");
        for path in [Path::new(launch.program()), Path::new(&launch.args()[0]), &root.join(MEMBER), &root] {
            for access in [2, 0x0001_0000] { // FILE_WRITE_DATA / FILE_ADD_FILE, DELETE
                assert_eq!(sharing_open(path, access).unwrap_err().raw_os_error(), Some(32), "{path:?}");
            }
        }
        drop(launch);
        for path in [root.join(r"node\node.exe"), root.join(r"daemon\cli.mjs"), root.join(MEMBER), root] {
            for access in [2, 0x0001_0000] {
                drop(sharing_open(&path, access).expect("access released"));
            }
        }
    }

    fn sharing_open(path: &std::path::Path, access: u32) -> std::io::Result<fs::File> {
        OpenOptions::new().access_mode(access).share_mode(7)
            .custom_flags(0x0200_0000).open(path) // FILE_FLAG_BACKUP_SEMANTICS for directories
    }

    #[test]
    fn bad_pin_refuses_without_falling_back() {
        let (root, raw) = fixture();
        let file = root.join(MEMBER);
        let mut pin = expectation(&raw);
        pin.sha256[0] ^= 1;
        let calls = Cell::new(0);
        let refusal = refuse_start(Some(pin), || {
            calls.set(calls.get() + 1);
            Some(root)
        });
        assert_eq!(calls.get(), 1);
        assert_eq!(refusal, Refusal::InventoryRejected);
        assert_eq!(
            refusal.diagnostic(),
            "Gentle Dot split runtime: component inventory verification failed."
        );
        drop(
            OpenOptions::new().write(true).open(&file).expect("no handle retained"),
        );
        assert_eq!(fs::read(file).unwrap(), b"abc");
    }

    #[test]
    fn missing_private_root_refuses_without_falling_back() {
        let (root, raw) = fixture();
        let refusal = refuse_start(Some(expectation(&raw)), || None);
        assert_eq!(refusal, Refusal::RootUnavailable);
        assert_eq!(
            refusal.diagnostic(),
            "Gentle Dot split runtime: private component root unavailable."
        );
        assert_eq!(fs::read(root.join(MEMBER)).unwrap(), b"abc");
    }
}
