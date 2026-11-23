//! Compile-time-only staged QA projection. No process identifiers or raw errors cross this wire.
use std::net::{Ipv4Addr, UdpSocket};

const PORT: u16 = 43193;
const SELECTORS: [&str; 2] = ["GENTLE_DOT_CI_OWNER_ID", "GENTLE_DOT_CI_OWNER_PORT"];

pub(super) fn is_selector(key: &str) -> bool {
    SELECTORS.iter().any(|selector| key.eq_ignore_ascii_case(selector))
}

#[derive(Clone, Copy)]
pub(super) enum Event {
    Begin,
    PrepareFailed,
    CreateFailed,
    AssignFailed,
    VerifyFailed,
    RecordFailed,
    PublishFailed,
    ResumeFailed,
    Resumed,
    ExitZero,
    ExitNonzero,
    StatusFailed,
}

impl Event {
    fn wire(self) -> &'static str {
        match self {
            Self::Begin => "begin",
            Self::PrepareFailed => "prepare-failed",
            Self::CreateFailed => "create-failed",
            Self::AssignFailed => "assign-failed",
            Self::VerifyFailed => "verify-failed",
            Self::RecordFailed => "record-failed",
            Self::PublishFailed => "publish-failed",
            Self::ResumeFailed => "resume-failed",
            Self::Resumed => "resumed",
            Self::ExitZero => "exit-zero",
            Self::ExitNonzero => "exit-nonzero",
            Self::StatusFailed => "status-failed",
        }
    }
}

pub(super) struct Trace {
    socket: UdpSocket,
    id: String,
    pub(super) preparation_failure: Option<Event>,
    status_sent: bool,
}

impl Trace {
    pub(super) fn open() -> Option<Self> {
        let id = std::env::var(SELECTORS[0]).ok()?;
        let port = std::env::var(SELECTORS[1]).ok()?;
        if !valid_id(&id) || port != "43193" { return None; }
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
        socket.set_nonblocking(true).ok()?;
        Some(Self { socket, id, preparation_failure: Some(Event::PrepareFailed), status_sent: false })
    }

    pub(super) fn launch(&self, event: Event) {
        // The caller has already determined the launch result (including capturing OS errors).
        self.emit(Event::Begin);
        self.emit(event);
    }

    fn emit(&self, event: Event) {
        let mut frame = [0_u8; 64];
        let phase = event.wire().as_bytes();
        frame[..32].copy_from_slice(self.id.as_bytes());
        frame[32] = b' ';
        frame[33..33 + phase.len()].copy_from_slice(phase);
        let _ = self.socket.send_to(&frame[..33 + phase.len()], (Ipv4Addr::LOCALHOST, PORT));
    }

    pub(super) fn status(&mut self, result: &std::io::Result<Option<std::process::ExitStatus>>) {
        if self.status_sent { return; }
        let event = match result {
            Ok(None) => return,
            Ok(Some(status)) if status.success() => Event::ExitZero,
            Ok(Some(_)) => Event::ExitNonzero,
            Err(_) => Event::StatusFailed,
        };
        self.status_sent = true;
        self.emit(event);
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        if let Some(event) = self.preparation_failure { self.launch(event); }
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_are_exact_and_windows_case_insensitive() {
        assert!(is_selector("gentle_dot_ci_owner_id"));
        assert!(is_selector("GENTLE_DOT_CI_OWNER_PORT"));
        assert!(!is_selector("GENTLE_DOT_CI_OWNER_PORT_EXTRA"));
        assert!(valid_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_id("0123456789ABCDEF0123456789abcdef"));
        assert!(!valid_id("0123456789abcdef0123456789abcdef\n"));
    }
}
