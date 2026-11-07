//! Windows-only native prompts. No generic plugin label/order assumptions and no
//! comctl32 activation-context dependency. Each prompt owns a thread-local modal hook.
use super::*;
use std::cell::Cell;
use windows::{core::PCWSTR, Win32::{Foundation::{LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{Input::KeyboardAndMouse::{VK_ESCAPE, VK_RETURN}, WindowsAndMessaging::*}}};

pub(super) const GRANT: &str = "Allow Gentle Dot to see and control this Windows desktop for 30 minutes?\n\nChoose OK explicitly to allow, or Cancel to deny. Return and Escape deny.";
pub(super) const YOLO: &str = "Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, for up to 1 hour. A separate session grant is still required. Stop and Alt+Shift+Escape still work.\n\nChoose OK explicitly to turn it on, or Cancel to deny. Return and Escape deny.";
thread_local! { static KEYBOARD_REFUSAL: Cell<bool> = const { Cell::new(false) }; }

fn refusing_key(message: u32, key: usize) -> bool {
    matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN | WM_CHAR | WM_KEYUP | WM_SYSKEYUP)
        && (key == usize::from(VK_RETURN.0) || key == usize::from(VK_ESCAPE.0))
}

// Signature comes from the pinned HOOKPROC declaration. Current-thread WH_MSGFILTER
// only, not a global keyboard hook or an input authority. No allocation/panic/locks in
// this callback. Even failed EndDialog cannot turn a consumed key into authorization.
unsafe extern "system" fn refuse_keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == MSGF_MESSAGEBOX as i32 && lparam.0 != 0 {
        // SAFETY: WH_MSGFILTER supplies a live MSG for the duration of this callback.
        let message = unsafe { &*(lparam.0 as *const MSG) };
        if refusing_key(message.message, message.wParam.0) {
            KEYBOARD_REFUSAL.with(|refused| refused.set(true));
            // SAFETY: this message belongs to the native modal message box on THIS
            // thread. GetAncestor returns its root; a null/error result cannot approve.
            let root = unsafe { GetAncestor(message.hwnd, GA_ROOT) };
            if !root.0.is_null() { let _ = unsafe { EndDialog(root, IDCANCEL.0 as isize) }; }
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub(super) struct NativeDialogs(pub(super) Arc<Runtime>);
impl NativeDialogs {
    fn ask(&self, message: &str) -> Option<PromptStamp> {
        let runtime = &self.0;
        if !runtime.available() || message.contains('\0') || message.encode_utf16().count() > 8192 {
            return None;
        }
        // Atomic, nonblocking ownership excludes capture/input and other native
        // prompts without holding a coordinator mutex across the modal message loop.
        let Ok(_flight) = Flight::acquire(&runtime.flight) else { return None };
        let stamp = runtime.grants.stamp(runtime.control.epoch());
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Gentle Dot — computer control".encode_utf16().chain(Some(0)).collect();
        KEYBOARD_REFUSAL.with(|refused| refused.set(false));
        // SAFETY: callback has the exact typed HOOKPROC ABI, lives in this module for
        // process lifetime, and is installed only on the calling prompt-owning thread.
        let hook = match unsafe { SetWindowsHookExW(WH_MSGFILTER, Some(refuse_keyboard), None, GetCurrentThreadId()) } {
            Ok(hook) => hook,
            Err(_) => return None, // no unfiltered fallback
        };
        // SAFETY: owned null-terminated UTF-16 stays live through this synchronous call.
        // OK/Cancel's SECOND/default button refuses. Close is IDCANCEL; 0 is failure.
        // Hook consumes Return/Escape even if the user has focused the OK button.
        let response = unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()),
            MB_OKCANCEL | MB_DEFBUTTON2 | MB_ICONWARNING) };
        let removed = unsafe { UnhookWindowsHookEx(hook) }.is_ok();
        if !removed { runtime.fail(); }
        let keyboard_refused = KEYBOARD_REFUSAL.with(Cell::get);
        (allows(response, keyboard_refused, removed)
            && runtime.available() && runtime.grants.current(stamp, runtime.control.epoch())).then_some(stamp)
    }
}
fn allows(response: MESSAGEBOX_RESULT, keyboard_refused: bool, removed: bool) -> bool {
    response == IDOK && !keyboard_refused && removed
}
impl computer::Dialogs for NativeDialogs {
    fn ask_grant(&self) -> bool {
        self.ask(GRANT).is_some_and(|stamp| self.0.grants.approve(stamp))
    }
    fn confirm(&self, message: &str) -> bool {
        self.ask(&format!("{message}\n\nChoose OK explicitly to allow this action, or Cancel to deny. Return and Escape deny.")).is_some()
    }
    fn ask_yolo(&self) -> bool { self.ask(YOLO).is_some() }
}

// AUTHORED_UNEXECUTED: pure result/key rules, not native modal-loop/hook proof.
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancel_close_failure_and_keyboard_never_authorize() {
        for response in [IDCANCEL, IDCLOSE, MESSAGEBOX_RESULT(0), IDNO] {
            assert!(!allows(response, false, true));
        }
        assert!(allows(IDOK, false, true));
        assert!(!allows(IDOK, true, true));
        assert!(!allows(IDOK, false, false));
    }
    #[test]
    fn return_and_escape_are_refused_even_if_ok_has_focus() {
        for message in [WM_KEYDOWN, WM_SYSKEYDOWN, WM_CHAR, WM_KEYUP, WM_SYSKEYUP] {
            assert!(refusing_key(message, usize::from(VK_RETURN.0)));
            assert!(refusing_key(message, usize::from(VK_ESCAPE.0)));
            assert!(!refusing_key(message, usize::from(b' ')));
        }
        assert!(!refusing_key(WM_COMMAND, IDOK.0 as usize));
    }
    #[test]
    fn prompts_keep_separate_explicit_time_limited_authority() {
        assert!(GRANT.contains("30 minutes"));
        assert!(YOLO.contains("up to 1 hour") && YOLO.contains("separate session grant"));
        assert!(YOLO.contains("Alt+Shift+Escape") && YOLO.contains("Stop"));
    }
}
