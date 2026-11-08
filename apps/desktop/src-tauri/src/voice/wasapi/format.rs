//! The device's shared-mode mix format, as `IAudioClient::GetMixFormat` reports it, and the
//! conversion of its packets to the 16 kHz mono f32 every recognizer consumes. Parsed from the
//! raw `WAVEFORMATEX` bytes so it is tested on every platform, without a device.

use crate::voice::audio::{self, Resampler};
use crate::voice::capture_thread::failed_to_start;
use crate::voice::VoiceError;

// Format tags (mmreg.h). An extensible format names its sample type in `SubFormat`, a GUID whose
// first field is one of the plain tags and the rest is the same base for every one of them.
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// `KSDATAFORMAT_SUBTYPE_*` after its first field (`-0000-0010-8000-00aa00389b71`), in memory order.
const SUBTYPE_BASE: [u8; 12] = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
/// `sizeof(WAVEFORMATEX)`, and the extensible tail after it: valid bits, channel mask, SubFormat.
pub(crate) const WAVEFORMATEX_BYTES: usize = 18;
const EXTENSIBLE_TAIL: usize = 22;

/// How one sample of one channel is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sample {
    Float32,
    Float64,
    /// Unsigned, centred on 128.
    Pcm8,
    Pcm16,
    /// Packed in three bytes.
    Pcm24,
    /// Also 24-bit audio in a 32-bit container, which is left-justified, so full scale is the same.
    Pcm32,
}

impl Sample {
    fn bytes(self) -> usize {
        match self {
            Sample::Pcm8 => 1,
            Sample::Pcm16 => 2,
            Sample::Pcm24 => 3,
            Sample::Float32 | Sample::Pcm32 => 4,
            Sample::Float64 => 8,
        }
    }

