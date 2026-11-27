//! Sealed native launch inputs backed by an admitted Windows x64 runtime tree.

use super::windows_split_tree::{root_spelling, PinnedTree};
use std::num::NonZeroU16;
use std::path::PathBuf;

#[derive(Debug)]
pub(super) enum PlanError {
    StatePath,
    StateOverlap,
}

pub(super) struct LaunchPlan {
    program: String,
    args: [String; 1],
    data_dir: PathBuf,
    env: [(String, String); 4],
    _tree: PinnedTree,
}

impl LaunchPlan {
    pub(super) fn program(&self) -> &str { &self.program }
    pub(super) fn args(&self) -> &[String] { &self.args }
    pub(super) fn data_dir(&self) -> &std::path::Path { &self.data_dir }
    pub(super) fn env(&self) -> &[(String, String)] { &self.env }

    /// The trusted caller supplies separate, already writable state.
    /// This only checks spelling and lexical separation; it does not inspect
    /// state, provision directories, or establish filesystem identity or ACLs.
    pub(super) fn new(tree: PinnedTree, state: PathBuf, port: NonZeroU16) -> Result<Self, PlanError> {
        let root = tree.root();
        let runtime = root.to_str().expect("admitted root spelling");
        let data = root_spelling(&state).map_err(|_| PlanError::StatePath)?;
        if at_or_below(data, runtime) || at_or_below(runtime, data) {
            return Err(PlanError::StateOverlap);
        }

        // Both entry points are exact, required members of every admitted inventory.
        // The environment is complete plan data, not overrides for an inherited environment.
        Ok(Self {
            program: format!(r"{runtime}\node\node.exe"),
            args: [format!(r"{runtime}\daemon\cli.mjs")],
            env: [
                ("GENTLE_DOT_RUNTIME".into(), runtime.to_owned()),
                ("GENTLE_DOT_DATA_DIR".into(), data.to_owned()),
                ("GENTLE_DOT_PORT".into(), port.to_string()),
                ("PATH".into(), format!(r"{runtime}\bin;{runtime}\node")),
            ],
            data_dir: state,
            _tree: tree,
        })
    }
}

// Both inputs have already passed the same ASCII DOS spelling check.
fn at_or_below(path: &str, ancestor: &str) -> bool {
    let mut parts = path.split('\\');
    ancestor.split('\\').all(|name| parts.next().is_some_and(|part| part.eq_ignore_ascii_case(name)))
}
