//! Panel-only device metadata and bounded, single-flight speech requests.
//! No playback, persistent selection, audio files, or request-content logging.
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevices {
    supported: bool,
    devices: Vec<InputDevice>,
}

#[cfg(target_os = "windows")]
use super::input_devices::InputDevice;
#[cfg(not(target_os = "windows"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InputDevice {
    id: String,
    label: String,
    is_default: bool,
}

fn discover() -> Result<InputDevices, String> {
    #[cfg(target_os = "windows")]
    return super::input_devices::input_devices()
        .map(|devices| InputDevices { supported: true, devices })
        .map_err(String::from);
    #[cfg(not(target_os = "windows"))]
    Ok(InputDevices { supported: false, devices: Vec::new() })
}

#[tauri::command]
pub async fn voice_input_devices() -> Result<InputDevices, String> {
    tauri::async_runtime::spawn_blocking(discover).await
        .map_err(|_| "Input metadata worker failed".to_string())?
}

// Fail closed instead of evicting cancellation tombstones or allowing ID reuse.
// This session budget bounds both storage and cancel-before-admission traffic.
const MAX_REQUESTS: usize = 1024;
const MAX_ID_BYTES: usize = 128;

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_BYTES
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return Err("Invalid speech request ID".into());
    }
    Ok(())
}

#[derive(Default)]
struct Requests {
    used: HashSet<String>,
    active: Option<(String, Arc<AtomicBool>)>,
}

#[derive(Clone, Default)]
pub struct SynthesisRequests {
    inner: Arc<Mutex<Requests>>,
}

struct Request {
    registry: SynthesisRequests,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl SynthesisRequests {
    fn admit(&self, id: String) -> Result<Request, String> {
        validate_id(&id)?;
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.used.contains(&id) {
            return Err("Speech request ID already used or cancelled".into());
        }
        if state.active.is_some() {
            return Err("Speech synthesis is busy".into());
        }
        if state.used.len() >= MAX_REQUESTS {
            return Err("Speech request session limit reached; restart the app".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.used.insert(id.clone());
        state.active = Some((id.clone(), cancelled.clone()));
        Ok(Request { registry: self.clone(), id, cancelled })
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((active_id, flag)) = &state.active {
            if active_id == id {
                flag.store(true, Ordering::Release);
                return Ok(());
            }
        }
        if state.used.contains(id) {
            return Ok(());
        }
        if state.used.len() >= MAX_REQUESTS {
            return Err("Speech request session limit reached; restart the app".into());
        }
        state.used.insert(id.to_owned());
        Ok(())
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        let mut state = self.registry.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.active.as_ref().is_some_and(|(id, flag)|
            id == &self.id && Arc::ptr_eq(flag, &self.cancelled)) {
            state.active = None;
        }
    }
}

#[tauri::command]
pub async fn voice_synthesize(app: AppHandle, request_id: String, text: String, locale: String) -> Result<Vec<u8>, String> {
    // Admission precedes the first await/dispatch. The lease lives in the closure,
    // not the IPC future: dropping that future must not release a running worker.
    let request = app.state::<SynthesisRequests>().admit(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = request;
        #[cfg(target_os = "windows")]
        let result = super::windows_speech::synthesize_wav(&text, &locale, request.cancelled.clone());
        #[cfg(not(target_os = "windows"))]
        let result = {
            let _ = (&text, &locale);
            Err("Native speech synthesis is unsupported on this platform".to_string())
        };
        // Also reject a cancellation racing with a successful worker return.
        if request.cancelled.load(Ordering::Acquire) {
            return Err("Speech synthesis cancelled".into());
        }
        result
    }).await.map_err(|_| "Speech worker failed".to_string())?
}

#[tauri::command]
pub fn voice_synthesize_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    app.state::<SynthesisRequests>().cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_are_bounded_and_invalid_ids_are_inert() {
        let registry = SynthesisRequests::default();
        for id in ["", "contains space", "a\0b", "é", &"x".repeat(MAX_ID_BYTES + 1)] {
            assert!(registry.admit(id.into()).is_err());
            assert!(registry.cancel(id).is_err());
        }
        assert!(registry.inner.lock().unwrap().used.is_empty());
        assert!(registry.admit("valid_1-2".into()).is_ok());
    }

    #[test]
    fn busy_reuse_and_cancel_before_admission_are_rejected() {
        let registry = SynthesisRequests::default();
        registry.cancel("before").unwrap();
        assert!(registry.admit("before".into()).is_err());
        let first = registry.admit("first".into()).unwrap();
        assert!(registry.admit("first".into()).is_err());
        assert!(registry.admit("second".into()).is_err());
        registry.cancel("first").unwrap();
        assert!(first.cancelled.load(Ordering::Acquire));
        // Cancelling is not completion: a newer worker cannot overlap it.
        assert!(registry.admit("second".into()).is_err());
        drop(first);
        assert!(registry.admit("first".into()).is_err());
        let second = registry.admit("second".into()).unwrap();
        registry.cancel("first").unwrap();
        assert!(!second.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn stale_release_cannot_clear_a_newer_request_and_panic_releases_exact_lease() {
        let registry = SynthesisRequests::default();
        let first = registry.admit("first".into()).unwrap();
        let stale = Request { registry: registry.clone(), id: first.id.clone(), cancelled: first.cancelled.clone() };
        drop(first);
        let second = registry.admit("second".into()).unwrap();
        drop(stale);
        assert!(registry.admit("third".into()).is_err());
        let _ = std::panic::catch_unwind(move || { let _lease = second; panic!("synthetic worker panic"); });
        assert!(registry.admit("third".into()).is_ok());
    }

    #[test]
    fn history_is_bounded_without_forgetting_cancelled_ids() {
        let registry = SynthesisRequests::default();
        for n in 0..MAX_REQUESTS { registry.cancel(&format!("id-{n}")).unwrap(); }
        assert!(registry.cancel("overflow").is_err());
        assert!(registry.admit("overflow".into()).is_err());
        assert!(registry.admit("id-0".into()).is_err());
        assert_eq!(registry.inner.lock().unwrap().used.len(), MAX_REQUESTS);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unsupported_metadata_is_empty_and_inert() {
        let catalog = discover().unwrap();
        assert!(!catalog.supported);
        assert!(catalog.devices.is_empty());
    }
}
