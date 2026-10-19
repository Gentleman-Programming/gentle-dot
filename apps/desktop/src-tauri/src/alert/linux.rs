//! Linux native alert (T3, S3): the app's own GTK dialog, asked off the main thread.
//!
//! The dialog plugin's GTK backend (rfd 0.16) passes the title to `gtk_message_dialog_new` as the
//! dialog's primary text *and* to `gtk_window_set_title`, so the app name was drawn twice above the
//! message. This builder draws the title exactly once, as one bold heading label, and keeps the
//! window title only for the compositor's own window list.
//!
//! The heading is unconditional on purpose: `gtk-dialogs-use-header` reads *true* in this
//! environment and GTK still draws no caption for a bare `gtk::Dialog` on Wayland, so gating the
//! heading on that setting left the dialog with no visible title at all — the live report that
//! prompted this. The one drawn copy is the heading, which no decoration can duplicate.
//!
//! Only the allowing button's response allows. The refusing button is the dialog's default (Return),
//! Escape and closing answer `DELETE_EVENT`, and a dialog that never ran or never answered refuses.
//! GTK may only be touched on the thread that initialized it, so a call from that thread refuses at
//! once (it would block the loop the dialog needs) and a call from a worker marshals the dialog
//! through `run_on_main_thread` and waits for the answer. Every answered dialog is then taken off
//! screen and destroyed ([`release`]): GTK keeps its own reference to each toplevel, so a window
//! outlives a dropped Rust handle until `gtk_widget_destroy` deletes it.

use super::Choice;
use gtk::glib::Propagation;
use gtk::prelude::*;
use std::sync::mpsc;
use tauri::AppHandle;

/// The refusing button's response, and the dialog's default: unlike GTK's own negative ids,
/// nothing else in the dialog can produce it.
pub(super) const REFUSE_RESPONSE: gtk::ResponseType = gtk::ResponseType::Other(2000);
/// The allowing button's response: the only answer that allows.
pub(super) const ALLOW_RESPONSE: gtk::ResponseType = gtk::ResponseType::Other(2001);

/// What the dialog shows: the title drawn exactly once as a heading, plus one body label (S3).
pub(super) struct Content {
    pub(super) caption: String,
    pub(super) body: String,
}

pub(super) fn content(title: &str, message: &str) -> Content {
    Content { caption: title.to_owned(), body: message.to_owned() }
}

/// The default button: the refusing one, so Return refuses (the old plugin dialog set no default).
/// GTK applies a default response to the last *existing* action widget carrying it, so [`dialog`]
/// sets this after its buttons are added.
pub(super) fn default_response() -> gtk::ResponseType {
    REFUSE_RESPONSE
}

/// The two buttons in the order they are added, with the response each one answers.
pub(super) fn buttons(choice: Choice) -> [(&'static str, gtk::ResponseType); 2] {
    [(choice.refuse, REFUSE_RESPONSE), (choice.allow, ALLOW_RESPONSE)]
}

/// True only for the allowing button's response; `None` is a dialog that never answered.
pub(super) fn allows(choice: Choice, response: Option<gtk::ResponseType>) -> bool {
    choice.allow != choice.refuse && response == Some(ALLOW_RESPONSE)
}

/// Shows the alert and waits for the answer. Blocks, so it never runs on the main thread (there it
/// refuses at once).
pub fn ask(app: &AppHandle, title: &str, message: &str, choice: Choice) -> bool {
    // True only on the thread that initialized GTK, which is the thread Tauri runs its loop on: the
    // Linux counterpart of macOS's `MainThreadMarker`. Asking there would block the loop the dialog
    // needs.
    if gtk::is_initialized_main_thread() {
        eprintln!("gentle-dot: a confirmation was asked on the main thread, so it was refused");
        return false;
    }
    let content = content(title, message);
    let (answer, answered) = mpsc::channel();
    let scheduled = app.run_on_main_thread(move || {
        let _ = answer.send(show(&content, choice));
    });
    if scheduled.is_err() {
        return false;
    }
    // The task dropped without running (the app is quitting) reads as no answer.
    allows(choice, answered.recv().ok().flatten())
}

/// On the main thread: shows the modal dialog and answers with its response. Off the thread that
/// initialized GTK (where `Dialog::new` would panic), or with GTK never initialized, it answers
/// nothing, which refuses.
fn show(content: &Content, choice: Choice) -> Option<gtk::ResponseType> {
    if !gtk::is_initialized_main_thread() {
        return None;
    }
    let dialog = dialog(content, choice);
    dialog.show_all();
    let response = dialog.run();
    release(&dialog);
    Some(response)
}

/// Takes an answered dialog off screen and destroys it, so no hidden toplevel outlives a question.
/// `show` calls this on the GTK main thread as soon as `run` returns, and the tests call it on an
/// unshown production dialog.
pub(super) fn release(dialog: &gtk::Dialog) {
    // Off screen at once, before GTK's own teardown path runs.
    dialog.hide();
    // A toplevel lives in GTK's own window list, which holds a reference of its own, and GTK deletes
    // a window only through `gtk_widget_destroy`: hiding it or dropping the Rust handle leaves the
    // window alive. gtk-rs marks this call `unsafe` because the widget must not be used afterwards,
    // which is exactly the contract kept here.
    // SAFETY: on the GTK main thread (`show` refuses to run anywhere else, and the tests initialize
    // GTK on the test thread); `run` already returned, so no modal loop or signal frame borrows this
    // dialog; GTK's own toplevel reference keeps the GObject alive across the call; and neither this
    // function nor the caller touches the widget again — the handle is only dropped, which releases
    // the reference gtk-rs owns.
    unsafe { dialog.destroy() };
}

/// The dialog itself: one bold heading label with the app name, one wrapping body label, and the
/// window title set only for the compositor's window list (GTK draws no caption for this dialog on
/// Wayland, so the heading is the single drawn copy).
pub(super) fn dialog(content: &Content, choice: Choice) -> gtk::Dialog {
    let dialog = gtk::Dialog::new();
    dialog.set_title(&content.caption);
    dialog.set_modal(true);
    dialog.set_resizable(false);
    dialog.set_border_width(12);
    let heading = gtk::Label::new(None);
    // Escaped even though the caption is ours: a label must never read it as markup.
    heading.set_markup(&format!("<b>{}</b>", gtk::glib::markup_escape_text(&content.caption)));
    heading.set_xalign(0.0);
    dialog.content_area().pack_start(&heading, false, false, 0);
    let body = gtk::Label::new(Some(&content.body));
    body.set_line_wrap(true);
    body.set_max_width_chars(60);
    body.set_xalign(0.0);
    // The plugin made the message selectable; keep it copyable as it was.
    body.set_selectable(true);
    dialog.content_area().pack_start(&body, true, true, 0);
    for (label, response) in buttons(choice) {
        dialog.add_button(label, response);
    }
    // Only after the buttons exist: `gtk_dialog_set_default_response` makes the last existing
    // action widget with that response the default, so setting it before `add_button` would leave
    // the dialog with no default at all.
    dialog.set_default_response(default_response());
    // The close button answers the refusing `DELETE_EVENT` instead of letting GtkDialog's own
    // handler respond and destroy the window: every way out refuses, and `run` returns with a
    // widget that is still alive to be hidden and released.
    dialog.connect_delete_event(|dialog, _| {
        dialog.response(gtk::ResponseType::DeleteEvent);
        Propagation::Stop
    });
    dialog
}
