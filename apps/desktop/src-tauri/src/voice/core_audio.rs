//! The CoreAudio door the macOS microphone uses: which input devices exist, which one is the
//! system default, and how the input node's audio unit is pointed at one of them (S1-S4).
//!
//! The declarations are hand-written because the bindings this crate depends on stop at the
//! Objective-C layer ("AVAudioEngine` and friends); CoreAudio and AudioToolbox are plain C, and
//! these two `#[link]` blocks are what pulls them in. Device identity is the UID, never the name
//! (S4): the name is looked up for display and may change between runs, the UID may not.

use objc2_core_foundation::{CFRetained, CFString};
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null, NonNull};

/// An audio unit (`AudioComponentInstance`) as `AVAudioIONode::audioUnit` hands it out: opaque
/// here, only ever passed back to AudioToolbox.
pub type AudioUnit = *mut c_void;

/// A CoreAudio object identifier: valid for this boot and this process's connection only.
type ObjectId = u32;

/// The `CFStringRef` CoreAudio puts in (and takes from) a property.
type CFStringRef = *const CFString;

/// `AudioObjectPropertyAddress`.
#[repr(C)]
struct Address {
    selector: ObjectId,
    scope: ObjectId,
    element: ObjectId,
}

/// `kAudioObjectSystemObject`: the object the device list and the default input hang off.
const SYSTEM_OBJECT: ObjectId = 1;
const SCOPE_GLOBAL: ObjectId = fourcc(*b"glob");
const SCOPE_INPUT: ObjectId = fourcc(*b"inpt");
const ELEMENT_MAIN: ObjectId = 0;
const HARDWARE_DEVICES: ObjectId = fourcc(*b"dev#");
const DEFAULT_INPUT: ObjectId = fourcc(*b"dIn ");
const DEVICE_UID: ObjectId = fourcc(*b"uid ");
const DEVICE_STREAMS: ObjectId = fourcc(*b"stm#");
const OBJECT_NAME: ObjectId = fourcc(*b"lnam");
/// `kAudioOutputUnitProperty_CurrentDevice` (`AudioUnitProperties.h`).
const CURRENT_DEVICE: ObjectId = 2_000;
/// `kAudioUnitScope_Global`.
const UNIT_SCOPE_GLOBAL: ObjectId = 0;

