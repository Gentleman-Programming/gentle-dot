//! Panel-only spoken output: bounded single-flight admission and worker-owned leases.
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

const MAX_REQUESTS: usize = 1024;
const SESSION_LIMIT: &str = "Speech request session limit reached; restart the app";

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid speech request ID".into());
    }
    Ok(())
}

// Registry and worker lease. No microphone, OS discovery, or renderer runs under this mutex.
#[derive(Default)]
struct Requests {
    used: HashSet<String>,
    active: Option<(String, Arc<AtomicBool>)>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SynthesisStatus {
    pub supported: bool,
}

#[derive(Clone)]
pub struct SpeechSynthesis {
    supported: bool,
    inner: Arc<Mutex<Requests>>,
}

impl Default for SpeechSynthesis {
    fn default() -> Self {
        Self { supported: cfg!(windows), inner: Arc::default() }
    }
}

/// Synchronous admission produces a lease to move into spawn_blocking before any await.
/// It survives dropping the IPC future, until render returns or unwinds.
pub struct SpeechJob {
    registry: SpeechSynthesis,
    id: String,
    text: String,
    locale: String,
    cancelled: Arc<AtomicBool>,
}

impl SpeechSynthesis {
    pub fn status(&self) -> SynthesisStatus {
        SynthesisStatus { supported: self.supported }
    }

