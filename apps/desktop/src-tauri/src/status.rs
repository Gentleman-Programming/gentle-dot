//! Menu bar tooltip and title marker for each `AgentState` (protocol v1).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayStatus {
    pub tooltip: String,
    /// Short text shown next to the menu bar icon; empty when idle.
    pub title: &'static str,
}

/// `None` for a state the protocol does not define.
pub fn tray_status(state: &str) -> Option<TrayStatus> {
    let (label, title) = match state {
        "starting" => ("Starting", "◌"),
        "idle" => ("Ready", ""),
        "thinking" => ("Thinking", "•"),
        "working" => ("Working", "•"),
        "needs_you" => ("Needs you", "!"),
        "restarting" => ("Restarting", "◌"),
        "error" => ("Error", "×"),
        _ => return None,
    };
    Some(TrayStatus { tooltip: format!("Gentle Dot — {label}"), title })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_agent_state() {
        let cases = [
            ("starting", "Starting", "◌"),
            ("idle", "Ready", ""),
            ("thinking", "Thinking", "•"),
            ("working", "Working", "•"),
            ("needs_you", "Needs you", "!"),
            ("restarting", "Restarting", "◌"),
            ("error", "Error", "×"),
        ];
        for (state, label, title) in cases {
            let status = tray_status(state).unwrap();
            assert_eq!(status.tooltip, format!("Gentle Dot — {label}"), "{state}");
            assert_eq!(status.title, title, "{state}");
        }
    }

    #[test]
    fn rejects_unknown_states() {
        assert_eq!(tray_status("sleeping"), None);
        assert_eq!(tray_status(""), None);
    }
}
