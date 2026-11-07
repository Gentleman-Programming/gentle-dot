//! PCM helpers shared by every microphone and recognizer: the 16 kHz mono contract, the
//! level meter, and a streaming resampler from the device rate.

/// What every `Microphone` delivers and every `Recognizer` consumes: 16 kHz mono f32.
pub const SAMPLE_RATE: u32 = 16_000;
/// The meter's floor: quieter input shows as silence.
const FLOOR_DB: f32 = -50.0;

/// Root mean square of a chunk.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Maps an RMS to the meter's 0..1 on a decibel scale: -50 dBFS and below is 0, 0 dBFS is 1.
/// Speech sits around -40 to -10 dBFS, so a linear RMS would barely move the meter.
pub fn level(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    ((20.0 * rms.log10() - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

/// Averages the device's channels (non-interleaved) into one.
pub fn mono(channels: &[&[f32]]) -> Vec<f32> {
    let Some(first) = channels.first() else { return Vec::new() };
    if channels.len() == 1 {
        return first.to_vec();
    }
    let scale = 1.0 / channels.len() as f32;
    (0..first.len()).map(|i| channels.iter().map(|c| c.get(i).copied().unwrap_or(0.0)).sum::<f32>() * scale).collect()
}

/// Converts a mono stream from the device rate to `SAMPLE_RATE`, chunk by chunk. Downsampling
/// averages the input that falls in each output period (a box filter, enough to keep speech
/// free of audible aliasing); lower rates are held.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Input consumed, and where the current output period ends.
    position: f64,
    edge: f64,
    sum: f32,
    count: u32,
    last: f32,
}

impl Resampler {
    pub fn new(from_rate: f64) -> Self {
        let step = from_rate / f64::from(SAMPLE_RATE);
        Resampler { step, position: 0.0, edge: step, sum: 0.0, count: 0, last: 0.0 }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        for &sample in input {
            self.sum += sample;
            self.count += 1;
            self.position += 1.0;
            while self.position >= self.edge - 1e-9 {
                if self.count > 0 {
                    self.last = self.sum / self.count as f32;
                    self.sum = 0.0;
                    self.count = 0;
                }
                out.push(self.last);
                self.edge += self.step;
            }
        }
        out
    }
}

/// Interleaved little-endian device samples. Extensible integer PCM must be left-aligned
/// in its container (including 24 valid bits in a 32-bit container), as WASAPI specifies.
#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy)]
pub(crate) enum PcmEncoding {
    Unsigned8,
    Signed16,
    Signed24,
    Signed32,
    Float32,
}

#[cfg(any(target_os = "windows", test))]
impl PcmEncoding {
    fn bytes(self) -> usize {
        match self {
            Self::Unsigned8 => 1,
            Self::Signed16 => 2,
            Self::Signed24 => 3,
            Self::Signed32 | Self::Float32 => 4,
        }
    }

    fn sample(self, bytes: &[u8]) -> f32 {
        let value = match self {
            Self::Unsigned8 => (f32::from(bytes[0]) - 128.0) / 128.0,
            Self::Signed16 => f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32768.0,
            Self::Signed24 => {
                let signed = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]);
                signed as f32 / 2147483648.0
            }
            Self::Signed32 => i32::from_le_bytes(bytes.try_into().unwrap()) as f32 / 2147483648.0,
            Self::Float32 => f32::from_le_bytes(bytes.try_into().unwrap()),
        };
        if value.is_finite() { value.clamp(-1.0, 1.0) } else { 0.0 }
    }
}

/// Bound both native pointer slices and silence allocations, even for a malformed driver.
#[cfg(any(target_os = "windows", test))]
pub(crate) const MAX_CAPTURE_BYTES: usize = 1_048_576;
#[cfg(any(target_os = "windows", test))]
pub(crate) const MAX_CAPTURE_FRAMES: u32 = 65_536;

