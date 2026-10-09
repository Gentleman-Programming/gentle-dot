//! Native approvals for connector actions (S25.3): the daemon asks the app (over the app-key
//! channel, wired in T23c) and the app shows a native dialog with the action's full preview,
//! outside the agent's reach (L49). Declining, not answering in time, or a dialog that cannot be
//! shown all refuse.
//!
//! The rules are pure and tested here: the dialog text ([`ApprovalDialog`]), one dialog at a
//! time, and the timeout. [`Prompt`] is the seam to the real dialog (`native`); `fake` stands in
//! for it in tests.

#[cfg(test)]
mod fake;
pub mod native;

use crate::alert::Choice;
use serde::Deserialize;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long the user has to answer, waiting for an earlier dialog included.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// The approval buttons; "Decline" is the default (Return).
pub const APPROVAL_CHOICE: Choice = Choice { allow: "Allow", refuse: "Decline" };
/// The most characters of one value shown when the preview is small.
pub const VALUE_LIMIT: usize = 600;
/// The most lines of one value.
pub const LINE_LIMIT: usize = 12;
/// Values share this many characters; each still shows at least [`MIN_VALUE_LIMIT`].
pub const PREVIEW_BUDGET: usize = 4000;
pub const MIN_VALUE_LIMIT: usize = 80;
/// The most characters of a connector, action, or field name.
pub const NAME_LIMIT: usize = 60;

/// One argument of the action, in the order the daemon chose (key fields first).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PreviewField {
    pub name: String,
    pub value: serde_json::Value,
}

/// What the daemon asks the user to approve.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ApprovalRequest {
    /// The connector's display name ("Notion").
    pub connector: String,
    /// What it will do ("create pages").
    pub action: String,
    pub preview: Vec<PreviewField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Declined,
}

/// The text of the native dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDialog {
    /// "Allow Notion to create pages?"
    pub title: String,
    /// The sentence, every field with its (possibly cut) value, and the timeout note.
    pub message: String,
}

impl ApprovalDialog {
    pub fn new(request: &ApprovalRequest, timeout: Duration) -> Self {
        let connector = name(&request.connector);
        let action = name(&request.action);
        let per_value = (PREVIEW_BUDGET / request.preview.len().max(1)).clamp(MIN_VALUE_LIMIT, VALUE_LIMIT);
        let fields: Vec<String> = request
            .preview
            .iter()
            .map(|field| {
                let value = clip(&sanitize(&render(&field.value), false), per_value, LINE_LIMIT);
                // Lines inside one value are indented, so they do not read as fields of their own.
                format!("{}: {}", name(&field.name), value.replace('\n', "\n  "))
            })
            .collect();
        let details = if fields.is_empty() { "(no details)".to_owned() } else { fields.join("\n") };
        ApprovalDialog {
            title: format!("Allow {connector} to {action}?"),
            message: format!(
                "The assistant wants to {action} in {connector}.\n\n{details}\n\n\
If you do not answer within {}, it is declined.",
                spell(timeout)
            ),
        }
    }
}

/// A connector, action, or field name: one line, at most [`NAME_LIMIT`] characters.
fn name(text: &str) -> String {
    clip(&sanitize(text, true), NAME_LIMIT, 1)
}

