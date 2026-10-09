//! A scripted [`Prompt`] that records what it showed and how many dialogs were up at once.

use super::{ApprovalDialog, Prompt};
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub enum Answer {
    /// Clicks after holding the dialog for a while.
    After(Duration, bool),
    /// Never answers until dismissed, then clicks Allow (a late click on a stale dialog). The
    /// n-th hanging dialog waits for the n-th dismissal, even one that came before it showed.
    Hang,
}

#[derive(Default)]
pub struct FakePrompt {
    answers: Mutex<VecDeque<Answer>>,
    pub shown: Mutex<Vec<ApprovalDialog>>,
    state: Mutex<Showing>,
    dismissed: Condvar,
}

#[derive(Default)]
struct Showing {
    now: usize,
    most: usize,
    dismissals: usize,
    hangs: usize,
}

impl FakePrompt {
    pub fn new(answers: impl IntoIterator<Item = Answer>) -> Self {
        FakePrompt { answers: Mutex::new(answers.into_iter().collect()), ..Default::default() }
    }

    pub fn most_at_once(&self) -> usize {
        self.state.lock().unwrap().most
    }

    pub fn dismissals(&self) -> usize {
        self.state.lock().unwrap().dismissals
    }

    pub fn shown_titles(&self) -> Vec<String> {
        self.shown.lock().unwrap().iter().map(|d| d.title.clone()).collect()
    }
}

impl Prompt for FakePrompt {
    fn ask(&self, dialog: &ApprovalDialog) -> bool {
        self.shown.lock().unwrap().push(dialog.clone());
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or(Answer::After(Duration::ZERO, false));
        {
            let mut state = self.state.lock().unwrap();
            state.now += 1;
            state.most = state.most.max(state.now);
        }
        let allowed = match answer {
            Answer::After(hold, allowed) => {
                std::thread::sleep(hold);
                allowed
            }
            Answer::Hang => {
                let mut state = self.state.lock().unwrap();
                state.hangs += 1;
                let turn = state.hangs;
                drop(self.dismissed.wait_while(state, |s| s.dismissals < turn).unwrap());
                true
            }
        };
        self.state.lock().unwrap().now -= 1;
        allowed
    }

    fn dismiss(&self) {
        self.state.lock().unwrap().dismissals += 1;
        self.dismissed.notify_all();
    }
}
