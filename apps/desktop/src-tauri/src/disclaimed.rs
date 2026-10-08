//! Spawns the daemon on macOS with its TCC responsibility disclaimed (S24.1).
//!
//! A plain spawn makes Gentle Dot.app the "responsible process" of the daemon, so the daemon,
//! the engine, and the agent's shell would inherit the app's Accessibility and Screen Recording
//! grants and could drive the Mac without the helper. With the responsibility disclaimed, the
//! daemon answers for itself and holds no grant.

use crate::daemon::ChildProcess;
use std::collections::BTreeMap;
use std::ffi::{CString, OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;

extern "C" {
    /// libSystem (macOS 10.14+): the spawned process becomes responsible for itself. Chromium
    /// and LLDB use it for the same reason.
    fn responsibility_spawnattrs_setdisclaim(attrs: *mut libc::posix_spawnattr_t, disclaim: libc::c_int)
        -> libc::c_int;
}

/// A process spawned by `spawn_disclaimed`, reaped by its owner like `std::process::Child`.
#[derive(Debug)]
pub struct DisclaimedChild {
    pid: libc::pid_t,
    status: Option<ExitStatus>,
}

impl DisclaimedChild {
    fn wait_with(&mut self, flags: libc::c_int) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        let mut raw = 0;
        loop {
            // SAFETY: `raw` is a valid out-pointer and `pid` is our unreaped child.
            match unsafe { libc::waitpid(self.pid, &mut raw, flags) } {
                0 => return Ok(None),
                -1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => continue,
                -1 => return Err(io::Error::last_os_error()),
                _ => {
                    self.status = Some(ExitStatus::from_raw(raw));
                    return Ok(self.status);
                }
            }
        }
    }
}

impl ChildProcess for DisclaimedChild {
    fn id(&self) -> u32 {
        self.pid as u32
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_with(libc::WNOHANG)
    }

    fn kill(&mut self) -> io::Result<()> {
        if self.status.is_some() {
            return Ok(());
        }
        // SAFETY: the pid is our unreaped child, so it cannot have been reused.
        if unsafe { libc::kill(self.pid, libc::SIGKILL) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait_with(0)?.ok_or_else(|| io::Error::other("waitpid returned no status"))
    }
}

fn check(code: libc::c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

fn c_string(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a NUL byte in the command"))
}

/// `program` itself when it has a `/`, otherwise the first executable match in `path`.
fn resolve(program: &str, path: Option<&OsStr>) -> PathBuf {
    if program.contains('/') {
        return program.into();
    }
    let found = path.into_iter().flat_map(std::env::split_paths).map(|dir| dir.join(program)).find(|candidate| {
        c_string(candidate.as_os_str().as_bytes())
            // SAFETY: a NUL-terminated path.
            .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
    });
    found.unwrap_or_else(|| program.into())
}

struct Attributes(libc::posix_spawnattr_t);

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: initialized by `posix_spawnattr_init`.
        unsafe { libc::posix_spawnattr_destroy(&mut self.0) };
    }
}

struct FileActions(libc::posix_spawn_file_actions_t);

impl Drop for FileActions {
    fn drop(&mut self) {
        // SAFETY: initialized by `posix_spawn_file_actions_init`.
        unsafe { libc::posix_spawn_file_actions_destroy(&mut self.0) };
    }
}

