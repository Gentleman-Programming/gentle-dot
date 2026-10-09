use super::fake::{Answer, FakePrompt};
use super::*;
use serde_json::json;

fn field(name: &str, value: serde_json::Value) -> PreviewField {
    PreviewField { name: name.into(), value }
}

fn request(preview: Vec<PreviewField>) -> ApprovalRequest {
    ApprovalRequest { connector: "Slack".into(), action: "send message".into(), preview }
}

fn approvals(prompt: &Arc<FakePrompt>, timeout: Duration) -> Approvals {
    Approvals::new(prompt.clone(), timeout)
}

const LONG: Duration = Duration::from_secs(5);

#[test]
fn the_dialog_names_the_connector_the_action_and_every_field() {
    let dialog = ApprovalDialog::new(
        &request(vec![
            field("channel", json!("#general")),
            field("text", json!("Ship it\nnow")),
            field("blocks", json!([{"type": "divider"}])),
            field("unfurl", json!(false)),
        ]),
        Duration::from_secs(120),
    );
    assert_eq!(dialog.title, "Allow Slack to send message?");
    assert_eq!(
        dialog.message,
        "The assistant wants to send message in Slack.\n\n\
channel: #general\n\
text: Ship it\n  now\n\
blocks: [\n    {\n      \"type\": \"divider\"\n    }\n  ]\n\
unfurl: false\n\n\
If you do not answer within 2 minutes, it is declined."
    );
}

#[test]
fn an_action_without_arguments_says_so() {
    let dialog = ApprovalDialog::new(&request(vec![]), Duration::from_secs(90));
    assert!(dialog.message.contains("\n\n(no details)\n\n"), "{}", dialog.message);
    assert!(dialog.message.ends_with("If you do not answer within 90 seconds, it is declined."), "{}", dialog.message);
}

#[test]
fn a_long_value_is_cut_with_a_clear_marker() {
    let long = "x".repeat(VALUE_LIMIT + 250);
    let dialog = ApprovalDialog::new(&request(vec![field("text", json!(long)), field("to", json!("ana"))]), LONG);
    let expected = format!("text: {}… (250 more characters)\nto: ana", "x".repeat(VALUE_LIMIT));
    assert!(dialog.message.contains(&expected), "{}", dialog.message);
}

#[test]
fn many_long_fields_share_the_budget_but_every_name_shows() {
    let fields: Vec<_> = (0..200).map(|i| field(&format!("field{i}"), json!("y".repeat(500)))).collect();
    let dialog = ApprovalDialog::new(&request(fields), LONG);
    for i in 0..200 {
        assert!(dialog.message.contains(&format!("\nfield{i}: ")), "field{i} is missing");
    }
    let per_value = (PREVIEW_BUDGET / 200).max(MIN_VALUE_LIMIT);
    assert_eq!(per_value, MIN_VALUE_LIMIT);
    let cut = format!("{}… ({} more characters)", "y".repeat(per_value), 500 - per_value);
    assert!(dialog.message.contains(&cut), "{}", &dialog.message[..400]);
}

#[test]
fn clip_cuts_by_characters_or_lines_and_counts_what_is_hidden() {
    assert_eq!(clip("short", 10, 3), "short");
    assert_eq!(clip("ñandú🦀", 3, 3), "ñan… (3 more characters)");
    assert_eq!(clip("a\nb\nc\nd", 100, 2), "a\nb… (4 more characters)");
    assert_eq!(clip("", 0, 0), "");
}

#[test]
fn hidden_and_direction_characters_are_shown_as_escapes() {
    assert_eq!(sanitize("pay\u{202e}evil", false), "pay\\u{202e}evil");
    assert_eq!(sanitize("a\u{200b}b\u{feff}c\u{7}d", false), "a\\u{200b}b\\u{feff}c\\u{7}d");
    assert_eq!(sanitize("line\r\nnext\ttab", false), "line\nnext\ttab");
    assert_eq!(sanitize("line\r\nnext\ttab", true), "line next tab");
    assert_eq!(sanitize("plain ñ 🦀", true), "plain ñ 🦀");
}

