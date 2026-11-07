//! Selected/default-endpoint shared-mode WASAPI capture; opened only by a recording request.

use super::audio::{CapturePcm, PcmEncoding, MAX_CAPTURE_BYTES, MAX_CAPTURE_FRAMES};
use super::windows::{Capture, CaptureThread, PacketSink};
use super::input_devices::{resolve_input, validate_input_id};
use super::{Authorization, Microphone, Sink, Stream, VoiceError};
use std::marker::PhantomData;
use std::rc::Rc;
use ::windows::core::{Error, GUID};
use ::windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use ::windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM as PCM_SUBTYPE;
use ::windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT as FLOAT_SUBTYPE;
use ::windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

/// Stateless until `open`; constructing this microphone never probes or activates hardware.
pub(crate) struct WasapiMicrophone;

impl WasapiMicrophone {
    /// Snapshot the validated opaque selection before opening the existing COM worker.
    /// No interface or mutable selection crosses threads; later UI changes affect only
    /// subsequent recordings. None retains the system's capture/console default.
    pub fn open_selected(&self, sink: Sink, device_id: Option<&str>) -> Result<Box<dyn Stream>, VoiceError> {
        let selection = device_id.map(|id| {
            validate_input_id(id)?;
            Ok::<_, VoiceError>(id.to_owned())
        }).transpose()?;
        let packets = sink.clone();
        Ok(Box::new(CaptureThread::start(sink, move || WasapiCapture::open(packets, selection))?))
    }
}

impl Microphone for WasapiMicrophone {
    fn authorization(&self) -> Authorization {
        Authorization::NotDetermined
    }

    fn request_authorization(&self) -> Authorization {
        // Desktop WASAPI has no separate permission-request operation. Allow the existing
        // user-initiated start to proceed to open, where Windows enforces privacy policy.
        // This is not evidence of permission or a working device; status never probes it.
        Authorization::Authorized
    }

    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        self.open_selected(sink, None)
    }

    fn validate_selection(&self, device_id: Option<&str>) -> Result<(), VoiceError> {
        device_id.map_or(Ok(()), validate_input_id)
    }

    fn open_selected(&self, sink: Sink, device_id: Option<&str>) -> Result<Box<dyn Stream>, VoiceError> {
        WasapiMicrophone::open_selected(self, sink, device_id)
    }
}

fn invalid(message: &str) -> VoiceError {
    VoiceError::Failed(format!("Windows microphone: {message}"))
}

struct DeviceFormat {
    rate: u32,
    channels: u16,
    align: u16,
    encoding: PcmEncoding,
}

impl DeviceFormat {
    fn parse(base: WAVEFORMATEX, extension: Option<(u16, GUID, u32)>) -> Result<Self, VoiceError> {
        let bits = base.wBitsPerSample;
        let (tag, valid) = if base.wFormatTag == 0xfffe {
            if base.cbSize < 22 {
                return Err(invalid("the extensible mix format is truncated."));
            }
            let (valid, subtype, mask) = extension.ok_or_else(|| invalid("missing extensible format."))?;
            if mask != 0 && mask.count_ones() != u32::from(base.nChannels) {
                return Err(invalid("the channel mask does not match the channel count."));
            }
            let tag = if subtype == PCM_SUBTYPE { 1 } else if subtype == FLOAT_SUBTYPE { 3 }
                else { return Err(invalid("unsupported extensible sample subtype.")); };
            (tag, valid)
        } else {
            (base.wFormatTag, bits)
        };
        if valid == 0 || valid > bits || (tag == 3 && valid != 32) {
            return Err(invalid("unsupported valid bits per sample."));
        }
        let encoding = match (tag, bits) {
            (1, 8) => PcmEncoding::Unsigned8,
            (1, 16) => PcmEncoding::Signed16,
            (1, 24) => PcmEncoding::Signed24,
            (1, 32) => PcmEncoding::Signed32,
            (3, 32) => PcmEncoding::Float32,
            _ => return Err(invalid("unsupported PCM/float container.")),
        };
        let align = base.nChannels.checked_mul(bits / 8)
            .ok_or_else(|| invalid("block alignment overflow."))?;
        if align != base.nBlockAlign || base.nSamplesPerSec.checked_mul(u32::from(align)) != Some(base.nAvgBytesPerSec) {
            return Err(invalid("inconsistent block alignment or byte rate."));
        }
        // Reuse the converter's rate/channel limits before constructing any stream.
        CapturePcm::new(base.nSamplesPerSec, base.nChannels, encoding).map_err(invalid)?;
        Ok(Self { rate: base.nSamplesPerSec, channels: base.nChannels, align, encoding })
    }

    fn packet_bytes(&self, frames: u32, capacity: u32) -> Result<usize, VoiceError> {
        let bytes = (frames as usize).checked_mul(usize::from(self.align))
            .ok_or_else(|| invalid("packet byte count overflow."))?;
        if frames > capacity || frames > MAX_CAPTURE_FRAMES || bytes > MAX_CAPTURE_BYTES {
            return Err(invalid("the capture packet exceeds its buffer or size limit."));
        }
        Ok(bytes)
    }
}