    pub fn prepare(&self, id: &str, text: &str, locale: &str) -> Result<SpeechJob, String> {
        if !self.supported {
            return Err("Native speech synthesis is unsupported on this platform".into());
        }
        validate_id(id)?;
        super::speech_wave::check_request(text, locale)?;
        let mut state = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.used.contains(id) {
            return Err("Speech request ID already used or cancelled".into());
        }
        if state.active.is_some() {
            return Err("Speech synthesis is busy".into());
        }
        if state.used.len() >= MAX_REQUESTS {
            return Err(SESSION_LIMIT.into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.used.insert(id.into());
        state.active = Some((id.into(), cancelled.clone()));
        Ok(SpeechJob {
            registry: self.clone(),
            id: id.into(),
            text: text.into(),
            locale: locale.into(),
            cancelled,
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut state = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((active_id, flag)) = &state.active {
            if active_id == id {
                flag.store(true, Ordering::Release);
                return Ok(()); // The worker, not cancellation, releases its lease.
            }
        }
        if state.used.contains(id) {
            return Ok(());
        }
        if state.used.len() >= MAX_REQUESTS {
            return Err(SESSION_LIMIT.into());
        }
        state.used.insert(id.into()); // Retain cancel-before-admission tombstones; never evict.
        Ok(())
    }
}

impl SpeechJob {
    pub fn render(self, renderer: impl FnOnce(&str, &str, Arc<AtomicBool>) -> Result<Vec<u8>, String>) -> Result<Vec<u8>, String> {
        // Preserve renderer/purge errors even when cancellation raced with failure.
        let wav = renderer(&self.text, &self.locale, self.cancelled.clone())?;
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Speech synthesis cancelled".into());
        }
        Ok(wav)
    }
}

impl Drop for SpeechJob {
    fn drop(&mut self) {
        let mut state = self.registry.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active.as_ref().is_some_and(|(id, flag)|
            id == &self.id && Arc::ptr_eq(flag, &self.cancelled))
        {
            state.active = None;
        }
    }
}

// IPC entrypoints. Capability grants additionally restrict these to the local panel.
// The label always comes from Tauri's invoking WebviewWindow, never request arguments.
pub fn require_panel(window_label: &str) -> Result<(), String> {
    if window_label != crate::shell::PANEL {
        return Err("Speech synthesis commands are restricted to the panel".into());
    }
    Ok(())
}

/// Compiled Windows support only; does not probe microphones or installed voices.
#[tauri::command]
pub fn voice_synthesis_status(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechSynthesis>,
) -> Result<SynthesisStatus, String> {
    require_panel(webview.label())?;
    Ok(state.status())
}

/// Returns WAV bytes without native playback; admission precedes the first await.
#[tauri::command(rename_all = "camelCase")]
pub async fn voice_synthesize(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechSynthesis>,
    request_id: String,
    text: String,
    locale: String,
) -> Result<Vec<u8>, String> {
    require_panel(webview.label())?;
    let job = state.prepare(&request_id, &text, &locale)?;
    tauri::async_runtime::spawn_blocking(move || job.render(|text, locale, cancelled| {
        #[cfg(windows)]
        return super::windows_speech::synthesize_wav(text, locale, cancelled);
        #[cfg(not(windows))]
        {
            let _ = (text, locale, cancelled);
            Err("Native speech synthesis is unsupported on this platform".into())
        }
    })).await.map_err(|_| "Speech worker failed".to_string())?
}

/// Marks this ID only; a running worker keeps the exclusive slot until it exits.
#[tauri::command(rename_all = "camelCase")]
pub fn voice_synthesize_cancel(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechSynthesis>,
    request_id: String,
) -> Result<(), String> {
    require_panel(webview.label())?;
    state.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{atomic::Ordering, mpsc};
    use std::thread;

    // Test-only support injection renders fakes on every host; no OS voice/mic probe.
    fn service() -> SpeechSynthesis {
        SpeechSynthesis { supported: true, ..Default::default() }
    }

    fn prepare(service: &SpeechSynthesis, id: &str) -> Result<SpeechJob, String> {
        service.prepare(id, "Hello", "en-US")
    }

    fn wav() -> Vec<u8> {
        super::super::speech_wave::Pcm {
            channels: 1, rate: 8_000, bits: 16, align: 2, byte_rate: 16_000,
        }.wav(&[0, 0]).unwrap()
    }

    fn complete(job: SpeechJob) {
        assert_eq!(job.render(|_, _, _| Ok(wav())), Ok(wav()));
    }

    // Prove history consumption through public operations, never private set sizes.
    fn remaining_budget(service: &SpeechSynthesis, already_used: usize) {
        for n in already_used..1024 {
            service.cancel(&format!("budget-{n}")).expect("unused history capacity");
        }
        for _ in 0..2 {
            let error = service.cancel("overflow").expect_err("history must be bounded");
            assert!(error.contains("restart"), "actionable session limit: {error}");
            assert!(prepare(service, "overflow").is_err());
        }
        service.cancel("budget-1023").expect("known IDs stay idempotent at capacity");
    }

    #[test]
    fn status_is_compiled_support_only_and_has_exact_ipc_shape() {
        assert_eq!(serde_json::to_value(SpeechSynthesis::default().status()).unwrap(),
            serde_json::json!({"supported": cfg!(windows)}));
        assert!(service().status().supported, "fake support must not need microphone discovery");
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_explicitly_rejects_synthesis() {
        let service = SpeechSynthesis::default();
        let error = prepare(&service, "unsupported").err().expect("no native worker on this host");
        assert!(error.to_lowercase().contains("unsupported"));
    }

    #[test]
    fn only_the_trusted_panel_label_is_allowed() {
        assert!(require_panel(crate::shell::PANEL).is_ok());
        for label in ["", "dot", "glow", "other", "panel-other", "Panel"] {
            assert!(require_panel(label).is_err(), "must deny {label:?}");
        }
    }

    #[test]
    fn fake_renderer_receives_literal_text_locale_and_returns_wav() {
        let service = service();
        let job = service.prepare("literal", "<speak>Hello</speak>", "es-AR").unwrap();
        assert_eq!(job.render(|text, locale, cancelled| {
            assert_eq!((text, locale), ("<speak>Hello</speak>", "es-AR"));
            assert!(!cancelled.load(Ordering::Acquire));
            Ok(wav())
        }), Ok(wav()));
    }

    #[test]
    fn invalid_ids_are_inert_for_admission_cancellation_and_history() {
        let service = service();
        for id in ["", "space here", "a\0b", "é", "slash/id", "dot.id", &"x".repeat(129)] {
            assert!(prepare(&service, id).is_err(), "admission: {id:?}");
            assert!(service.cancel(id).is_err(), "cancel: {id:?}");
        }
        complete(prepare(&service, "valid").unwrap());
        remaining_budget(&service, 1);
    }

    #[test]
    fn id_boundaries_are_accepted_once_and_never_reused() {
        let service = service();
        for id in ["a".to_string(), format!("A0-_{}", "x".repeat(124))] {
            complete(prepare(&service, &id).expect("1..128 ASCII alnum/-/_"));
            assert!(prepare(&service, &id).is_err(), "completed IDs cannot be reused");
            service.cancel(&id).unwrap();
        }
        remaining_budget(&service, 2);
    }

    #[test]
    fn invalid_text_and_locale_do_not_claim_id_slot_or_history() {
        let service = service();
        for (text, locale) in [
            ("", "en-US"), (" \n", "en-US"), ("a\0b", "en-US"),
            (&"x".repeat(4001), "en-US"), (&"😀".repeat(2001), "en-US"),
            ("Hello", ""), ("Hello", "en\0US"), ("Hello", &"x".repeat(86)),
        ] {
            assert!(service.prepare("retry", text, locale).is_err());
        }
        complete(prepare(&service, "retry").expect("invalid attempts must not consume the ID"));
        remaining_budget(&service, 1);
    }

    #[test]
    fn valid_text_and_locale_bounds_reach_renderer() {
        let service = service();
        complete(service.prepare("bounds", &"😀".repeat(2000), &"x".repeat(85)).unwrap());
    }

    #[test]
    fn cancel_before_admission_is_an_idempotent_tombstone() {
        let service = service();
        service.cancel("early").unwrap();
        service.cancel("early").unwrap();
        assert!(prepare(&service, "early").is_err());
        complete(prepare(&service, "next").unwrap());
        remaining_budget(&service, 2);
    }

    #[test]
    fn admission_is_exclusive_before_dispatch_and_busy_rejection_is_inert() {
        let service = service();
        let first = prepare(&service, "first").unwrap();
        assert!(prepare(&service, "retry").is_err(), "no worker dispatch needed to reserve slot");
        drop(first);
        complete(prepare(&service, "retry").expect("busy rejection did not consume ID"));
        assert!(prepare(&service, "first").is_err(), "abandoned admission still consumes ID");
        remaining_budget(&service, 2);
    }

    #[test]
    fn worker_owns_lease_after_waiter_drop_and_cancel_until_it_returns() {
        let service = service();
        let job = prepare(&service, "worker").unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = job.render(|_, _, flag| {
                started_tx.send(flag).unwrap();
                release_rx.recv().unwrap();
                Ok(wav())
            });
            let _ = result_tx.send(result.clone());
            result
        });
        let flag = started_rx.recv().unwrap();
        drop(result_rx); // Models an IPC future no longer waiting for the blocking worker.
        let busy_before_cancel = prepare(&service, "next").is_err();
        let cancelled = service.cancel("worker");
        let marked = flag.load(Ordering::Acquire);
        let busy_after_cancel = prepare(&service, "next").is_err();
        release_tx.send(()).unwrap();
        let result = worker.join().unwrap();
        // Assertions follow the handshake so a failing assertion cannot strand a worker.
        assert!(busy_before_cancel, "dropping the waiter must not free the worker's lease");
        assert!(cancelled.is_ok() && marked);
        assert!(busy_after_cancel, "cancellation is not worker termination");
        assert!(result.unwrap_err().to_lowercase().contains("cancel"), "discard late successful WAV");
        complete(prepare(&service, "next").unwrap());
    }

    #[test]
    fn cancellation_marks_only_its_id_and_discards_a_late_success() {
        let service = service();
        let job = prepare(&service, "current").unwrap();
        service.cancel("unrelated").unwrap();
        let result = job.render(|_, _, flag| {
            assert!(!flag.load(Ordering::Acquire), "unrelated cancellation is isolated");
            service.cancel("current").unwrap();
            assert!(flag.load(Ordering::Acquire), "active worker must see cancellation");
            Ok(wav())
        });
        assert!(result.unwrap_err().to_lowercase().contains("cancel"));
        complete(prepare(&service, "next").unwrap());
    }

    #[test]
    fn stale_cancel_never_marks_or_releases_a_newer_job() {
        let service = service();
        complete(prepare(&service, "old").unwrap());
        let current = prepare(&service, "new").unwrap();
        service.cancel("old").unwrap();
        assert!(prepare(&service, "third").is_err());
        assert_eq!(current.render(|_, _, flag| {
            assert!(!flag.load(Ordering::Acquire));
            Ok(wav())
        }), Ok(wav()));
        complete(prepare(&service, "third").unwrap());
    }

    #[test]
    fn renderer_error_releases_slot_but_not_id_history() {
        let service = service();
        let job = prepare(&service, "failed").unwrap();
        assert_eq!(job.render(|_, _, _| Err("renderer failed".into())), Err("renderer failed".into()));
        assert!(prepare(&service, "failed").is_err());
        complete(prepare(&service, "next").unwrap());
    }

    #[test]
    fn renderer_error_is_not_masked_by_concurrent_cancellation() {
        let service = service();
        let job = prepare(&service, "purge-failed").unwrap();
        let result = job.render(|_, _, _| {
            service.cancel("purge-failed").unwrap();
            Err("Windows speech purge failed (HRESULT fixture)".into())
        });
        assert_eq!(result, Err("Windows speech purge failed (HRESULT fixture)".into()));
        complete(prepare(&service, "next").unwrap());
    }

    #[test]
    fn renderer_unwind_releases_slot_but_not_id_history() {
        let service = service();
        let job = prepare(&service, "panic").unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| job.render(|_, _, _| panic!("fake renderer")))).is_err());
        assert!(prepare(&service, "panic").is_err());
        complete(prepare(&service, "next").unwrap());
    }

    #[test]
    fn history_capacity_applies_to_completed_work_and_unseen_cancels() {
        let service = service();
        for n in 0..512 {
            complete(prepare(&service, &format!("done-{n}")).unwrap());
        }
        remaining_budget(&service, 512);
        service.cancel("done-0").unwrap();
        assert!(prepare(&service, "done-0").is_err());
    }
}