/// Four characters as the `u32` CoreAudio selectors are.
const fn fourcc(code: [u8; 4]) -> ObjectId {
    u32::from_be_bytes(code)
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn AudioObjectGetPropertyData(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

#[link(name = "AudioToolbox", kind = "framework")]
extern "C" {
    fn AudioUnitSetProperty(
        unit: AudioUnit,
        property: ObjectId,
        scope: ObjectId,
        element: ObjectId,
        data: *const c_void,
        size: u32,
    ) -> i32;
    fn AudioUnitGetProperty(
        unit: AudioUnit,
        property: ObjectId,
        scope: ObjectId,
        element: ObjectId,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
}

/// An input the user may record from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    /// The CoreAudio UID: the identity that survives a rename (S4).
    pub uid: String,
    /// What the device calls itself, for the panel.
    pub name: String,
}

/// Every device with at least one input stream, with its UID and its name, in the order the
/// system lists them (the panel shows them as the Mac does). An empty Mac answers an empty list.
pub fn inputs() -> Vec<InputDevice> {
    input_devices().into_iter().map(|(_, device)| device).collect()
}

/// The UID of the system default input, which is what CoreAudio switches between when a headset
/// comes and goes.
pub fn default_input_uid() -> Option<String> {
    let address = Address { selector: DEFAULT_INPUT, scope: SCOPE_GLOBAL, element: ELEMENT_MAIN };
    let mut device: ObjectId = 0;
    let mut size = size_of::<ObjectId>() as u32;
    // SAFETY: the address is a valid property of the system object, and the buffer is one
    // `ObjectId`, which is what that property holds.
    let status = unsafe {
        AudioObjectGetPropertyData(SYSTEM_OBJECT, &address, 0, null(), &mut size, (&mut device as *mut ObjectId).cast())
    };
    if status != 0 || device == 0 {
        return None;
    }
    string_property(device, DEVICE_UID)
}

/// Points `unit`'s input at the device with this UID, before the engine is prepared: the format
/// the engine reports afterwards is the one this device carries.
pub fn select_input(unit: AudioUnit, uid: &str) -> Result<(), String> {
    // Same rule for the unit itself: nothing is passed to CoreAudio that is not there.
    if unit.is_null() {
        return Err("the input node has no audio unit".to_string());
    }
    // The device may have gone between the panel's choice and the recording (S3): a vanished
    // device is an `Err`, never a panic.
    let known = input_devices();
    let Some((id, device)) = device_id(&known, uid) else {
        return Err(format!("the microphone \"{uid}\" is not connected"));
    };
    let size = size_of::<ObjectId>() as u32;
    // SAFETY: `kAudioOutputUnitProperty_CurrentDevice` takes an `AudioDeviceID` (a `UInt32`, the
    // id the enumeration read), never a `CFStringRef`: `&id` points at that one id, which lives
    // in this frame for the duration of the call.
    let status = unsafe {
        AudioUnitSetProperty(unit, CURRENT_DEVICE, UNIT_SCOPE_GLOBAL, ELEMENT_MAIN, (&id as *const ObjectId).cast(), size)
    };
    if status != 0 {
        return Err(format!("the microphone \"{}\" could not be selected (OSStatus {status})", device.name));
    }
    Ok(())
}

/// The device `unit` is really using, read back from it: what the log reports (S6) and what the
/// hot-change message names (S5).
pub fn opened_input(unit: AudioUnit) -> Option<InputDevice> {
    if unit.is_null() {
        return None;
    }
    let mut device: ObjectId = 0;
    let mut size = size_of::<ObjectId>() as u32;
    // SAFETY: a valid unit in the scope the property was set in, and a buffer of the one
    // `ObjectId` the property holds.
    let status = unsafe {
        AudioUnitGetProperty(
            unit,
            CURRENT_DEVICE,
            UNIT_SCOPE_GLOBAL,
            ELEMENT_MAIN,
            (&mut device as *mut ObjectId).cast(),
            &mut size,
        )
    };
    if status != 0 || device == 0 {
        return None;
    }
    input_device(device)
}

/// Every device with an input stream, with the id CoreAudio selects devices by.
fn input_devices() -> Vec<(ObjectId, InputDevice)> {
    devices()
        .into_iter()
        .filter(|device| has_input(*device))
        .filter_map(|device| input_device(device).map(|input| (device, input)))
        .collect()
}

/// The id of the input device with this UID, out of what the system listed: a device is selected
/// by this `AudioDeviceID`, and the UID is only how the user and the panel name it (S4).
fn device_id<'a>(known: &'a [(ObjectId, InputDevice)], uid: &str) -> Option<(ObjectId, &'a InputDevice)> {
    known.iter().find(|(_, device)| device.uid == uid).map(|(id, device)| (*id, device))
}

/// Every device the system object knows, inputs and outputs alike, in its own order.
fn devices() -> Vec<ObjectId> {
    let address = Address { selector: HARDWARE_DEVICES, scope: SCOPE_GLOBAL, element: ELEMENT_MAIN };
    let mut size = 0u32;
    // SAFETY: a valid property of the system object; the size is written only on success.
    let status = unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, null(), &mut size) };
    if status != 0 || size == 0 {
        return Vec::new();
    }
    let mut ids = vec![0 as ObjectId; size as usize / size_of::<ObjectId>()];
    // SAFETY: `ids` holds `size / sizeof(u32)` identifiers, which is what the call fills.
    let status = unsafe {
        AudioObjectGetPropertyData(SYSTEM_OBJECT, &address, 0, null(), &mut size, ids.as_mut_ptr().cast())
    };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / size_of::<ObjectId>());
    ids
}

