//! Which locale the recognizer gets: the requested one, else a variant of its language, else
//! the user's locale (or a variant of its language). The UI may pass a browser tag such as
//! `es-419`, and the system may report `es_AR`, which Speech does not list.

use super::VoiceError;

/// The variant used when a language's own region is not supported.
const MAIN_VARIANTS: &[(&str, &str)] = &[("en", "en-US"), ("pt", "pt-BR"), ("zh", "zh-CN"), ("ar", "ar-SA")];

/// `es_AR`, `en_US@rg=gbzzzz`, or ` pt-br ` → `es-AR`, `en-US`, `pt-BR`.
pub fn normalize(id: &str) -> String {
    let id = id.trim();
    let id = id.split('@').next().unwrap_or_default();
    let mut parts = id.split(['_', '-']).filter(|part| !part.is_empty());
    let Some(language) = parts.next() else { return String::new() };
    let mut out = language.to_ascii_lowercase();
    for part in parts {
        out.push('-');
        match part.len() {
            2 | 3 if part.chars().all(|c| c.is_ascii_alphabetic()) => out.push_str(&part.to_ascii_uppercase()),
            4 => {
                let mut chars = part.chars();
                out.extend(chars.next().map(|c| c.to_ascii_uppercase()));
                out.push_str(&chars.as_str().to_ascii_lowercase());
            }
            _ => out.push_str(part),
        }
    }
    out
}

fn language(tag: &str) -> &str {
    tag.split('-').next().unwrap_or_default()
}

/// The supported entry for `tag`, as the recognizer spells it.
fn pick(tag: &str, current: &str, supported: &[(String, &String)]) -> Option<String> {
    let find = |wanted: &str| supported.iter().find(|(normal, _)| normal == wanted).map(|(_, id)| (*id).clone());
    if tag.is_empty() {
        return None;
    }
    if let Some(found) = find(tag) {
        return Some(found);
    }
    let lang = language(tag);
    if language(current) == lang {
        if let Some(found) = find(current) {
            return Some(found);
        }
    }
    let main = MAIN_VARIANTS.iter().find(|(l, _)| *l == lang).map(|(_, v)| v.to_string());
    let main = main.unwrap_or_else(|| format!("{lang}-{}", lang.to_ascii_uppercase()));
    if let Some(found) = find(&main) {
        return Some(found);
    }
    let mut same: Vec<_> = supported.iter().filter(|(normal, _)| language(normal) == lang).collect();
    same.sort();
    same.first().map(|(_, id)| (*id).clone())
}

pub fn resolve(requested: Option<&str>, current: &str, supported: &[String]) -> Result<String, VoiceError> {
    let normalized: Vec<(String, &String)> = supported.iter().map(|id| (normalize(id), id)).collect();
    let requested = requested.map(normalize).unwrap_or_default();
    let current = normalize(current);
    pick(&requested, &current, &normalized)
        .or_else(|| pick(&current, &current, &normalized))
        .ok_or(VoiceError::NoRecognizer(if requested.is_empty() { current } else { requested }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::VoiceError;

    fn supported() -> Vec<String> {
        ["en-AU", "en-GB", "en-US", "es-CL", "es-ES", "es-MX", "pt-BR", "pt-PT"].map(String::from).to_vec()
    }

    #[test]
    fn identifiers_normalize_to_bcp47() {
        assert_eq!(normalize("es_AR"), "es-AR");
        assert_eq!(normalize("en_US@rg=gbzzzz"), "en-US");
        assert_eq!(normalize(" pt-br "), "pt-BR");
        assert_eq!(normalize("zh-Hant_TW"), "zh-Hant-TW");
    }

    #[test]
    fn an_exact_match_wins() {
        assert_eq!(resolve(Some("es_MX"), "en_US", &supported()), Ok("es-MX".into()));
        assert_eq!(resolve(None, "en_GB", &supported()), Ok("en-GB".into()));
    }

    #[test]
    fn a_missing_region_falls_back_to_the_main_variant_of_the_language() {
        assert_eq!(resolve(Some("es-AR"), "en_US", &supported()), Ok("es-ES".into()));
        assert_eq!(resolve(None, "en_AR", &supported()), Ok("en-US".into()));
        assert_eq!(resolve(Some("pt"), "en_US", &supported()), Ok("pt-BR".into()));
    }

    #[test]
    fn the_current_region_is_preferred_within_the_requested_language() {
        assert_eq!(resolve(Some("es"), "es_CL", &supported()), Ok("es-CL".into()));
    }

    #[test]
    fn an_unsupported_language_falls_back_to_the_current_locale() {
        assert_eq!(resolve(Some("ja-JP"), "es_MX", &supported()), Ok("es-MX".into()));
        assert_eq!(resolve(Some(""), "pt_PT", &supported()), Ok("pt-PT".into()));
    }

    #[test]
    fn nothing_supported_is_an_error_naming_the_locale() {
        assert_eq!(resolve(None, "ja_JP", &supported()), Err(VoiceError::NoRecognizer("ja-JP".into())));
        assert_eq!(resolve(Some("fr-FR"), "ja_JP", &[]), Err(VoiceError::NoRecognizer("fr-FR".into())));
    }
}