    /// One little-endian sample, `bytes()` long, scaled to -1..1.
    fn decode(self, b: &[u8]) -> f32 {
        match self {
            Sample::Float32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            Sample::Float64 => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
            Sample::Pcm8 => (f32::from(b[0]) - 128.0) / 128.0,
            Sample::Pcm16 => f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
            Sample::Pcm24 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
            Sample::Pcm32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MixFormat {
    pub sample: Sample,
    pub channels: usize,
    pub rate: u32,
    /// Bytes per frame: one sample of every channel, interleaved.
    pub block_align: usize,
}

impl MixFormat {
    /// Reads a `WAVEFORMATEX` and, for `WAVE_FORMAT_EXTENSIBLE`, the `WAVEFORMATEXTENSIBLE` tail
    /// after it: `bytes` holds the 18-byte header and then `cbSize` more.
    pub fn parse(bytes: &[u8]) -> Result<Self, VoiceError> {
        let unsupported = |what: String| failed_to_start(format!("the microphone's format is not supported ({what})"));
        let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        if bytes.len() < WAVEFORMATEX_BYTES {
            return Err(unsupported(format!("{} bytes", bytes.len())));
        }
        let (tag, channels, bits, block_align) = (u16_at(0), u16_at(2), u16_at(14), u16_at(12));
        let rate = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let kind = if tag == WAVE_FORMAT_EXTENSIBLE {
            let tail = &bytes[WAVEFORMATEX_BYTES..];
            if u16_at(16) < EXTENSIBLE_TAIL as u16 || tail.len() < EXTENSIBLE_TAIL {
                return Err(unsupported("a truncated extensible format".into()));
            }
            let valid = u16::from_le_bytes([tail[0], tail[1]]);
            if valid == 0 || valid > bits {
                return Err(unsupported(format!("{valid} valid bits in {bits}")));
            }
            let subformat = &tail[6..22];
            if subformat[4..] != SUBTYPE_BASE || subformat[2..4] != [0, 0] {
                return Err(unsupported(format!("subformat {subformat:02x?}")));
            }
            u16::from_le_bytes([subformat[0], subformat[1]])
        } else {
            tag
        };
        let sample = match (kind, bits) {
            (WAVE_FORMAT_IEEE_FLOAT, 32) => Sample::Float32,
            (WAVE_FORMAT_IEEE_FLOAT, 64) => Sample::Float64,
            (WAVE_FORMAT_PCM, 8) => Sample::Pcm8,
            (WAVE_FORMAT_PCM, 16) => Sample::Pcm16,
            (WAVE_FORMAT_PCM, 24) => Sample::Pcm24,
            (WAVE_FORMAT_PCM, 32) => Sample::Pcm32,
            _ => return Err(unsupported(format!("type {kind}, {bits} bits"))),
        };
        let (channels, block_align) = (usize::from(channels), usize::from(block_align));
        if channels == 0 || rate == 0 || block_align != channels * sample.bytes() {
            return Err(unsupported(format!("{channels} channels at {rate} Hz, {block_align} bytes a frame")));
        }
        Ok(MixFormat { sample, channels, rate, block_align })
    }
}

/// Turns packets in the mix format into `audio::SAMPLE_RATE` mono f32, keeping the resampler's
/// position across packets.
pub(crate) struct Converter {
    format: MixFormat,
    resampler: Resampler,
}

impl Converter {
    pub fn new(format: MixFormat) -> Self {
        Converter { format, resampler: Resampler::new(f64::from(format.rate)) }
    }

    /// One packet of interleaved frames; a trailing partial frame is ignored.
    pub fn packet(&mut self, data: &[u8]) -> Vec<f32> {
        let MixFormat { sample, channels, block_align, .. } = self.format;
        let frames = data.len() / block_align;
        let mut split = vec![Vec::with_capacity(frames); channels];
        for frame in data.chunks_exact(block_align) {
            for (channel, bytes) in split.iter_mut().zip(frame.chunks_exact(sample.bytes())) {
                channel.push(sample.decode(bytes));
            }
        }
        let refs: Vec<&[f32]> = split.iter().map(Vec::as_slice).collect();
        self.resampler.process(&audio::mono(&refs))
    }

    /// A packet WASAPI flagged silent: `frames` frames of nothing, at the device rate.
    pub fn silence(&mut self, frames: usize) -> Vec<f32> {
        self.resampler.process(&vec![0.0; frames])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `WAVEFORMATEX`, with the extensible tail when `subformat` is given.
    fn wave(tag: u16, channels: u16, rate: u32, bits: u16, subformat: Option<u16>) -> Vec<u8> {
        let block_align = channels * bits / 8;
        let mut bytes = Vec::new();
        bytes.extend(tag.to_le_bytes());
        bytes.extend(channels.to_le_bytes());
        bytes.extend(rate.to_le_bytes());
        bytes.extend((rate * u32::from(block_align)).to_le_bytes());
        bytes.extend(block_align.to_le_bytes());
        bytes.extend(bits.to_le_bytes());
        match subformat {
            None => bytes.extend(0u16.to_le_bytes()),
            Some(kind) => {
                bytes.extend(22u16.to_le_bytes());
                bytes.extend(bits.to_le_bytes());
                bytes.extend(0x3u32.to_le_bytes());
                bytes.extend(u32::from(kind).to_le_bytes());
                bytes.extend(SUBTYPE_BASE);
            }
        }
        bytes
    }

    fn extensible(channels: u16, rate: u32, bits: u16, kind: u16) -> Vec<u8> {
        wave(WAVE_FORMAT_EXTENSIBLE, channels, rate, bits, Some(kind))
    }

    #[test]
    fn valid_bits_may_be_fewer_than_the_container_never_more() {
        let with_valid = |valid: u16| {
            let mut bytes = extensible(2, 48_000, 32, 1);
            bytes[18..20].copy_from_slice(&valid.to_le_bytes());
            MixFormat::parse(&bytes).map(|f| f.sample)
        };
        // 24 valid bits in a 32-bit container are left-justified, so they read as 32-bit PCM.
        assert_eq!(with_valid(24), Ok(Sample::Pcm32));
        assert!(with_valid(40).is_err());
        assert!(with_valid(0).is_err());
    }

    #[test]
    fn the_mix_format_names_its_sample_type_channels_and_rate() {
        let parsed = |bytes: Vec<u8>| MixFormat::parse(&bytes).map(|f| (f.sample, f.channels, f.rate, f.block_align));
        assert_eq!(parsed(extensible(2, 48_000, 32, 3)), Ok((Sample::Float32, 2, 48_000, 8)));
        assert_eq!(parsed(extensible(2, 44_100, 16, 1)), Ok((Sample::Pcm16, 2, 44_100, 4)));
        assert_eq!(parsed(extensible(1, 96_000, 24, 1)), Ok((Sample::Pcm24, 1, 96_000, 3)));
        assert_eq!(parsed(extensible(4, 48_000, 32, 1)), Ok((Sample::Pcm32, 4, 48_000, 16)));
        assert_eq!(parsed(wave(WAVE_FORMAT_IEEE_FLOAT, 1, 16_000, 32, None)), Ok((Sample::Float32, 1, 16_000, 4)));
        assert_eq!(parsed(wave(WAVE_FORMAT_PCM, 2, 22_050, 16, None)), Ok((Sample::Pcm16, 2, 22_050, 4)));
    }

    #[test]
    fn a_mix_format_it_cannot_read_is_an_error_not_silence() {
        let error = |bytes: &[u8]| MixFormat::parse(bytes).unwrap_err().to_string();
        assert!(error(&extensible(2, 48_000, 12, 1)).contains("type 1, 12 bits"));
        let mut ac3 = extensible(2, 48_000, 16, 0x92);
        assert!(error(&ac3).contains("type 146"));
        ac3[30] ^= 0xff; // Not a KSDATAFORMAT_SUBTYPE GUID at all.
        assert!(error(&ac3).contains("subformat"));
        assert!(error(&extensible(2, 48_000, 32, 3)[..30]).contains("truncated"));
        assert!(error(&wave(WAVE_FORMAT_PCM, 0, 48_000, 16, None)).contains("0 channels"));
        assert!(error(&[0; 4]).starts_with("The microphone could not start: "));
    }

    #[test]
    fn samples_of_every_type_scale_to_full_range() {
        assert_eq!(Sample::Float32.decode(&0.5f32.to_le_bytes()), 0.5);
        assert_eq!(Sample::Float64.decode(&(-0.25f64).to_le_bytes()), -0.25);
        assert_eq!(Sample::Pcm8.decode(&[192]), 0.5);
        assert_eq!(Sample::Pcm16.decode(&i16::MIN.to_le_bytes()), -1.0);
        assert_eq!(Sample::Pcm16.decode(&16_384i16.to_le_bytes()), 0.5);
        assert_eq!(Sample::Pcm24.decode(&[0x00, 0x00, 0xC0]), -0.5);
        assert_eq!(Sample::Pcm24.decode(&[0x00, 0x00, 0x40]), 0.5);
        assert_eq!(Sample::Pcm32.decode(&(1i32 << 30).to_le_bytes()), 0.5);
    }

    #[test]
    fn a_48_khz_stereo_float_packet_becomes_16_khz_mono() {
        let format = MixFormat::parse(&extensible(2, 48_000, 32, 3)).unwrap();
        let mut converter = Converter::new(format);
        // 10 ms: left at 0.5, right at -0.1, so the mix is 0.2.
        let packet: Vec<u8> = (0..480).flat_map(|_| [0.5f32.to_le_bytes(), (-0.1f32).to_le_bytes()]).flatten().collect();
        let out = converter.packet(&packet);
        assert_eq!(out.len(), 160);
        assert!(out.iter().all(|s| (s - 0.2).abs() < 1e-6), "{:?}", &out[..4]);
        assert_eq!(converter.silence(480), vec![0.0; 160], "a silent packet keeps the timing");
    }

    #[test]
    fn a_44_1_khz_four_channel_24_bit_packet_becomes_16_khz_mono_across_packets() {
        let format = MixFormat::parse(&extensible(4, 44_100, 24, 1)).unwrap();
        assert_eq!(format.block_align, 12);
        // Two channels at half scale, two silent: the mix is a quarter.
        let frame = [[0x00, 0x00, 0x40], [0x00, 0x00, 0x40], [0, 0, 0], [0, 0, 0]].concat();
        let second: Vec<u8> = frame.iter().copied().cycle().take(frame.len() * 4_410).collect();
        let mut converter = Converter::new(format);
        let (first, rest) = second.split_at(frame.len() * 1_000);
        let mut out = converter.packet(first);
        out.extend(converter.packet(rest));
        assert_eq!(out.len(), 1_600, "a tenth of a second at 16 kHz");
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }
}
