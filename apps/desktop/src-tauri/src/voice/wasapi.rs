//! The Windows microphone: the default capture endpoint through WASAPI, in shared mode and in
//! the device's own mix format (`IAudioClient::GetMixFormat`), converted here to the 16 kHz mono
//! f32 the recognizers consume (`format`). Forcing that format on WASAPI with
//! `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` is reported to capture digital silence, without an error,
//! on some Windows 11 endpoints (RustAudio/cpal#1200, cjpais/Handy#2141). A thread of its own
//! (`capture_thread`) owns the COM objects for the whole capture and polls for packets.
//!
//! Desktop apps get no microphone prompt on Windows: the system's privacy switches ("Microphone
//! access", and under it "Let desktop apps access your microphone") either allow every desktop
//! app or none, and a blocked capture fails with `E_ACCESSDENIED` when it opens.
//!
//! Only `device` binds Win32; the rest is compiled on every platform so its tests run on all of
//! them.

#[cfg(windows)]
mod device;
mod format;

#[cfg(windows)]
pub use device::WindowsMicrophone;

use super::capture_thread::failed_to_start;
use super::VoiceError;

// HRESULTs that tell the user something they can act on.
const E_ACCESSDENIED: u32 = 0x8007_0005;
/// `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`: no capture endpoint at all.
const E_NOTFOUND: u32 = 0x8007_0490;
const AUDCLNT_E_DEVICE_INVALIDATED: u32 = 0x8889_0004;

/// What a failure to open the capture means to the user.
pub(crate) fn open_error(code: u32, message: &str) -> VoiceError {
    match code {
        E_ACCESSDENIED => VoiceError::MicrophoneDenied,
        E_NOTFOUND | AUDCLNT_E_DEVICE_INVALIDATED => VoiceError::NoMicrophone,
        _ => failed_to_start(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_failures_say_what_the_user_can_do() {
        assert_eq!(open_error(0x8007_0005, "denied"), VoiceError::MicrophoneDenied);
        assert_eq!(open_error(0x8007_0490, "none"), VoiceError::NoMicrophone);
        assert_eq!(open_error(0x8889_0004, "gone"), VoiceError::NoMicrophone);
        assert_eq!(
            open_error(0x8889_0008, "Unsupported format"),
            VoiceError::Failed("The microphone could not start: Unsupported format".into())
        );
    }
}