/// Runs `program` with `args` and the app's environment plus `envs`, stdin from `/dev/null`,
/// and stdout and stderr appended to `log`. A program without a `/` is looked up in the
/// child's `PATH`. No other descriptor of the app reaches the child.
pub fn spawn_disclaimed(
    program: &str,
    args: &[String],
    envs: &[(String, String)],
    log: &File,
) -> io::Result<DisclaimedChild> {
    let mut env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    env.extend(envs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))));
    let path = resolve(program, env.get(OsStr::new("PATH")).map(OsString::as_os_str));
    let path = c_string(path.as_os_str().as_bytes())?;
    let argv = std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(|arg| c_string(arg.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let envp = env
        .into_iter()
        .map(|(key, value)| {
            let mut entry = key.into_vec();
            entry.push(b'=');
            entry.extend(value.into_vec());
            c_string(&entry)
        })
        .collect::<io::Result<Vec<_>>>()?;
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|a| a.as_ptr().cast_mut()).collect();
    argv_ptrs.push(std::ptr::null_mut());
    let mut envp_ptrs: Vec<*mut libc::c_char> = envp.iter().map(|e| e.as_ptr().cast_mut()).collect();
    envp_ptrs.push(std::ptr::null_mut());
    let dev_null = c"/dev/null";

    // SAFETY: every pointer handed to posix_spawn outlives the call, and the attribute and
    // file-action objects are initialized before use and destroyed by their guards.
    unsafe {
        let mut attributes = Attributes(std::ptr::null_mut());
        check(libc::posix_spawnattr_init(&mut attributes.0))?;
        // Like `std::process::Command`: an empty signal mask and the default SIGPIPE. Every
        // descriptor not named below is closed in the child.
        let mut empty: libc::sigset_t = 0;
        libc::sigemptyset(&mut empty);
        check(libc::posix_spawnattr_setsigmask(&mut attributes.0, &empty))?;
        let mut pipe: libc::sigset_t = 0;
        libc::sigemptyset(&mut pipe);
        libc::sigaddset(&mut pipe, libc::SIGPIPE);
        check(libc::posix_spawnattr_setsigdefault(&mut attributes.0, &pipe))?;
        let flags = libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
        check(libc::posix_spawnattr_setflags(&mut attributes.0, flags as libc::c_short))?;
        check(responsibility_spawnattrs_setdisclaim(&mut attributes.0, 1))?;

        let mut actions = FileActions(std::ptr::null_mut());
        check(libc::posix_spawn_file_actions_init(&mut actions.0))?;
        check(libc::posix_spawn_file_actions_addopen(&mut actions.0, 0, dev_null.as_ptr(), libc::O_RDONLY, 0))?;
        check(libc::posix_spawn_file_actions_adddup2(&mut actions.0, log.as_raw_fd(), 1))?;
        check(libc::posix_spawn_file_actions_adddup2(&mut actions.0, log.as_raw_fd(), 2))?;

        let mut pid: libc::pid_t = 0;
        check(libc::posix_spawn(
            &mut pid,
            path.as_ptr(),
            &actions.0,
            &attributes.0,
            argv_ptrs.as_ptr(),
            envp_ptrs.as_ptr(),
        ))?;
        Ok(DisclaimedChild { pid, status: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::stop_child;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant};

    extern "C" {
        /// The process macOS holds responsible for `pid` (private libSystem call, read-only).
        fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
    }

    fn scratch_log(name: &str) -> (PathBuf, File) {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gentle-dot-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        (path, log)
    }

    fn sh(script: &str, envs: &[(String, String)], log: &File) -> DisclaimedChild {
        spawn_disclaimed("/bin/sh", &["-c".into(), script.into()], envs, log).unwrap()
    }

    #[test]
    fn the_child_answers_for_itself() {
        let (_, log) = scratch_log("disclaim");
        let mut child = spawn_disclaimed("/bin/sleep", &["30".into()], &[], &log).unwrap();
        thread::sleep(Duration::from_millis(100));
        let pid = child.id() as libc::pid_t;
        // SAFETY: a read-only query about a live child.
        let responsible = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
        assert_eq!(responsible, pid);
        stop_child(&mut child, Duration::from_secs(5));
    }

    #[test]
    fn output_goes_to_the_log_with_the_extra_env_and_no_stdin() {
        let (path, log) = scratch_log("output");
        let envs = [("GENTLE_DOT_TEST".to_string(), "from-spec".to_string())];
        let script = "echo out; echo err >&2; echo \"$GENTLE_DOT_TEST\"; if read x; then echo input; else echo eof; fi";
        let mut child = sh(script, &envs, &log);
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "out\nerr\nfrom-spec\neof\n");
    }

    #[test]
    fn a_bare_program_name_is_found_in_the_child_path() {
        let (path, log) = scratch_log("path");
        let envs = [("PATH".to_string(), "/usr/bin:/bin".to_string())];
        let mut child = spawn_disclaimed("echo", &["found".into()], &envs, &log).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "found\n");
    }

    #[test]
    fn try_wait_reports_running_then_the_exit_code() {
        let (_, log) = scratch_log("status");
        let mut child = sh("sleep 0.3; exit 3", &[], &log);
        assert!(child.try_wait().unwrap().is_none());
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(3));
        // Reaped once; later calls keep answering.
        assert_eq!(child.try_wait().unwrap().and_then(|s| s.code()), Some(3));
        assert_eq!(child.wait().unwrap().code(), Some(3));
        child.kill().unwrap();
    }

    #[test]
    fn stop_child_terminates_then_kills_after_the_grace() {
        let (_, log) = scratch_log("stop");
        let mut child = spawn_disclaimed("/bin/sleep", &["30".into()], &[], &log).unwrap();
        stop_child(&mut child, Duration::from_secs(5));
        assert_eq!(child.try_wait().unwrap().and_then(|s| s.signal()), Some(libc::SIGTERM));
        let mut stubborn = sh("trap '' TERM; sleep 30", &[], &log);
        thread::sleep(Duration::from_millis(100));
        stop_child(&mut stubborn, Duration::from_millis(300));
        assert_eq!(stubborn.try_wait().unwrap().and_then(|s| s.signal()), Some(libc::SIGKILL));
    }

    #[test]
    fn a_missing_program_is_an_error() {
        let (_, log) = scratch_log("missing");
        assert!(spawn_disclaimed("/nonexistent/gentle-dot-node", &[], &[], &log).is_err());
    }
}
