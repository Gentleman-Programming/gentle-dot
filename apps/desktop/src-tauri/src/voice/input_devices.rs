//! Metadata-only input discovery. COM interfaces never leave their owning worker.

use super::VoiceError;
use serde::Serialize;
use std::marker::PhantomData;
use std::rc::Rc;
use ::windows::core::{Error, PWSTR};
use ::windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use ::windows::Win32::Media::Audio::{
    eCapture, eConsole, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use ::windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};
use ::windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc,
};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const MAX_DEVICES: u32 = 256;
const MAX_ID_UNITS: usize = 4096;
const MAX_LABEL_UNITS: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

fn invalid(message: &str) -> VoiceError {
    VoiceError::Failed(format!("Windows microphone: {message}"))
}

// Never include native error descriptions or endpoint IDs in diagnostics.
fn failed(stage: &str, error: Error) -> VoiceError {
    invalid(&format!("{stage} failed (0x{:08X}).", error.code().0 as u32))
}

/// Validate before cloning or spawning; IDs are opaque, not paths or display labels.
pub(crate) fn validate_input_id(id: &str) -> Result<(), VoiceError> {
    if id.is_empty() || id.contains('\0') || id.encode_utf16().take(MAX_ID_UNITS + 1).count() > MAX_ID_UNITS {
        return Err(invalid("the selected input ID is invalid or exceeds its size limit."));
    }
    Ok(())
}

struct Apartment(PhantomData<Rc<()>>);

impl Apartment {
    fn enter() -> Result<Self, VoiceError> {
        // SAFETY: only entered on the newly created metadata thread.
        let result = unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32) };
        if result < 0 {
            return Err(invalid(&format!("device metadata COM initialization failed (0x{:08X}).", result as u32)));
        }
        Ok(Self(PhantomData))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: non-Send guard balances successful initialization on this thread.
        unsafe { CoUninitialize() };
    }
}

/// Own each successful GetId/PropVariantToStringAlloc allocation immediately.
struct TaskString(PWSTR);

impl Drop for TaskString {
    fn drop(&mut self) {
        // SAFETY: these APIs transfer a task allocation, freed exactly once here.
        unsafe { CoTaskMemFree(Some(self.0.0.cast())) };
    }
}

impl TaskString {
    fn copy(&self, limit: usize) -> Result<String, VoiceError> {
        if self.0.0.is_null() {
            return Err(invalid("device metadata returned a null string."));
        }
        // SAFETY: a successful COM string result is NUL-terminated and readable through
        // that terminator. Stop there, and cap scanning/copying even for oversized metadata.
        for len in 0..=limit {
            if unsafe { *self.0.0.add(len) } == 0 {
                let units = unsafe { std::slice::from_raw_parts(self.0.0, len) };
                return String::from_utf16(units)
                    .map_err(|_| invalid("device metadata contains invalid UTF-16."));
            }
        }
        Err(invalid("device metadata exceeds its size limit."))
    }
}

fn endpoint_id(device: &IMMDevice) -> Result<String, VoiceError> {
    let allocation = TaskString(unsafe { device.GetId() }
        .map_err(|e| failed("reading an input ID", e))?);
    let id = allocation.copy(MAX_ID_UNITS)?;
    validate_input_id(&id)?;
    Ok(id)
}

fn endpoint_label(device: &IMMDevice) -> Result<String, VoiceError> {
    let store = unsafe { device.OpenPropertyStore(STGM_READ) }
        .map_err(|e| failed("opening input metadata", e))?;
    let mut value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }
        .map_err(|e| failed("reading an input label", e))?;
    // Wrap the allocation before clearing the variant, including the clear-error path.
    // Clear also runs when conversion fails, not just when copying succeeds.
    let allocation = unsafe { PropVariantToStringAlloc(&value) }.map(TaskString);
    let cleared = unsafe { PropVariantClear(&mut value) };
    let allocation = allocation.map_err(|e| failed("converting an input label", e))?;
    cleared.map_err(|e| failed("clearing input metadata", e))?;
    let label = allocation.copy(MAX_LABEL_UNITS)?;
    if label.is_empty() {
        return Err(invalid("device metadata returned an empty label."));
    }
    Ok(label)
}

fn active_inputs(enumerator: &IMMDeviceEnumerator) -> Result<(IMMDeviceCollection, u32), VoiceError> {
    let devices = unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) }
        .map_err(|e| failed("enumerating active inputs", e))?;
    let count = bounded_count(unsafe { devices.GetCount() }
        .map_err(|e| failed("counting active inputs", e))?)?;
    Ok((devices, count))
}

fn bounded_count(count: u32) -> Result<u32, VoiceError> {
    if count > MAX_DEVICES {
        return Err(invalid("the active input count exceeds its limit."));
    }
    Ok(count)
}

/// This seam makes fallback policy testable without COM or microphone activation.
fn choose_input<T>(
    selection: Option<&str>,
    default: impl FnOnce() -> Result<T, VoiceError>,
    selected: impl FnOnce(&str) -> Result<Option<T>, VoiceError>,
) -> Result<T, VoiceError> {
    match selection {
        None => default(),
        Some(id) => {
            validate_input_id(id)?;
            selected(id)?.ok_or_else(|| invalid("the selected input is unavailable or disconnected."))
        }
    }
}

