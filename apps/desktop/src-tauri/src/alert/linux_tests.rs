//! Linux alert checks (T3, S3): the shape the user sees — one caption and one body, with the app
//! name drawn only once — and the answer mapping the production dialog uses.
//!
//! A live dialog needs a GTK main thread and a display, so nothing here opens a window: these are
//! the production helpers the builder itself calls (content, buttons, default response, and the
//! response-to-answer mapping), and the builder's own compilation covers the widget wiring. The
//! one visual fact a headless test cannot observe — that GTK draws exactly these two strings — is
//! reported as unverified instead of asserted here; the old duplicate came from rfd 0.16 handing
//! the title to both `gtk_message_dialog_new` and `gtk_window_set_title`, which this builder never
//! does.

use super::linux::{
    allows, buttons, content, default_response, dialog, release, ALLOW_RESPONSE, REFUSE_RESPONSE,
};
use crate::alert::Choice;
use crate::computer::linux::dialogs::{CONFIRM_CHOICE, GRANT_CHOICE, YOLO_CHOICE, YOLO_TEXT};
use crate::computer::GLOBAL_GRANT_TEXT;
use gtk::prelude::*;
use gtk::ResponseType;

/// The caption is the whole app title and the body is the whole message: two strings, and no
/// heading field for a second copy of the title (S3).
#[test]
fn the_dialog_shows_the_app_name_once_as_its_caption_and_the_message_as_its_body() {
    for message in [GLOBAL_GRANT_TEXT, YOLO_TEXT, "Allow Gentle Dot to move the mouse?"] {
        let shown = content("Gentle Dot", message);
        assert_eq!(shown.caption, "Gentle Dot");
        assert_eq!(shown.body, message);
        // The body is the message itself, never a second copy of the title.
        assert_ne!(shown.body, shown.caption);
    }
}

/// What the dialog asks with is what the callers pass: the same copy and the same two labels.
#[test]
fn the_buttons_are_the_callers_choice_in_refusing_then_allowing_order() {
    for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
        let [refuse, allow] = buttons(choice);
        assert_eq!(refuse.0, choice.refuse);
        assert_eq!(allow.0, choice.allow);
        assert_ne!(refuse.1, allow.1);
    }
}

#[test]
fn only_the_allowing_buttons_response_allows_and_every_other_answer_refuses() {
    for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
        let [refuse, allow] = buttons(choice);
        assert!(allows(choice, Some(allow.1)));
        assert!(!allows(choice, Some(refuse.1)));
        // Escape and the close button answer `DELETE_EVENT`; a destroyed or failed dialog never
        // answers at all; every standard, custom, and unknown response refuses.
        for response in [
            ResponseType::None,
            ResponseType::Reject,
            ResponseType::Accept,
            ResponseType::DeleteEvent,
            ResponseType::Ok,
            ResponseType::Cancel,
            ResponseType::Close,
            ResponseType::Yes,
            ResponseType::No,
            ResponseType::Apply,
            ResponseType::Help,
            ResponseType::Other(0),
            ResponseType::Other(2002),
        ] {
            assert!(!allows(choice, Some(response)), "{choice:?} {response:?}");
        }
        assert!(!allows(choice, None));
    }
}

/// The refusing button is the default response (the old plugin dialog set no default). The built
/// widget's real default is checked by [`the_built_dialog_defaults_to_the_refusing_button`].
#[test]
fn the_default_response_names_the_refusing_button() {
    for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
        let [refuse, allow] = buttons(choice);
        assert_eq!(default_response(), refuse.1);
        assert_ne!(default_response(), allow.1);
        assert!(!allows(choice, Some(default_response())));
    }
}

/// GTK's own responses are negative, so our custom ids can never be produced by a standard
/// button, Escape, or a close: only the allowing button carries the allowing answer.
#[test]
fn the_button_responses_cannot_collide_with_gtks_own() {
    assert!(ALLOW_RESPONSE != REFUSE_RESPONSE);
    for response in [
        ResponseType::None,
        ResponseType::Reject,
        ResponseType::Accept,
        ResponseType::DeleteEvent,
        ResponseType::Ok,
        ResponseType::Cancel,
        ResponseType::Close,
        ResponseType::Yes,
        ResponseType::No,
        ResponseType::Apply,
        ResponseType::Help,
    ] {
        assert_ne!(ALLOW_RESPONSE, response);
        assert_ne!(REFUSE_RESPONSE, response);
    }
}

/// Two identical labels can never allow, exactly as on macOS and with the dialog plugin.
#[test]
fn identical_labels_never_allow() {
    let same = Choice { allow: "OK", refuse: "OK" };
    let [refuse, allow] = buttons(same);
    assert!(!allows(same, Some(allow.1)));
    assert!(!allows(same, Some(refuse.1)));
    assert!(!allows(same, None));
}