/// Strings as they are; anything else as indented JSON.
fn render(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

/// "2 minutes", "90 seconds".
fn spell(timeout: Duration) -> String {
    let seconds = timeout.as_secs();
    match seconds {
        60 => "1 minute".into(),
        s if s > 0 && s % 60 == 0 => format!("{} minutes", s / 60),
        1 => "1 second".into(),
        s => format!("{s} seconds"),
    }
}

/// Characters that render as nothing or reorder the text around them.
fn invisible(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// Makes text safe to show: control characters and invisible or direction-changing characters
/// (which could disguise what is shown) become `\u{…}` escapes; `\r\n` becomes `\n`. With
/// `one_line`, newlines and tabs become spaces.
pub fn sanitize(text: &str, one_line: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.replace("\r\n", "\n").chars() {
        match c {
            '\n' | '\t' if one_line => out.push(' '),
            '\n' | '\t' => out.push(c),
            c if c.is_control() || invisible(c) => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Keeps at most `max_chars` characters and `max_lines` lines; when anything is cut, ends with
/// "… (N more characters)".
pub fn clip(text: &str, max_chars: usize, max_lines: usize) -> String {
    let total = text.chars().count();
    let (mut kept, mut count, mut lines) = (String::new(), 0, 1);
    for c in text.chars() {
        if count == max_chars || (c == '\n' && lines >= max_lines) {
            break;
        }
        lines += usize::from(c == '\n');
        kept.push(c);
        count += 1;
    }
    if count == total {
        kept
    } else {
        format!("{kept}… ({} more characters)", total - count)
    }
}

/// The real dialog, or a fake in tests.
pub trait Prompt: Send + Sync {
    /// Shows the dialog and blocks until the user answers; true only for the allowing button.
    fn ask(&self, dialog: &ApprovalDialog) -> bool;
    /// Closes the dialog still on screen after the timeout (best effort). Its answer, if any,
    /// is ignored.
    fn dismiss(&self);
}

/// Shows one approval dialog at a time and declines when the user does not answer in time.
pub struct Approvals {
    prompt: Arc<dyn Prompt>,
    timeout: Duration,
    gate: Arc<Gate>,
}

impl Approvals {
    pub fn new(prompt: Arc<dyn Prompt>, timeout: Duration) -> Self {
        Approvals { prompt, timeout, gate: Arc::new(Gate::default()) }
    }

    /// Asks the user. Blocks until the answer or the timeout, so call it off the main thread.
    pub fn confirm(&self, request: &ApprovalRequest) -> Decision {
        let deadline = Instant::now() + self.timeout;
        let dialog = ApprovalDialog::new(request, self.timeout);
        let Some(ticket) = self.gate.acquire(deadline) else {
            return Decision::Declined;
        };
        // The dialog runs on a thread of its own that holds the screen until the dialog closes,
        // so a stale dialog left after the timeout still keeps the next one waiting.
        let (answer, answered) = mpsc::channel();
        let (prompt, gate) = (self.prompt.clone(), self.gate.clone());
        let spawned = std::thread::Builder::new().name("approval-dialog".into()).spawn(move || {
            let _screen = Ticket { gate, ticket };
            let _ = answer.send(prompt.ask(&dialog));
        });
        if spawned.is_err() {
            self.gate.release(ticket);
            return Decision::Declined;
        }
        match answered.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(true) => Decision::Approved,
            // Declined, or the dialog failed (its thread panicked).
            Ok(false) | Err(RecvTimeoutError::Disconnected) => Decision::Declined,
            Err(RecvTimeoutError::Timeout) => {
                self.gate.while_held(ticket, || self.prompt.dismiss());
                Decision::Declined
            }
        }
    }
}

/// Who holds the screen: at most one dialog, identified by a ticket.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    freed: Condvar,
}

#[derive(Default)]
struct GateState {
    holder: Option<u64>,
    next: u64,
}

impl Gate {
    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits for the screen until the deadline.
    fn acquire(&self, deadline: Instant) -> Option<u64> {
        let mut state = self.lock();
        while state.holder.is_some() {
            let left = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero())?;
            state = self.freed.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
        }
        state.next += 1;
        state.holder = Some(state.next);
        Some(state.next)
    }

    fn release(&self, ticket: u64) {
        let mut state = self.lock();
        if state.holder == Some(ticket) {
            state.holder = None;
            self.freed.notify_all();
        }
    }

    /// Runs `f` only while `ticket` still holds the screen, so it cannot touch a later dialog.
    fn while_held(&self, ticket: u64, f: impl FnOnce()) {
        let state = self.lock();
        if state.holder == Some(ticket) {
            f();
        }
    }
}

/// Frees the screen when the dialog's thread ends, panics included.
struct Ticket {
    gate: Arc<Gate>,
    ticket: u64,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.gate.release(self.ticket);
    }
}

#[cfg(test)]
mod tests;