/// Non-null, nonempty, non-silent data must contain `bytes` readable bytes and remain held
/// until the returned slice is consumed. SILENT data is ignored, including invalid pointers.
unsafe fn packet_data<'a>(data: *const u8, bytes: usize, silent: bool) -> Result<Option<&'a [u8]>, VoiceError> {
    if silent {
        return Ok(None);
    }
    if bytes == 0 {
        return Ok(Some(&[]));
    }
    if data.is_null() {
        return Err(invalid("the device returned a null non-silent buffer."));
    }
    // SAFETY: the caller owns the acquired packet, validated its size, and keeps it held.
    Ok(Some(unsafe { std::slice::from_raw_parts(data, bytes) }))
}

/// Owns GetMixFormat's task allocation, including validation and initialization failures.
struct MixFormat(*mut WAVEFORMATEX);

impl Drop for MixFormat {
    fn drop(&mut self) {
        // SAFETY: GetMixFormat transfers this allocation; free exactly once on its COM thread.
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

impl MixFormat {
    fn parse(&self) -> Result<DeviceFormat, VoiceError> {
        if self.0.is_null() {
            return Err(invalid("the device returned a null mix format."));
        }
        // SAFETY: a successful GetMixFormat supplies WAVEFORMATEX followed by cbSize bytes.
        // Packed structures are copied with unaligned reads; no packed-field references.
        let base = unsafe { self.0.read_unaligned() };
        let extension = if base.wFormatTag == 0xfffe && base.cbSize >= 22 {
            let ext = unsafe { self.0.cast::<WAVEFORMATEXTENSIBLE>().read_unaligned() };
            Some((unsafe { ext.Samples.wValidBitsPerSample }, ext.SubFormat, ext.dwChannelMask))
        } else { None };
        DeviceFormat::parse(base, extension)
    }
}

fn device_error(stage: &str, error: Error) -> VoiceError {
    invalid(&format!("{stage} failed (0x{:08X}): {error}", error.code().0 as u32))
}

/// Declaration order releases the capture service before its audio client. The explicit
/// thread marker also prevents accidental movement even if generated interfaces are Send.
struct WasapiCapture {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    format: DeviceFormat,
    packets: PacketSink,
    capacity: u32,
    started: bool,
    _thread: PhantomData<Rc<()>>,
}

impl WasapiCapture {
    fn open(sink: Sink, selection: Option<String>) -> Result<Self, VoiceError> {
        // SAFETY: CaptureThread initialized COM on this thread. All interfaces and the
        // task allocation remain here, including every partial-initialization error path.
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| device_error("enumerating input devices", e))?;
        let endpoint = resolve_input(&enumerator, selection.as_deref())?;
        let client: IAudioClient = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
            .map_err(|e| device_error("activating the input", e))?;
        let mix = MixFormat(unsafe { client.GetMixFormat() }
            .map_err(|e| device_error("reading the mix format", e))?);
        let format = mix.parse()?;
        // Shared mode uses the engine's exact mix format, a 100 ms buffer, and periodicity
        // zero. Polling is intentional: no event callback or cross-thread COM handle.
        unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1_000_000, 0, mix.0, None) }
            .map_err(|e| device_error("initializing capture (check Windows microphone privacy settings)", e))?;
        let capacity = unsafe { client.GetBufferSize() }
            .map_err(|e| device_error("reading capture capacity", e))?;
        if capacity == 0 {
            return Err(invalid("the device reported an empty capture buffer."));
        }
        let capture: IAudioCaptureClient = unsafe { client.GetService() }
            .map_err(|e| device_error("opening the capture service", e))?;
        let packets = PacketSink::new(sink, format.rate, format.channels, format.encoding)?;
        Ok(Self { capture, client, format, packets, capacity, started: false, _thread: PhantomData })
    }
}

/// A successful GetBuffer always gets one matching ReleaseBuffer, including unwinding.
struct PacketLease<'a> {
    capture: &'a IAudioCaptureClient,
    frames: u32,
    held: bool,
}

impl PacketLease<'_> {
    fn release(mut self) -> Result<(), VoiceError> {
        self.held = false;
        // SAFETY: this lease was created immediately after GetBuffer on the same thread.
        unsafe { self.capture.ReleaseBuffer(self.frames) }.map_err(|e| device_error("releasing a packet", e))
    }
}

impl Drop for PacketLease<'_> {
    fn drop(&mut self) {
        if self.held {
            // SAFETY: fallback for a panic before explicit release; never crosses threads.
            let _ = unsafe { self.capture.ReleaseBuffer(self.frames) };
        }
    }
}

impl Capture for WasapiCapture {
    fn start(&mut self) -> Result<(), VoiceError> {
        // Arm cleanup before Start so a partially successful driver start is stopped too.
        self.started = true;
        unsafe { self.client.Start() }.map_err(|e| device_error("starting capture", e))
    }