/// One device stream's packet converter. Silence is represented by `None`, not a read from
/// WASAPI's possibly null buffer. A malformed packet leaves the resampler untouched.
/// Format negotiation must reject unsupported encodings before constructing this converter.
#[cfg(any(target_os = "windows", test))]
pub(crate) struct CapturePcm {
    channels: usize,
    encoding: PcmEncoding,
    resampler: Resampler,
}

#[cfg(any(target_os = "windows", test))]
impl CapturePcm {
    pub(crate) fn new(rate: u32, channels: u16, encoding: PcmEncoding) -> Result<Self, &'static str> {
        if !(8_000..=384_000).contains(&rate) || !(1..=32).contains(&channels) {
            return Err("The microphone reported an unsupported sample rate or channel count.");
        }
        Ok(Self { channels: usize::from(channels), encoding, resampler: Resampler::new(f64::from(rate)) })
    }

    pub(crate) fn packet(&mut self, bytes: Option<&[u8]>, frames: u32) -> Result<Vec<f32>, &'static str> {
        let frame_bytes = self.channels * self.encoding.bytes();
        let expected = (frames as usize).checked_mul(frame_bytes)
            .ok_or("The microphone packet is too large.")?;
        if frames > MAX_CAPTURE_FRAMES || expected > MAX_CAPTURE_BYTES {
            return Err("The microphone packet is too large.");
        }
        if bytes.is_some_and(|bytes| bytes.len() != expected) {
            return Err("The microphone packet does not contain complete frames.");
        }
        let mono = match bytes {
            None => vec![0.0; frames as usize],
            Some(bytes) => bytes.chunks_exact(frame_bytes).map(|frame| {
                frame.chunks_exact(self.encoding.bytes())
                    .map(|sample| self.encoding.sample(sample) / self.channels as f32).sum()
            }).collect(),
        };
        Ok(self.resampler.process(&mono))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_packets_mix_pcm_and_preserve_resampling_across_packets() {
        let mut capture = CapturePcm::new(48_000, 2, PcmEncoding::Signed16).unwrap();
        let frame = [0, 64, 0, 0]; // stereo: 0.5 and 0.0
        assert!(capture.packet(Some(&frame), 1).unwrap().is_empty());
        assert_eq!(capture.packet(Some(&frame.repeat(2)), 2).unwrap(), vec![0.25]);
        assert_eq!(capture.packet(None, 3).unwrap(), vec![0.0]);
    }

    #[test]
    fn capture_formats_decode_full_scale_and_sanitize_float() {
        for (encoding, bytes) in [
            (PcmEncoding::Unsigned8, vec![0]),
            (PcmEncoding::Signed16, i16::MIN.to_le_bytes().to_vec()),
            (PcmEncoding::Signed24, vec![0, 0, 128]),
            (PcmEncoding::Signed32, i32::MIN.to_le_bytes().to_vec()),
        ] {
            let mut capture = CapturePcm::new(16_000, 1, encoding).unwrap();
            assert_eq!(capture.packet(Some(&bytes), 1).unwrap(), vec![-1.0]);
        }
        let bytes: Vec<u8> = [0.5f32, f32::NAN, f32::INFINITY, -2.0]
            .into_iter().flat_map(f32::to_le_bytes).collect();
        let mut capture = CapturePcm::new(16_000, 1, PcmEncoding::Float32).unwrap();
        assert_eq!(capture.packet(Some(&bytes), 4).unwrap(), vec![0.5, 0.0, 0.0, -1.0]);
    }

    #[test]
    fn capture_rejects_invalid_formats_and_incomplete_packets_without_advancing() {
        assert!(CapturePcm::new(0, 1, PcmEncoding::Float32).is_err());
        assert!(CapturePcm::new(16_000, 0, PcmEncoding::Float32).is_err());
        let mut capture = CapturePcm::new(16_000, 1, PcmEncoding::Float32).unwrap();
        assert!(capture.packet(Some(&[0; 3]), 1).is_err());
        assert!(capture.packet(Some(&[0; 8]), 1).is_err());
        assert_eq!(capture.packet(None, 1).unwrap(), vec![0.0]);
        assert!(capture.packet(None, 0).unwrap().is_empty());
    }

    #[test]
    fn capture_limits_reject_unbounded_allocations_before_touching_pcm() {
        assert!(CapturePcm::new(1, 1, PcmEncoding::Float32).is_err());
        assert!(CapturePcm::new(384_001, 1, PcmEncoding::Float32).is_err());
        assert!(CapturePcm::new(16_000, 33, PcmEncoding::Float32).is_err());
        let mut capture = CapturePcm::new(16_000, 1, PcmEncoding::Float32).unwrap();
        assert!(capture.packet(None, u32::MAX).is_err());
        assert!(capture.packet(None, MAX_CAPTURE_FRAMES + 1).is_err());
        assert_eq!(capture.packet(None, 1).unwrap(), vec![0.0]);
        let mut wide = CapturePcm::new(384_000, 32, PcmEncoding::Float32).unwrap();
        assert!(wide.packet(None, 8193).is_err()); // 8192 * 32 * 4 is the byte cap.
        assert_eq!(wide.packet(None, 0).unwrap(), Vec::<f32>::new());
        assert!(CapturePcm::new(8_000, 1, PcmEncoding::Unsigned8).is_ok());
        let mut partial = CapturePcm::new(48_000, 1, PcmEncoding::Float32).unwrap();
        let sample = 0.75f32.to_le_bytes();
        assert!(partial.packet(Some(&sample), 1).unwrap().is_empty());
        assert!(partial.packet(None, MAX_CAPTURE_FRAMES + 1).is_err());
        assert_eq!(partial.packet(Some(&sample.repeat(2)), 2).unwrap(), vec![0.75]);
    }

    #[test]
    fn rms_of_a_constant_signal_is_its_magnitude() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn the_level_maps_decibels_to_zero_through_one() {
        assert_eq!(level(0.0), 0.0);
        assert_eq!(level(0.001), 0.0, "-60 dBFS is silence on the meter");
        assert_eq!(level(1.0), 1.0);
        assert_eq!(level(2.0), 1.0);
        let (quiet, loud) = (level(0.01), level(0.1));
        assert!(0.0 < quiet && quiet < loud && loud < 1.0);
    }

    #[test]
    fn channels_mix_down_to_mono() {
        assert_eq!(mono(&[&[1.0, 0.0], &[0.0, 0.0]]), vec![0.5, 0.0]);
        assert_eq!(mono(&[&[0.25, 0.75]]), vec![0.25, 0.75]);
        assert!(mono(&[]).is_empty());
    }

    #[test]
    fn resampling_48k_to_16k_keeps_a_third_of_the_samples_and_the_level() {
        let mut resampler = Resampler::new(48_000.0);
        let out = resampler.process(&[0.3; 4_800]);
        assert_eq!(out.len(), 1_600);
        assert!(out.iter().all(|s| (s - 0.3).abs() < 1e-6));
    }

    #[test]
    fn resampling_is_the_same_in_chunks_as_in_one_go() {
        let input: Vec<f32> = (0..4_410).map(|i| (i as f32 * 0.01).sin()).collect();
        let whole = Resampler::new(44_100.0).process(&input);
        let mut chunked = Resampler::new(44_100.0);
        let pieces: Vec<f32> = input.chunks(512).flat_map(|chunk| chunked.process(chunk)).collect();
        assert_eq!(whole.len(), 1_600);
        assert_eq!(pieces, whole);
    }

    #[test]
    fn resampling_at_16k_is_the_identity_and_lower_rates_are_held() {
        let input = [0.1, 0.2, 0.3];
        assert_eq!(Resampler::new(16_000.0).process(&input), input.to_vec());
        assert_eq!(Resampler::new(8_000.0).process(&[0.1, 0.2]), vec![0.1, 0.1, 0.2, 0.2]);
    }
}