/// Caller must already own a COM apartment. Only active capture endpoints can match an
/// explicit selection; never resolve arbitrary render endpoints with GetDevice or fallback.
pub(crate) fn resolve_input(enumerator: &IMMDeviceEnumerator, selection: Option<&str>) -> Result<IMMDevice, VoiceError> {
    choose_input(selection, || {
        unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }
            .map_err(|e| failed("selecting the default input", e))
    }, |id| {
        let (devices, count) = active_inputs(enumerator)?;
        for index in 0..count {
            let device = unsafe { devices.Item(index) }
                .map_err(|e| failed("reading an active input", e))?;
            if endpoint_id(&device)? == id {
                return Ok(Some(device));
            }
        }
        Ok(None)
    })
}

/// Metadata only: no Activate, audio client, Start, files, or persistent selection.
pub fn input_devices() -> Result<Vec<InputDevice>, VoiceError> {
    std::thread::Builder::new().name("voice-input-metadata".into()).spawn(|| {
        let _apartment = Apartment::enter()?;
        // Locals below this guard drop before CoUninitialize, including error paths.
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| failed("creating the input enumerator", e))?;
        let (devices, count) = active_inputs(&enumerator)?;
        // No default is a valid state. Do not invent a default among active endpoints.
        let default = match unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) } {
            Ok(device) => Some(endpoint_id(&device)?),
            Err(_) => None,
        };
        let mut result = Vec::with_capacity(count as usize);
        for index in 0..count {
            let device = unsafe { devices.Item(index) }
                .map_err(|e| failed("reading an active input", e))?;
            let id = endpoint_id(&device)?;
            let label = endpoint_label(&device)?;
            let is_default = default.as_deref() == Some(id.as_str());
            result.push(InputDevice { id, label, is_default });
        }
        Ok(result)
    }).map_err(|_| invalid("could not start the input metadata worker."))?
        .join().map_err(|_| invalid("the input metadata worker stopped unexpectedly."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn default_is_only_resolved_for_none() {
        assert_eq!(choose_input(None, || Ok(17), |_| panic!("selected resolver called")).unwrap(), 17);
        assert_eq!(choose_input(Some("opaque"), || panic!("default fallback"), |id| {
            assert_eq!(id, "opaque");
            Ok(Some(23))
        }).unwrap(), 23);
    }

    #[test]
    fn disconnected_and_resolver_failure_never_fall_back() {
        for failure in [false, true] {
            let result: Result<(), _> = choose_input(Some("private-device"), || panic!("default fallback"), |_| {
                if failure { Err(invalid("enumeration failed.")) } else { Ok(None) }
            });
            let error = format!("{}", result.unwrap_err());
            assert!(!error.contains("private-device"));
        }
    }

    #[test]
    fn invalid_ids_are_rejected_before_resolving() {
        for id in [String::new(), "private\0device".into(), "x".repeat(MAX_ID_UNITS + 1), "😀".repeat(MAX_ID_UNITS / 2 + 1)] {
            let called = Cell::new(false);
            let result = choose_input(Some(&id), || panic!("default fallback"), |_| {
                called.set(true);
                Ok(Some(()))
            });
            assert!(result.is_err());
            assert!(!called.get());
        }
        assert!(validate_input_id(&"x".repeat(MAX_ID_UNITS)).is_ok());
        assert!(validate_input_id("  opaque ID  ").is_ok());
    }

    #[test]
    fn counts_are_bounded_without_silent_truncation() {
        assert_eq!(bounded_count(0).unwrap(), 0);
        assert_eq!(bounded_count(MAX_DEVICES).unwrap(), MAX_DEVICES);
        assert!(bounded_count(MAX_DEVICES + 1).is_err());
    }

    #[test]
    fn metadata_serializes_owned_values_without_borrowed_com_memory() {
        let mut id = String::from("opaque");
        let mut label = String::from("Microphone");
        let device = InputDevice { id: id.clone(), label: label.clone(), is_default: true };
        id.clear();
        label.clear();
        assert_eq!(serde_json::to_value(device).unwrap(), serde_json::json!({
            "id": "opaque", "label": "Microphone", "isDefault": true
        }));
    }

    #[test]
    fn bounded_string_copy_is_owned_and_rejects_invalid_metadata() {
        // Borrowed buffers are used only to exercise copying, never TaskString::drop:
        // production TaskString owns CoTaskMem, whereas these buffers belong to Vec.
        fn copy(units: &mut [u16], limit: usize) -> Result<String, VoiceError> {
            let allocation = std::mem::ManuallyDrop::new(TaskString(PWSTR(units.as_mut_ptr())));
            allocation.copy(limit)
        }
        let mut units = vec![65, 66, 0];
        let owned = copy(&mut units, 2).unwrap();
        units[0] = 67;
        assert_eq!(owned, "AB");
        assert!(copy(&mut units, 1).is_err());
        assert!(copy(&mut [0xd800, 0], 1).is_err());
        let null = std::mem::ManuallyDrop::new(TaskString(PWSTR(std::ptr::null_mut())));
        assert!(null.copy(1).is_err());
    }
}
