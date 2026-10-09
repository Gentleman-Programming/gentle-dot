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

#[cfg(test)]
mod tests {
    use super::*;

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