    fn poll(&mut self, _: &Sink) -> Result<(), VoiceError> {
        // A busy device cannot starve CaptureThread's stop channel. These shared-mode
        // methods only inspect queued packets; never wait for new audio in this drain.
        for _ in 0..8 {
            if unsafe { self.capture.GetNextPacketSize() }.map_err(|e| device_error("checking packets", e))? == 0 {
                break;
            }
            let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0, 0);
            unsafe { self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(|e| device_error("acquiring a packet", e))?;
            let lease = PacketLease { capture: &self.capture, frames, held: true };
            let (format, packets, capacity) = (&self.format, &mut self.packets, self.capacity);
            let converted = (|| {
                let bytes = format.packet_bytes(frames, capacity)?;
                // SAFETY: validated exact frame bytes, bounded by both the stream capacity
                // and allocation caps. The lease keeps the buffer held throughout conversion.
                let data = unsafe { packet_data(data, bytes, flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0) }?;
                packets.packet(data, frames)
            })();
            let released = lease.release();
            converted.and(released)?;
            if frames == 0 { break; }
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), VoiceError> {
        if !std::mem::replace(&mut self.started, false) {
            return Ok(());
        }
        // SAFETY: same thread as Initialize/Start; interfaces drop even if Stop fails.
        unsafe { self.client.Stop() }.map_err(|e| device_error("stopping capture", e))
    }
}

impl Drop for WasapiCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: 1, nChannels: 2, nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 192_000, nBlockAlign: 4, wBitsPerSample: 16, cbSize: 0,
        }
    }

    #[test]
    fn permission_queries_do_not_probe_or_activate_a_device() {
        let microphone = WasapiMicrophone;
        assert_eq!(microphone.authorization(), Authorization::NotDetermined);
        assert_eq!(microphone.request_authorization(), Authorization::Authorized);
        assert_eq!(microphone.authorization(), Authorization::NotDetermined);
    }

    #[test]
    fn accepts_pcm_float_and_left_aligned_extensible_pcm() {
        for bits in [8, 16, 24, 32] {
            let mut base = pcm();
            base.wBitsPerSample = bits;
            base.nBlockAlign = 2 * (bits / 8);
            base.nAvgBytesPerSec = 48_000 * u32::from(base.nBlockAlign);
            assert!(DeviceFormat::parse(base, None).is_ok());
        }
        let mut float = pcm();
        float.wFormatTag = 3;
        float.wBitsPerSample = 32;
        float.nBlockAlign = 8;
        float.nAvgBytesPerSec = 384_000;
        assert!(DeviceFormat::parse(float, None).is_ok());
        float.wFormatTag = 0xfffe;
        float.cbSize = 22;
        assert!(DeviceFormat::parse(float, Some((24, PCM_SUBTYPE, 3))).is_ok());
        assert!(DeviceFormat::parse(float, Some((32, FLOAT_SUBTYPE, 3))).is_ok());
    }

    #[test]
    fn rejects_malformed_or_unsupported_mix_formats() {
        for (tag, bits, align, average) in [
            (2, 16, 4, 192_000), (1, 12, 4, 192_000),
            (3, 16, 4, 192_000), (1, 16, 3, 144_000), (1, 16, 4, 1),
        ] {
            let mut invalid = pcm();
            invalid.wFormatTag = tag;
            invalid.wBitsPerSample = bits;
            invalid.nBlockAlign = align;
            invalid.nAvgBytesPerSec = average;
            assert!(DeviceFormat::parse(invalid, None).is_err());
        }
        let mut ext = pcm();
        ext.wFormatTag = 0xfffe;
        ext.cbSize = 21;
        assert!(DeviceFormat::parse(ext, Some((16, PCM_SUBTYPE, 3))).is_err());
        ext.cbSize = 22;
        for extension in [None, Some((0, PCM_SUBTYPE, 3)), Some((17, PCM_SUBTYPE, 3)),
            Some((16, GUID::from_u128(0), 3)), Some((16, PCM_SUBTYPE, 1)),
            Some((16, FLOAT_SUBTYPE, 3))] {
            assert!(DeviceFormat::parse(ext, extension).is_err());
        }
    }

    #[test]
    fn silent_and_empty_packets_never_read_a_null_pointer() {
        // SAFETY: silent and empty packets must not dereference this pointer.
        unsafe {
            assert_eq!(packet_data(std::ptr::null(), 40, true).unwrap(), None);
            assert_eq!(packet_data(std::ptr::null(), 0, false).unwrap(), Some(&[][..]));
            assert!(packet_data(std::ptr::null(), 40, false).is_err());
            let bytes = [1, 2, 3, 4];
            assert_eq!(packet_data(bytes.as_ptr(), bytes.len(), false).unwrap(), Some(&bytes[..]));
        }
    }

    #[test]
    fn packet_lengths_are_exact_bounded_and_checked_against_device_capacity() {
        let format = DeviceFormat::parse(pcm(), None).unwrap();
        assert_eq!(format.packet_bytes(10, 10).unwrap(), 40);
        assert_eq!(format.packet_bytes(0, 10).unwrap(), 0);
        assert!(format.packet_bytes(11, 10).is_err());
        assert!(format.packet_bytes(u32::MAX, u32::MAX).is_err());
        assert!(format.packet_bytes(MAX_CAPTURE_FRAMES + 1, u32::MAX).is_err());
    }
}