#[test]
fn names_are_one_line_and_short() {
    let req = ApprovalRequest {
        connector: format!("Evil\nAllow everything {}", "z".repeat(100)),
        action: "send\u{202e}".into(),
        preview: vec![field("a\nb", json!("v"))],
    };
    let dialog = ApprovalDialog::new(&req, LONG);
    assert!(!dialog.title.contains('\n'), "{}", dialog.title);
    assert!(dialog.title.starts_with("Allow Evil Allow everything zzz"), "{}", dialog.title);
    assert!(dialog.title.contains("… (") && dialog.title.contains("send\\u{202e}?"), "{}", dialog.title);
    assert!(dialog.message.contains("\na b: v\n"), "{}", dialog.message);
}

#[test]
fn the_approval_buttons_default_to_decline() {
    assert_eq!(APPROVAL_CHOICE, Choice { allow: "Allow", refuse: "Decline" });
    match APPROVAL_CHOICE.buttons() {
        tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(first, _) => assert_eq!(first, "Decline"),
        other => panic!("unexpected buttons: {other:?}"),
    }
}

#[test]
fn allow_approves_and_decline_declines() {
    let prompt = Arc::new(FakePrompt::new([Answer::After(Duration::ZERO, true), Answer::After(Duration::ZERO, false)]));
    let approvals = approvals(&prompt, LONG);
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Approved);
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
    assert_eq!(prompt.shown_titles(), vec!["Allow Slack to send message?"; 2]);
}

#[test]
fn no_answer_in_time_declines_and_closes_the_dialog() {
    let prompt = Arc::new(FakePrompt::new([Answer::Hang]));
    let approvals = approvals(&prompt, Duration::from_millis(100));
    let started = Instant::now();
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
    assert!(started.elapsed() >= Duration::from_millis(100));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(prompt.dismissals(), 1);
}

#[test]
fn a_late_click_on_a_stale_dialog_approves_nothing() {
    // The hanging dialog "clicks Allow" once dismissed; the next request must not see it.
    let prompt = Arc::new(FakePrompt::new([Answer::Hang, Answer::After(Duration::ZERO, false)]));
    let approvals = approvals(&prompt, Duration::from_millis(100));
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
    let approvals = Approvals { timeout: LONG, ..approvals };
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
    assert_eq!(prompt.shown_titles().len(), 2);
}

#[test]
fn only_one_dialog_shows_at_a_time() {
    let hold = Duration::from_millis(40);
    let prompt = Arc::new(FakePrompt::new([
        Answer::After(hold, true),
        Answer::After(hold, false),
        Answer::After(hold, true),
        Answer::After(hold, true),
    ]));
    let approvals = Arc::new(approvals(&prompt, LONG));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let approvals = approvals.clone();
            std::thread::spawn(move || approvals.confirm(&request(vec![])))
        })
        .collect();
    let decisions: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(prompt.most_at_once(), 1);
    assert_eq!(prompt.shown_titles().len(), 4);
    assert_eq!(decisions.iter().filter(|d| **d == Decision::Approved).count(), 3);
}

#[test]
fn a_request_still_waiting_for_the_screen_at_its_deadline_is_declined_unseen() {
    let prompt = Arc::new(FakePrompt::new([Answer::After(Duration::from_millis(300), true)]));
    let first = Arc::new(approvals(&prompt, LONG));
    let second = Approvals { prompt: first.prompt.clone(), timeout: Duration::from_millis(80), gate: first.gate.clone() };
    let showing = {
        let first = first.clone();
        std::thread::spawn(move || first.confirm(&request(vec![])))
    };
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(second.confirm(&request(vec![])), Decision::Declined);
    assert_eq!(prompt.shown_titles().len(), 1, "the second dialog never showed");
    assert_eq!(prompt.dismissals(), 0, "the first dialog was left alone");
    assert_eq!(showing.join().unwrap(), Decision::Approved);
}

#[test]
fn a_dialog_that_fails_declines() {
    struct Broken;
    impl Prompt for Broken {
        fn ask(&self, _: &ApprovalDialog) -> bool {
            panic!("no dialog");
        }
        fn dismiss(&self) {}
    }
    let approvals = Approvals::new(Arc::new(Broken), LONG);
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
    // The screen is free again.
    assert_eq!(approvals.confirm(&request(vec![])), Decision::Declined);
}

#[test]
fn requests_read_the_daemon_json() {
    let request: ApprovalRequest = serde_json::from_value(json!({
        "connector": "Notion",
        "action": "create pages",
        "preview": [{"name": "title", "value": "Plan"}, {"name": "parent", "value": {"page_id": "1"}}]
    }))
    .unwrap();
    assert_eq!(request.preview[1], field("parent", json!({"page_id": "1"})));
}
