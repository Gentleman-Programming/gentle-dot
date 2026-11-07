//! Bounded, content-free metadata; no audio, text, device identity or native error.
use serde::Serialize;

pub const EVENT: &str = "voice://diagnostic";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    FinalBuffer,
    Loading,
    Decoding,
    Complete,
    LoadFailed,
    DecodeFailed,
    WorkerFailed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_token: Option<String>,
    pub route: &'static str,
    pub stage: Stage,
    pub pcm_samples: Option<usize>,
    pub sample_rate: Option<u32>,
}

impl Diagnostic {
    pub fn native(stage: Stage, samples: Option<usize>) -> Self {
        Self { diagnostic_token: None, route: "native", stage, pcm_samples: samples, sample_rate: samples.map(|_| 16_000) }
    }
}

/// Opaque correlation only; validate before permission prompts or state mutation.
pub fn validate_token(token: Option<&str>) -> Result<(), super::VoiceError> {
    if token.is_some_and(|s| s.is_empty() || s.len() > 128
        || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) {
        return Err(super::VoiceError::Failed("Invalid voice diagnostic token.".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_has_only_finite_stage_and_actual_pcm_fields() {
        assert_eq!(serde_json::to_value(Diagnostic::native(Stage::LoadFailed, Some(17))).unwrap(),
            serde_json::json!({"route":"native","stage":"load-failed","pcmSamples":17,"sampleRate":16000}));
        assert_eq!(serde_json::to_value(Diagnostic::native(Stage::Failed, None)).unwrap(),
            serde_json::json!({"route":"native","stage":"failed","pcmSamples":null,"sampleRate":null}));
    }
}
