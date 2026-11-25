use super::*;
use std::cell::Cell;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::thread;

type Outcome = Result<(), &'static str>;
const ADMISSION_LIMIT: Duration = Duration::from_secs(10);
const CHALLENGE: &[u8] = b"admission-v1";
const ACK: &[u8] = b"admission-ack-v1";

thread_local! { static QUIET_DROP: Cell<bool> = const { Cell::new(false) }; }

pub(super) fn quiet_drop() -> bool {
    QUIET_DROP.get()
}

fn exit_category(status: ExitStatus) -> &'static str {
    match status.code() {
        Some(0) => "early-clean-exit",
        Some(60) => "unsupported-node",
        Some(61) => "import-failed",
        Some(62) => "stop-listener-failed",
        Some(63) => "fd3-adoption-failed",
        Some(64) => "callback-exchange-failed",
        _ => "other-exit",
    }
}

fn diagnose(directory: &Path) -> Outcome {
    let program = std::env::var("GENTLE_ADMISSION_NODE").map_err(|_| "node-not-configured")?;
    if !cfg!(target_arch = "x86_64") || !Path::new(&program).is_absolute() {
        return Err("node-not-configured");
    }
    ensure_record_directory(directory).map_err(|_| "record-directory-failed")?;
    let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/windows/test/managed-admission-child.mjs");
    let launch = LaunchSpec {
        program,
        args: vec![entry.to_str().ok_or("fixture-path-failed")?.into()],
        envs: vec![
            ("NODE_OPTIONS".into(), String::new()),
            ("NODE_PATH".into(), String::new()),
            ("NODE_REDIRECT_WARNINGS".into(), String::new()),
            ("NODE_V8_COVERAGE".into(), String::new()),
            ("NODE_DISABLE_COMPILE_CACHE".into(), "1".into()),
        ],
    };
    let sink = OpenOptions::new().write(true).open("NUL")
        .map_err(|_| "sink-failed")?;
    let (parent, endpoint) = crate::app_channel::windows::channel_pair().map_err(|_| "channel-failed")?;
    let mut child = match spawn(&launch, sink, &endpoint, directory) {
        Ok(child) => child,
        Err(mut failure) => {
            println!("admission:spawn-failed");
            drop(endpoint);
            let owner = failure.unfinished.as_mut()
                .map_or(Ok(()), |child| child.shutdown_owned(Duration::ZERO));
            let channel = parent.shutdown();
            return Err(if owner.is_ok() && channel.is_ok() { "spawn-failed" } else { "cleanup-failed" });
        }
    };
    drop(endpoint); // No client alias survives in the parent.

    let (tx, rx) = mpsc::sync_channel(1);
    let mut stream = parent.clone();
    let reader = thread::Builder::new().spawn(move || {
        let mut bytes = [0; ACK.len()];
        let result = stream.write_all(CHALLENGE)
            .and_then(|_| stream.read_exact(&mut bytes))
            .map_err(|_| "channel-io-failed")
            .and_then(|_| if bytes.as_slice() == ACK { Ok(()) } else { Err("ack-mismatch") });
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + ADMISSION_LIMIT;
    let phase = if reader.is_err() {
        "reader-start-failed"
    } else { loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = rx.recv_timeout(remaining.min(Duration::from_millis(25)));
        match child.status() {
            Ok(Some(status)) => break exit_category(status),
            Err(_) => break "status-failed",
            Ok(None) => {}
        }
        match result {
            Ok(Ok(())) => break "ack",
            Ok(Err("channel-io-failed")) => {
                // Broken pipe can precede the process signal. Sample only the original handle.
                let settle = deadline.min(Instant::now() + Duration::from_millis(250));
                break loop {
                    match child.status() {
                        Ok(Some(status)) => break exit_category(status),
                        Err(_) => break "status-failed",
                        Ok(None) if Instant::now() >= settle => break "channel-io-failed",
                        Ok(None) => thread::sleep(Duration::from_millis(10)),
                    }
                };
            }
            Ok(Err(error)) => break error,
            Err(mpsc::RecvTimeoutError::Disconnected) => break "reader-disconnected",
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => break "deadline",
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }};
    println!("admission:{phase}"); // Before any cancellation or stop may change the observed phase.

    // On success, the production owner sends the authenticated stop with FD3 still open.
    // On failure, do not wait for JS; the same owner can terminate its exact Job.
    let grace = if phase == "ack" { ADMISSION_LIMIT } else { Duration::ZERO };
    let stopped = child.shutdown_owned(grace).is_ok();
    let channel = parent.shutdown().is_ok(); // Cancel/drain a pending reader or writer.
    let joined = reader.map_or(true, |reader| {
        let deadline = Instant::now() + CLEANUP_WAIT;
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        // Do not wait indefinitely if even OS cancellation and owned Job stop failed.
        reader.is_finished() && reader.join().is_ok()
    });
    if !stopped || !channel || !joined { return Err("cleanup-failed"); }
    if phase != "ack" { return Err(phase); }
    if !child.force_requested
        && child.status().is_ok_and(|status| status.is_some_and(|status| status.success()))
        && child.query().is_ok_and(|active| active == 0)
        && child.record.as_ref().is_some_and(|record| record.deletion_marked)
    { Ok(()) } else { Err("orderly-stop-unconfirmed") }
}

fn scratch() -> Result<PathBuf, &'static str> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "scratch-random-failed")?;
    let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = std::env::temp_dir().join(format!("gentle admission {random}"));
    fs::create_dir(&path).map_err(|_| "scratch-create-failed")?;
    Ok(path)
}

fn retire_scratch(directory: &Path) -> Outcome {
    fn absent(result: io::Result<()>) -> bool {
        result.is_ok() || result.is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
    }
    // Do not remove an unresolved stop record or its witness, or recurse into any directory.
    if !fs::symlink_metadata(directory.join("daemon.pid"))
        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        || !absent(fs::remove_file(directory.join(OWNER_FILE)))
        || fs::remove_dir(directory).is_err()
    { Err("scratch-retained") } else { Ok(()) }
}

#[test]
#[ignore = "explicit native Windows x64 checkout admission with Node 24.14.1 and matching addon"]
fn production_managed_admission() {
    QUIET_DROP.set(true);
    let result = scratch().and_then(|directory| {
        let admission = diagnose(&directory);
        let scratch = if admission == Err("cleanup-failed") { Err("scratch-retained") }
            else { retire_scratch(&directory) };
        println!("admission-scratch:{}", scratch.err().unwrap_or("retired"));
        admission.and(scratch)
    });
    QUIET_DROP.set(false);
    let classification = result.err().unwrap_or("orderly");
    println!("admission-result:{classification}");
    assert!(result.is_ok(), "admission fixture failed: {classification}");
}