/// Whether the device carries any input stream at all (a speaker-only device does not).
fn has_input(device: ObjectId) -> bool {
    let address = Address { selector: DEVICE_STREAMS, scope: SCOPE_INPUT, element: ELEMENT_MAIN };
    let mut size = 0u32;
    // SAFETY: as `devices`: a size query on a device identifier the system just listed.
    let status = unsafe { AudioObjectGetPropertyDataSize(device, &address, 0, null(), &mut size) };
    status == 0 && size > 0
}

/// A device's UID and name; `None` when it has no UID (not a device anything can be chosen by).
fn input_device(device: ObjectId) -> Option<InputDevice> {
    let uid = string_property(device, DEVICE_UID).filter(|uid| !uid.is_empty())?;
    let name = string_property(device, OBJECT_NAME).unwrap_or_else(|| uid.clone());
    Some(InputDevice { uid, name })
}

/// A string property of an object, copied out of CoreAudio's `CFString` (which is ours to
/// release) into a `String`.
fn string_property(object: ObjectId, selector: ObjectId) -> Option<String> {
    let address = Address { selector, scope: SCOPE_GLOBAL, element: ELEMENT_MAIN };
    let mut value: CFStringRef = null();
    let mut size = size_of::<CFStringRef>() as u32;
    // SAFETY: a string property holds one CFStringRef, and the address is valid for it. On
    // success the reference is ours, holding one reference.
    let status = unsafe {
        AudioObjectGetPropertyData(object, &address, 0, null(), &mut size, (&mut value as *mut CFStringRef).cast())
    };
    if status != 0 {
        return None;
    }
    let owned = NonNull::new(value.cast_mut())?;
    // SAFETY: CoreAudio handed over a reference this call owns, released here by dropping it;
    // no unwrap, so a null (already handled above) cannot reach this point.
    let owned: CFRetained<CFString> = unsafe { CFRetained::from_raw(owned) };
    Some(owned.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_input_list_is_consistent_on_any_machine() {
        let inputs = inputs();
        for device in &inputs {
            assert!(!device.uid.is_empty(), "a device with no UID cannot be chosen by UID (S4)");
            assert!(!device.name.is_empty(), "the panel shows this name");
        }
        // Nothing to record from is not a failure: a Mac with no input answers an empty list.
        assert!(inputs.len() < 64, "the enumeration is not looping on its own devices");
        // Each device once, so the panel's list has no duplicates in it.
        let mut uids: Vec<&str> = inputs.iter().map(|device| device.uid.as_str()).collect();
        uids.sort_unstable();
        uids.dedup();
        assert_eq!(uids.len(), inputs.len(), "a UID appears twice in the list");
        // The system default is a UID, empty or absent only when the query failed.
        assert!(default_input_uid().is_none_or(|uid| !uid.is_empty()));
    }

    #[test]
    fn a_uid_resolves_to_the_device_id_the_system_listed() {
        let known = [(
            42,
            InputDevice { uid: "BuiltInMicrophoneDevice".to_string(), name: "MacBook Pro Microphone".to_string() },
        )];
        assert_eq!(device_id(&known, "BuiltInMicrophoneDevice").map(|(id, _)| id), Some(42));
        assert!(device_id(&known, "a-headset-that-went-away").is_none());
    }

    #[test]
    fn a_device_or_a_unit_that_is_gone_is_an_error_not_a_panic() {
        // A null unit is safe on both paths: the UID is refused before the unit is touched, and
        // the unit itself is refused before CoreAudio sees it.
        let gone = select_input(std::ptr::null_mut(), "no-such-microphone");
        assert!(gone.is_err(), "a missing device must be an error, never a panic (S3)");
        assert!(select_input(std::ptr::null_mut(), "").is_err());
        assert_eq!(opened_input(std::ptr::null_mut()), None);
    }
}
