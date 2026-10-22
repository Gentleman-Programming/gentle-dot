//! Windows-only ownership boundary. Anonymous stdio pipes reach only the launched child;
//! a kill-on-close Job owns its descendants, including when the app crashes.
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::daemon::{ChildProcess, LaunchSpec};

/// Protect only the app's data directory, never a drive root or a general user folder.
pub fn private_directory(path: &std::path::Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::*;
    if !path.is_absolute() || path.parent().is_none_or(|p| p.parent().is_none()) {
        return Err(io::Error::other("choose a dedicated absolute Gentle Dot data directory"));
    }
    std::fs::create_dir_all(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x400 != 0 {
        return Err(io::Error::other("the data directory must not be a reparse point"));
    }
    let canonical = std::fs::canonicalize(path)?;
    let key = |p: &std::path::Path| p.as_os_str().to_string_lossy().to_lowercase();
    let forbidden = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];
    if canonical.parent().is_none()
        || forbidden
            .iter()
            .filter_map(std::env::var_os)
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .any(|p| key(&p) == key(&canonical))
    {
        return Err(io::Error::other("choose a dedicated absolute Gentle Dot data directory"));
    }
    // Owner Rights applies to the file owner, not every interactive user. Inheritance keeps
    // new daemon logs/configuration private. System access remains explicit.
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = std::ptr::null_mut();
    let parsed = unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) };
    let mut name: Vec<u16> = canonical.as_os_str().encode_wide().chain(Some(0)).collect();
    let status = if parsed != 0 && present != 0 {
        unsafe {
            SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        }
    } else {
        87
    };
    unsafe {
        LocalFree(descriptor);
    }
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

pub struct ChannelStream {
    reader: File,
    writer: Arc<Mutex<Option<File>>>,
    closed: Arc<AtomicBool>,
}

impl ChannelStream {
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self { reader: self.reader.try_clone()?, writer: self.writer.clone(), closed: self.closed.clone() })
    }

    pub fn shutdown(&self, _: Shutdown) -> io::Result<()> {
        // EOF is opportunistic: a non-draining daemon may be blocking File::write
        // while holding this mutex. Never delay the owner's bounded Job cleanup.
        self.closed.store(true, Ordering::Release);
        match self.writer.try_lock() {
            Ok(mut writer) => {
                writer.take();
            }
            Err(TryLockError::Poisoned(error)) => {
                error.into_inner().take();
            }
            Err(TryLockError::WouldBlock) => {}
        }
        Ok(())
    }
}

impl Read for ChannelStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.reader.read(bytes)
    }
}

impl Write for ChannelStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.closed.load(Ordering::Acquire) {
            return Err(closed_channel());
        }
        let mut writer = self.writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.closed.load(Ordering::Acquire) {
            return Err(closed_channel());
        }
        writer.as_mut().ok_or_else(closed_channel)?.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(closed_channel());
        }
        let mut writer = self.writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.closed.load(Ordering::Acquire) {
            return Err(closed_channel());
        }
        writer.as_mut().ok_or_else(closed_channel)?.flush()
    }
}

fn closed_channel() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "app channel closed")
}

struct OwnedChild {
    child: Child,
    _job: OwnedHandle,
}

impl ChildProcess for OwnedChild {
    fn id(&self) -> u32 {
        self.child.id()
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
    fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }
}

