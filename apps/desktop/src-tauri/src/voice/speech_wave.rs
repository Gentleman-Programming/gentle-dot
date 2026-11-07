//! Pure bounds and PCM-to-WAV encoding for the Windows speech worker.
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
            || self.align != self.channels * (self.bits / 8)
            || self.byte_rate != self.rate * u32::from(self.align)
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
        // SetBaseStream writes raw samples, not a RIFF file. Reject unexpected
        // encoded output rather than wrap a second WAV header around it.
        if pcm.starts_with(b"RIFF") || pcm.starts_with(b"RIFX") || pcm.starts_with(b"RF64") {
            return Err("Unexpected container in speech PCM stream".into());
        }
        let padding = pcm.len() & 1;
        let mut wav = Vec::with_capacity(44 + pcm.len() + padding);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + pcm.len() + padding) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0");
        wav.extend_from_slice(&self.channels.to_le_bytes());
        wav.extend_from_slice(&self.rate.to_le_bytes());
        wav.extend_from_slice(&self.byte_rate.to_le_bytes());
        wav.extend_from_slice(&self.align.to_le_bytes());
        wav.extend_from_slice(&self.bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
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

    fn pcm() -> Pcm {
        Pcm { channels: 1, rate: 22_050, bits: 16, align: 2, byte_rate: 44_100 }
    }

    #[test]
    fn packs_exact_riff_lengths_and_samples() {
        let wav = pcm().wav(&[1, 2, 3, 4]).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(&wav[40..44], &4u32.to_le_bytes());
        assert_eq!(&wav[44..], &[1, 2, 3, 4]);
    }

    #[test]
    fn pads_odd_eight_bit_data_without_counting_pad_as_sample() {
        let format = Pcm { bits: 8, align: 1, byte_rate: 22_050, ..pcm() };
        let wav = format.wav(&[128]).unwrap();
        assert_eq!(wav.len(), 46);
        assert_eq!(&wav[40..44], &1u32.to_le_bytes());
        assert_eq!(&wav[44..], &[128, 0]);
    }

    #[test]
    fn rejects_invalid_format_empty_truncated_and_nested_container() {
        assert!(Pcm { bits: 32, ..pcm() }.validate().is_err());
        assert!(Pcm { byte_rate: 1, ..pcm() }.validate().is_err());
        assert!(Pcm { channels: 0, ..pcm() }.validate().is_err());
        assert!(pcm().wav(&[]).is_err());
        assert!(pcm().wav(&[1]).is_err());
        assert!(pcm().wav(b"RIFFfake").is_err());
        assert!(pcm().wav(&vec![0; MAX_AUDIO_BYTES + 2]).is_err());
    }

    #[test]
    fn request_bounds_are_utf16_and_reject_nul() {
        assert!(check_request("hello", "es-ES").is_ok());
        assert!(check_request(" ", "en-US").is_err());
        assert!(check_request("hello\0world", "en-US").is_err());
        assert!(check_request(&"a".repeat(MAX_TEXT_UNITS), "en").is_ok());
        assert!(check_request(&"😀".repeat(MAX_TEXT_UNITS / 2 + 1), "en").is_err());
        assert!(check_request("hello", "").is_err());
    }

    #[test]
    fn cancellation_timeout_and_memory_are_terminal_not_empty_success() {
        let flag = AtomicBool::new(false);
        assert!(check_live(&flag, Duration::ZERO, MAX_AUDIO_BYTES as u64).is_ok());
        assert!(check_live(&flag, MAX_TIME, 0).is_err());
        assert!(check_live(&flag, Duration::ZERO, MAX_AUDIO_BYTES as u64 + 1).is_err());
        flag.store(true, Ordering::Release);
        assert!(check_live(&flag, Duration::ZERO, 0).is_err());
    }

    #[test]
    fn exact_locale_beats_primary_language_and_bad_attributes_do_not_match() {
        assert_eq!(language_rank("409;80A;0C0A", 0x0c0a), 2);
        assert_eq!(language_rank("80A", 0x0c0a), 1);
        assert_eq!(language_rank("409;garbage", 0x0c0a), 0);
    }
}