/// GTK applies a default response to the last *existing* action widget carrying it, so the real
/// default can only be proven on a built dialog — and GTK keeps every toplevel in its own list, so
/// the release path must actually destroy it. This builds the production dialog and inspects it
/// without ever showing or running it: no surface is created, nothing appears on the user's
/// desktop, and no keystroke or pointer event is injected.
#[test]
fn the_built_dialog_defaults_to_the_refusing_button_and_shows_one_body() {
    if !gtk_ready() {
        return;
    }
    let toplevels = gtk::Window::list_toplevels().len();
    for choice in [GRANT_CHOICE, CONFIRM_CHOICE, YOLO_CHOICE] {
        let dialog = dialog(&content("Gentle Dot", GLOBAL_GRANT_TEXT), choice);
        let [refuse, allow] = buttons(choice);
        let weak = dialog.downgrade();
        let destructions = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen_destroy = destructions.clone();
        dialog.connect_destroy(move |_| seen_destroy.set(seen_destroy.get() + 1));
        // A toplevel joins GTK's window list when it is built, not when it is shown.
        assert_eq!(gtk::Window::list_toplevels().len(), toplevels + 1, "{choice:?}");

        let default = dialog.default_widget().expect("the dialog has a default widget");
        assert_eq!(dialog.response_for_widget(&default), default_response(), "{choice:?}");
        assert_ne!(dialog.response_for_widget(&default), allow.1, "{choice:?}");
        let button = default.downcast::<gtk::Button>().expect("the default is a button");
        assert_eq!(button.label().map(|label| label.to_string()).as_deref(), Some(choice.refuse));

        // The dialog's own answer mapping through GTK's action-widget wiring, both ends: a click on
        // the default (refusing) button answers the refusing response and never the allowing one,
        // and the allowing button answers only the allowing response.
        // `gtk_window_activate_default` emits nothing on an unmapped window, so this drives each
        // button's own `clicked` signal — the last step of the click/Return activation path.
        let answers = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = answers.clone();
        dialog.connect_response(move |_, response| seen.borrow_mut().push(response));
        let allow_button = dialog
            .widget_for_response(ALLOW_RESPONSE)
            .expect("the allowing button")
            .downcast::<gtk::Button>()
            .expect("a button");
        assert_eq!(allow_button.label().map(|label| label.to_string()).as_deref(), Some(choice.allow));
        button.clicked();
        allow_button.clicked();
        assert_eq!(*answers.borrow(), vec![refuse.1, allow.1], "{choice:?}");

        // The title is drawn exactly once and the body exactly once: GTK draws a dialog's caption
        // only with `gtk-dialogs-use-header` on, and when it does not the dialog draws the app name
        // itself instead. The count is asserted, not the arrangement, so no arrangement can ever
        // show the name twice or leave it invisible.
        assert_eq!(dialog.title().map(|title| title.to_string()).as_deref(), Some("Gentle Dot"));
        let labels: Vec<String> = dialog
            .content_area()
            .children()
            .into_iter()
            .filter_map(|widget| widget.downcast::<gtk::Label>().ok())
            .map(|label| label.text().to_string())
            .collect();
        let copies = labels.iter().filter(|label| label.as_str() == "Gentle Dot").count();
        assert_eq!(copies, 1, "{choice:?}: the title must be drawn exactly once, got {labels:?}");
        assert_eq!(
            labels.iter().filter(|label| label.as_str() == GLOBAL_GRANT_TEXT).count(),
            1,
            "{choice:?}: the body must be drawn exactly once, got {labels:?}"
        );

        // The cleanup `show` runs after `run`: the same call, on the same unshown widget.
        release(&dialog);
        assert_eq!(gtk::Window::list_toplevels().len(), toplevels, "{choice:?}: a toplevel lingers");
        assert_eq!(destructions.get(), 1, "{choice:?}: the dialog was not destroyed");
        drop(dialog);
        assert!(weak.upgrade().is_none(), "{choice:?}: the released dialog is still alive");
    }
}

/// GTK may only be initialized on one thread and needs a display. This never starts a display:
/// without one, and if GTK cannot initialize, the widget test reports the skip instead of failing.
fn gtk_ready() -> bool {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        eprintln!("skipped: no DISPLAY or WAYLAND_DISPLAY for GTK");
        return false;
    }
    if gtk::is_initialized() && !gtk::is_initialized_main_thread() {
        eprintln!("skipped: GTK was initialized on another thread");
        return false;
    }
    if gtk::init().is_err() {
        eprintln!("skipped: GTK could not initialize");
        return false;
    }
    true
}
