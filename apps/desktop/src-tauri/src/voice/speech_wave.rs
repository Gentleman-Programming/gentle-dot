//! Portable bounds and ordinary PCM-to-WAV encoding for the Windows speech worker.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub(super) const MAX_TEXT_UNITS: usize = 4_000;
pub(super) const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_TIME: Duration = Duration::from_secs(60);

pub(super) fn check_request(text: &str, locale: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.contains('\0') || text.encode_utf16().count() > MAX_TEXT_UNITS {
        return Err("Speech text is empty, contains NUL, or exceeds 4000 UTF-16 units".into());
    }
    if locale.is_empty() || locale.len() > 85 || locale.contains('\0') {
        return Err("Invalid speech locale".into());
    }
    Ok(())
}

pub(super) fn check_live(cancelled: &AtomicBool, elapsed: Duration, bytes: u64) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Speech synthesis cancelled".into());
    }
    if elapsed >= MAX_TIME {
        return Err("Speech synthesis timed out".into());
    }
    if bytes > MAX_AUDIO_BYTES as u64 {
        return Err("Speech audio exceeds memory limit".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Pcm {
    pub channels: u16,
    pub rate: u32,
    pub bits: u16,
    pub align: u16,
    pub byte_rate: u32,
}

impl Pcm {
    pub(super) fn validate(self) -> Result<Self, String> {
        if !(1..=2).contains(&self.channels)
            || !(8_000..=96_000).contains(&self.rate)
            || !matches!(self.bits, 8 | 16)
            || self.channels.checked_mul(self.bits / 8) != Some(self.align)
            || self.rate.checked_mul(u32::from(self.align)) != Some(self.byte_rate)
        {
            return Err("Unsupported or inconsistent speech PCM format".into());
        }
        Ok(self)
    }

    pub(super) fn wav(self, pcm: &[u8]) -> Result<Vec<u8>, String> {
        self.validate()?;
        if pcm.is_empty() || pcm.len() > MAX_AUDIO_BYTES || pcm.len() % usize::from(self.align) != 0 {
            return Err("Empty, oversized, or truncated speech PCM".into());
        }
        // SetBaseStream yields raw samples. Never wrap a second container header.
        if pcm.starts_with(b"RIFF") || pcm.starts_with(b"RIFX") || pcm.starts_with(b"RF64") {
            return Err("Unexpected container in speech PCM stream".into());
        }
        let length = u32::try_from(pcm.len()).map_err(|_| "Speech WAV length overflow".to_string())?;
        let padding = length & 1;
        let riff_length = length.checked_add(36).and_then(|n| n.checked_add(padding))
            .ok_or_else(|| "Speech WAV length overflow".to_string())?;
        let mut wav = Vec::with_capacity(44 + pcm.len() + padding as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&riff_length.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0");
        wav.extend_from_slice(&self.channels.to_le_bytes());
        wav.extend_from_slice(&self.rate.to_le_bytes());
        wav.extend_from_slice(&self.byte_rate.to_le_bytes());
        wav.extend_from_slice(&self.align.to_le_bytes());
        wav.extend_from_slice(&self.bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&length.to_le_bytes());
        wav.extend_from_slice(pcm);
        if padding != 0 {
            wav.push(0);
        }
        Ok(wav)
    }
}

pub(super) fn language_rank(attributes: &str, requested: u16) -> u8 {
    attributes.split(';').filter_map(|s| u16::from_str_radix(s.trim(), 16).ok())
        .map(|id| if id == requested { 2 } else if id & 0x3ff == requested & 0x3ff { 1 } else { 0 })
        .max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn pcm() -> Pcm {
        Pcm { channels: 1, rate: 22_050, bits: 16, align: 2, byte_rate: 44_100 }
    }

    #[test]
    fn packs_exact_pcm_metadata_riff_lengths_and_samples() {
        let wav = pcm().wav(&[1, 2, 3, 4]).expect("valid PCM must produce WAV bytes");
        let mut expected = b"RIFF".to_vec();
        expected.extend_from_slice(&40u32.to_le_bytes());
        expected.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0");
        expected.extend_from_slice(&1u16.to_le_bytes());
        expected.extend_from_slice(&22_050u32.to_le_bytes());
        expected.extend_from_slice(&44_100u32.to_le_bytes());
        expected.extend_from_slice(&2u16.to_le_bytes());
        expected.extend_from_slice(&16u16.to_le_bytes());
        expected.extend_from_slice(b"data\x04\0\0\0\x01\x02\x03\x04");
        assert_eq!(wav, expected);
    }

    #[test]
    fn pads_odd_eight_bit_data_without_counting_pad_as_sample() {
        let format = Pcm { bits: 8, align: 1, byte_rate: 22_050, ..pcm() };
        let wav = format.wav(&[128]).expect("8-bit PCM must produce a padded WAV");
        assert_eq!(wav.len(), 46);
        assert_eq!(&wav[4..8], &38u32.to_le_bytes());
        assert_eq!(&wav[28..36], &[0x22, 0x56, 0, 0, 1, 0, 8, 0]);
        assert_eq!(&wav[40..44], &1u32.to_le_bytes());
        assert_eq!(&wav[44..], &[128, 0]);
    }

    #[test]
    fn validates_supported_formats_and_rejects_inconsistent_or_overflowing_metadata() {
        for format in [pcm(), Pcm { channels: 2, rate: 96_000, bits: 16, align: 4, byte_rate: 384_000 }] {
            assert!(format.validate().is_ok(), "supported format: {format:?}");
        }
        for format in [
            Pcm { channels: 0, ..pcm() }, Pcm { channels: 3, ..pcm() },
            Pcm { rate: 7_999, ..pcm() }, Pcm { rate: 96_001, ..pcm() },
            Pcm { bits: 32, ..pcm() }, Pcm { align: 0, ..pcm() },
            Pcm { byte_rate: 1, ..pcm() },
            Pcm { channels: u16::MAX, rate: u32::MAX, bits: u16::MAX, align: u16::MAX, byte_rate: u32::MAX },
        ] {
            assert!(format.validate().is_err(), "must reject {format:?}");
            assert!(format.wav(&[0, 0]).is_err(), "encoding must validate {format:?}");
        }
    }

    #[test]
    fn rejects_empty_truncated_nested_and_oversized_pcm() {
        for samples in [&[][..], &[1][..], &b"RIFFfake"[..], &b"RIFXfake"[..], &b"RF64fake"[..]] {
            assert!(pcm().wav(samples).is_err(), "invalid PCM: {samples:?}");
        }
        assert!(pcm().wav(&vec![0; MAX_AUDIO_BYTES + 2]).is_err());
    }

    #[test]
    fn accepts_pcm_at_the_memory_limit_with_checked_riff_size() {
        let wav = pcm().wav(&vec![0; MAX_AUDIO_BYTES]).expect("the PCM limit is inclusive");
        assert_eq!(wav.len(), MAX_AUDIO_BYTES + 44);
        assert_eq!(&wav[4..8], &((MAX_AUDIO_BYTES + 36) as u32).to_le_bytes());
        assert_eq!(&wav[40..44], &(MAX_AUDIO_BYTES as u32).to_le_bytes());
    }

    #[test]
    fn request_validation_counts_utf16_without_synthesizing_boundary_text() {
        assert!(check_request("A short synthesis test.", "en-US").is_ok());
        assert!(check_request(&"a".repeat(MAX_TEXT_UNITS), "en").is_ok());
        assert!(check_request(&"😀".repeat(MAX_TEXT_UNITS / 2), "en").is_ok());
        assert!(check_request(&"a".repeat(MAX_TEXT_UNITS + 1), "en").is_err());
        let mixed = format!("{}a", "😀".repeat(MAX_TEXT_UNITS / 2));
        assert!(check_request(&mixed, "en").is_err());
        for text in ["", " \t\n", "hello\0world"] {
            assert!(check_request(text, "en-US").is_err(), "invalid text: {text:?}");
        }
        // Markup-looking text remains literal input, not a request for SSML or a URL.
        assert!(check_request("<speak>https://example.invalid/audio.wav</speak>", "en-US").is_ok());
        assert!(check_request("hello", &"a".repeat(85)).is_ok());
        for locale in ["".to_string(), "en\0US".to_string(), "a".repeat(86)] {
            assert!(check_request("hello", &locale).is_err(), "invalid locale: {locale:?}");
        }
    }

    #[test]
    fn cancellation_deadline_and_memory_limits_return_terminal_errors() {
        let flag = AtomicBool::new(false);
        assert!(check_live(&flag, MAX_TIME - Duration::from_nanos(1), MAX_AUDIO_BYTES as u64).is_ok());
        assert_eq!(check_live(&flag, MAX_TIME, 0), Err("Speech synthesis timed out".into()));
        assert_eq!(check_live(&flag, MAX_TIME + Duration::from_secs(1), 0), Err("Speech synthesis timed out".into()));
        assert_eq!(check_live(&flag, Duration::ZERO, MAX_AUDIO_BYTES as u64 + 1), Err("Speech audio exceeds memory limit".into()));
        assert!(check_live(&flag, Duration::ZERO, u64::MAX).is_err());
        flag.store(true, Ordering::Release);
        assert_eq!(check_live(&flag, Duration::ZERO, 0), Err("Speech synthesis cancelled".into()));
        assert_eq!(check_live(&flag, MAX_TIME, u64::MAX), Err("Speech synthesis cancelled".into()));
    }

    #[test]
    fn exact_locale_beats_primary_language_and_malformed_attributes_do_not_match() {
        assert_eq!(language_rank("409;80A;0C0A", 0x0c0a), 2);
        assert_eq!(language_rank(" 80A ", 0x0c0a), 1);
        assert_eq!(language_rank("409;garbage;10000", 0x0c0a), 0);
        assert_eq!(language_rank("", 0x0409), 0);
    }
}
