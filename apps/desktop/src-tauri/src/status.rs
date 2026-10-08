//! Menu bar tooltip and glyph for each `AgentState` (protocol v1).

/// The menu bar rose (`docs/brand/rose-glyph.svg`), one template image per
/// state family. The PNGs are 36 px, drawn at 18 pt on Retina menu bars, and
/// rendered by `apps/desktop/scripts/render-icons.mjs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayGlyph {
    Ready,
    /// Dashed outer petals.
    Working,
    /// A filled badge dot at the top right.
    NeedsYou,
    /// Dimmed.
    Unavailable,
}

impl TrayGlyph {
    pub fn png(self) -> &'static [u8] {
        match self {
            Self::Ready => include_bytes!("../icons/tray/ready@2x.png"),
            Self::Working => include_bytes!("../icons/tray/working@2x.png"),
            Self::NeedsYou => include_bytes!("../icons/tray/needs-you@2x.png"),
            Self::Unavailable => include_bytes!("../icons/tray/unavailable@2x.png"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayStatus {
    pub tooltip: String,
    pub glyph: TrayGlyph,
}

/// `None` for a state the protocol does not define.
pub fn tray_status(state: &str) -> Option<TrayStatus> {
    let (label, glyph) = match state {
        "starting" => ("Starting", TrayGlyph::Unavailable),
        "idle" => ("Ready", TrayGlyph::Ready),
        "thinking" => ("Thinking", TrayGlyph::Working),
        "working" => ("Working", TrayGlyph::Working),
        "needs_you" => ("Needs you", TrayGlyph::NeedsYou),
        "restarting" => ("Restarting", TrayGlyph::Unavailable),
        "error" => ("Error", TrayGlyph::Unavailable),
        _ => return None,
    };
    Some(TrayStatus { tooltip: format!("Gentle Dot — {label}"), glyph })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_agent_state() {
        let cases = [
            ("starting", "Starting"),
            ("idle", "Ready"),
            ("thinking", "Thinking"),
            ("working", "Working"),
            ("needs_you", "Needs you"),
            ("restarting", "Restarting"),
            ("error", "Error"),
        ];
        for (state, label) in cases {
            assert_eq!(tray_status(state).unwrap().tooltip, format!("Gentle Dot — {label}"), "{state}");
        }
    }

    #[test]
    fn picks_a_menu_bar_glyph_for_every_agent_state() {
        let cases = [
            ("starting", TrayGlyph::Unavailable),
            ("idle", TrayGlyph::Ready),
            ("thinking", TrayGlyph::Working),
            ("working", TrayGlyph::Working),
            ("needs_you", TrayGlyph::NeedsYou),
            ("restarting", TrayGlyph::Unavailable),
            ("error", TrayGlyph::Unavailable),
        ];
        for (state, glyph) in cases {
            assert_eq!(tray_status(state).unwrap().glyph, glyph, "{state}");
        }
    }

    #[test]
    fn every_glyph_is_a_36_px_png_for_the_18_pt_menu_bar() {
        let glyphs = [TrayGlyph::Ready, TrayGlyph::Working, TrayGlyph::NeedsYou, TrayGlyph::Unavailable];
        for glyph in glyphs {
            let png = glyph.png();
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{glyph:?}");
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            assert_eq!((width, height), (36, 36), "{glyph:?}");
        }
        // Each state has its own image.
        for (i, a) in glyphs.iter().enumerate() {
            for b in &glyphs[i + 1..] {
                assert_ne!(a.png(), b.png(), "{a:?} and {b:?}");
            }
        }
    }

    #[test]
    fn rejects_unknown_states() {
        assert_eq!(tray_status("sleeping"), None);
        assert_eq!(tray_status(""), None);
    }
}