pub fn spawn(
    spec: &LaunchSpec,
    log: File,
    channel: bool,
) -> io::Result<(Box<dyn ChildProcess>, Option<ChannelStream>)> {
    // SAFETY: no name or inherited security descriptor; returned handle is uniquely owned.
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: initialized structure of exactly the required size, and a live Job handle.
    if unsafe {
        SetInformationJobObject(
            raw_job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut command = Command::new(&spec.program);
    if channel {
        // No application import (and therefore no engine child) before Job assignment.
        command.args(["--input-type=module", "--eval",
            "import{readSync}from'node:fs';import{pathToFileURL}from'node:url';const b=Buffer.alloc(1);if(readSync(0,b,0,1,null)!==1||b[0]!==71)process.exit(1);await import(pathToFileURL(process.argv[1]).href)"])
            .args(&spec.args);
    } else {
        command.args(&spec.args);
    }
    command
        .envs(spec.envs.iter().map(|(k, v)| (k, v)))
        // Node preloads could execute before the bootstrap barrier; never inherit them.
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("GENTLE_DOT_APP_STDIO")
        .stderr(log.try_clone()?)
        .creation_flags(CREATE_NO_WINDOW);
    if channel {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).env("GENTLE_DOT_APP_STDIO", "v1");
    } else {
        command.stdin(Stdio::null()).stdout(log);
    }
    let mut child = command.spawn()?;
    // Node blocks on the bootstrap byte before importing or starting the engine. Only after
    // assignment succeeds do we release it. Failure kills and reaps this exact child.
    if unsafe { AssignProcessToJobObject(raw_job, child.as_raw_handle()) } == 0 {
        let error = io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let stream = if channel {
        let input: OwnedHandle = child.stdin.take().ok_or_else(|| io::Error::other("missing app input"))?.into();
        let output: OwnedHandle = child.stdout.take().ok_or_else(|| io::Error::other("missing app output"))?.into();
        let mut writer = File::from(input);
        writer.write_all(b"G")?;
        Some(ChannelStream {
            reader: File::from(output),
            writer: Arc::new(Mutex::new(Some(writer))),
            closed: Arc::new(AtomicBool::new(false)),
        })
    } else {
        None
    };
    Ok((Box::new(OwnedChild { child, _job: job }), stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};

    #[test]
    fn saturated_app_channel_cannot_delay_the_owned_child_stop_deadline() {
        struct Refuse;
        impl crate::app_channel::Handler for Refuse {
            fn approve(&self, _: &crate::approvals::ApprovalRequest) -> bool {
                false
            }
        }
        let root = std::env::temp_dir().join(format!("gentle-dot-backpressure-{}", std::process::id()));
        private_directory(&root).unwrap();
        let script = root.join("not-reading.mjs");
        std::fs::write(&script, "setInterval(()=>{},1000);").unwrap();
        let spec = LaunchSpec {
            program: env!("GENTLE_DOT_BUILD_NODE").into(),
            args: vec![script.display().to_string()],
            envs: vec![],
        };
        let (mut child, stream) = spawn(&spec, File::create(root.join("test.log")).unwrap(), true).unwrap();
        let stream = stream.unwrap();
        let writer = stream.writer.clone();
        let channel = crate::app_channel::AppChannel::start(stream, Arc::new(Refuse)).unwrap();
        let sending = channel.clone();
        let (sent, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result =
                sending.request("blocked", serde_json::json!({"data":"x".repeat(900_000)}), Duration::from_secs(30));
            let _ = sent.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !matches!(writer.try_lock(), Err(TryLockError::WouldBlock)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(writer.try_lock(), Err(TryLockError::WouldBlock)), "the pipe must actually be backpressured");
        let (closed, answer) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            channel.close();
            let _ = closed.send(());
        });
        if answer.recv_timeout(Duration::from_millis(500)).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("channel close waited for the blocked writer");
        }
        let stopping = Instant::now();
        crate::daemon::stop_child(child.as_mut(), Duration::from_millis(100));
        assert!(stopping.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
        assert!(finished.recv_timeout(Duration::from_secs(3)).unwrap().is_err());
    }

    #[test]
    fn owned_windows_pipes_exchange_frames_and_eof_stops_the_child() {
        let root = std::env::temp_dir().join(format!("gentle-dot-pipes-{}", std::process::id()));
        private_directory(&root).unwrap();
        let script = root.join("echo.mjs");
        std::fs::write(&script, "process.stdin.setEncoding('utf8');process.stdin.on('data',s=>process.stdout.write(s));process.stdin.on('end',()=>process.exit(0));").unwrap();
        let spec = LaunchSpec {
            program: env!("GENTLE_DOT_BUILD_NODE").into(),
            args: vec![script.display().to_string()],
            envs: vec![],
        };
        let log = File::create(root.join("test.log")).unwrap();
        let (mut child, stream) = spawn(&spec, log, true).unwrap();
        let mut stream = stream.unwrap();
        stream.write_all(b"{\"kind\":\"request\",\"id\":1}\n").unwrap();
        let reader = stream.try_clone().unwrap();
        let (send, answer) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(reader).read_line(&mut line).map(|_| line);
            let _ = send.send(result);
        });
        let result = answer.recv_timeout(Duration::from_secs(10));
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let line = result.expect("the child must answer within its deadline").unwrap();
        assert_eq!(line, "{\"kind\":\"request\",\"id\":1}\n");
        stream.shutdown(Shutdown::Both).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = child.try_wait().unwrap().expect("EOF must end the owned daemon");
        assert!(status.success());
    }

    #[test]
    fn data_directory_cannot_be_a_general_user_folder() {
        let profile = std::env::var_os("USERPROFILE").unwrap();
        assert!(private_directory(std::path::Path::new(&profile)).is_err());
        assert!(private_directory(std::path::Path::new("C:\\")).is_err());
        assert!(private_directory(std::path::Path::new("relative")).is_err());
    }
}
