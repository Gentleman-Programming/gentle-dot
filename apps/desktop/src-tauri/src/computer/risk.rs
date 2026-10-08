//! Which actions need a native per-action confirmation (S24.4). A declared intent only adds
//! checks: an action is risky when the target is risky or the intent is.

/// Words that make an action risky, in English and Spanish. `place order` is a phrase.
const RISKY: &[&str] = &[
    "send", "pay", "buy", "purchase", "delete", "remove", "submit", "confirm", "transfer", "place order",
    "checkout", "enviar", "pagar", "comprar", "eliminar", "borrar", "confirmar", "transferir",
];

/// Extra words that make a text field send-like (a chat or comment composer), where
/// Return usually sends.
const SEND_LIKE_FIELD: &[&str] = &[
    "message", "messages", "reply", "comment", "chat", "post", "mensaje", "mensajes", "responder", "respuesta",
    "comentario", "comentar", "publicar",
];

/// Roles a click can press: buttons, menu items, and links (web pages often render buttons as links).
const PRESSABLE_ROLES: &[&str] = &["AXButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink"];
const TEXT_INPUT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox"];

/// What the Accessibility API reports about an element.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AxElement {
    pub role: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
}

/// The focused element and its window's default button, if any.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Focus {
    pub element: AxElement,
    pub is_default_button: bool,
    pub default_button: Option<AxElement>,
}

/// The facts the classifier needs about an action.
#[derive(Debug, Clone, Copy)]
pub enum Act<'a> {
    /// A click: the element under the point first, then its ancestors.
    Click(&'a [AxElement]),
    /// Return (or Enter), from `key` or a newline in `type`.
    Return(Option<&'a Focus>),
    /// Every other action: only the intent can make it risky.
    Other,
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// The first entry of `list` found in `text` as whole words, in order, case-insensitively.
fn find_in(text: &str, list: &[&'static str]) -> Option<&'static str> {
    let words = words(text);
    list.iter().copied().find(|entry| {
        let entry: Vec<&str> = entry.split(' ').collect();
        words.windows(entry.len()).any(|window| window.iter().zip(&entry).all(|(a, b)| a == b))
    })
}

/// The first risky word or phrase in `text`, matched on whole words, case-insensitively.
pub fn risky_word(text: &str) -> Option<&'static str> {
    find_in(text, RISKY)
}

impl AxElement {
    /// The element's title, description, and value, joined for matching and messages.
    pub fn label(&self) -> String {
        [&self.title, &self.description, &self.value]
            .into_iter()
            .flatten()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn is_pressable(&self) -> bool {
        PRESSABLE_ROLES.contains(&self.role.as_str())
    }
}

fn kind(role: &str) -> &str {
    match role {
        "AXMenuItem" | "AXMenuBarItem" => "menu item",
        "AXLink" => "link",
        "AXTextField" | "AXTextArea" | "AXComboBox" => "field",
        _ => "button",
    }
}

/// A pressable element in `chain` (the element under the point or an ancestor) whose own
/// text, or the text of the elements inside it, is risky.
fn risky_click(chain: &[AxElement]) -> Option<String> {
    let pressable = chain.iter().position(AxElement::is_pressable)?;
    let label = chain[..=pressable].iter().map(AxElement::label).collect::<Vec<_>>().join(" ");
    risky_word(&label).map(|_| format!("the {} “{}”", kind(&chain[pressable].role), label.trim()))
}

fn risky_return(focus: &Focus) -> Option<String> {
    let element = &focus.element;
    let label = element.label();
    if focus.is_default_button {
        return Some(format!("Return presses the default button “{label}”"));
    }
    if element.is_pressable() && risky_word(&label).is_some() {
        return Some(format!("Return presses the {} “{label}”", kind(&element.role)));
    }
    let field = TEXT_INPUT_ROLES.contains(&element.role.as_str());
    if field && (risky_word(&label).is_some() || find_in(&label, SEND_LIKE_FIELD).is_some()) {
        return Some(format!("Return may send the field “{label}”"));
    }
    let default = focus.default_button.as_ref().map(AxElement::label)?;
    risky_word(&default).map(|_| format!("Return may press the default button “{default}”"))
}

/// Why `act` needs a confirmation, or `None` when it does not.
pub fn assess(act: Act<'_>, intent: Option<&str>) -> Option<String> {
    let target = match act {
        Act::Click(chain) => risky_click(chain),
        Act::Return(focus) => focus.and_then(risky_return),
        Act::Other => None,
    };
    let intent = intent.filter(|i| risky_word(i).is_some()).map(|i| format!("the declared intent “{}”", i.trim()));
    match (target, intent) {
        (Some(target), Some(intent)) => Some(format!("{target}; {intent}")),
        (target, intent) => target.or(intent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(role: &str, title: &str) -> AxElement {
        AxElement { role: role.into(), title: Some(title.into()), ..AxElement::default() }
    }

    fn focus(element: AxElement) -> Focus {
        Focus { element, ..Focus::default() }
    }

    #[test]
    fn english_and_spanish_words_match_case_insensitively() {
        assert_eq!(risky_word("SEND now"), Some("send"));
        assert_eq!(risky_word("Pagar ahora"), Some("pagar"));
        assert_eq!(risky_word("Eliminar conversación"), Some("eliminar"));
        assert_eq!(risky_word("Proceed to Checkout"), Some("checkout"));
    }

    #[test]
    fn words_match_whole_words_and_the_phrase_in_order() {
        assert_eq!(risky_word("Place Order"), Some("place order"));
        assert_eq!(risky_word("order a place"), None);
        assert_eq!(risky_word("Sender"), None);
        assert_eq!(risky_word("Paypal"), None);
        assert_eq!(risky_word("send-button"), Some("send"));
        assert_eq!(risky_word(""), None);
    }

    #[test]
    fn clicking_a_risky_button_or_menu_item_is_risky() {
        assert!(assess(Act::Click(&[element("AXButton", "Send")]), None).is_some());
        assert!(assess(Act::Click(&[element("AXMenuItem", "Delete Message")]), None).is_some());
        let described = AxElement { role: "AXButton".into(), description: Some("Comprar".into()), ..AxElement::default() };
        assert!(assess(Act::Click(&[described]), None).is_some());
    }

    #[test]
    fn text_inside_a_risky_button_counts() {
        let label = AxElement { role: "AXStaticText".into(), value: Some("Buy now".into()), ..AxElement::default() };
        let chain = [label, AxElement { role: "AXButton".into(), ..AxElement::default() }];
        assert!(assess(Act::Click(&chain), None).is_some());
    }

    #[test]
    fn harmless_clicks_are_not_risky() {
        assert_eq!(assess(Act::Click(&[element("AXButton", "Open")]), None), None);
        // A risky word outside a button (plain text, a text field) is not a press.
        assert_eq!(assess(Act::Click(&[element("AXStaticText", "Send")]), None), None);
        assert_eq!(assess(Act::Click(&[element("AXTextField", "Delete")]), None), None);
        assert_eq!(assess(Act::Click(&[]), None), None);
    }

    #[test]
    fn return_on_a_default_button_is_risky() {
        let default = Focus { element: element("AXButton", "OK"), is_default_button: true, default_button: None };
        assert!(assess(Act::Return(Some(&default)), None).is_some());
    }

    #[test]
    fn return_on_a_focused_risky_button_is_risky() {
        assert!(assess(Act::Return(Some(&focus(element("AXButton", "Transfer")))), None).is_some());
    }

    #[test]
    fn return_in_a_send_like_field_is_risky() {
        let composer = AxElement { role: "AXTextArea".into(), description: Some("Message #general".into()), ..AxElement::default() };
        assert!(assess(Act::Return(Some(&focus(composer))), None).is_some());
        let spanish = AxElement { role: "AXTextField".into(), title: Some("Escribe un mensaje".into()), ..AxElement::default() };
        assert!(assess(Act::Return(Some(&focus(spanish))), None).is_some());
    }

    #[test]
    fn return_with_a_risky_default_button_in_the_window_is_risky() {
        let field = Focus {
            element: element("AXTextField", "Amount"),
            is_default_button: false,
            default_button: Some(element("AXButton", "Pay")),
        };
        assert!(assess(Act::Return(Some(&field)), None).is_some());
    }

    #[test]
    fn return_in_an_ordinary_field_is_not_risky() {
        let search = Focus {
            element: element("AXTextField", "Search"),
            is_default_button: false,
            default_button: Some(element("AXButton", "Done")),
        };
        assert_eq!(assess(Act::Return(Some(&search)), None), None);
        assert_eq!(assess(Act::Return(None), None), None);
    }

    #[test]
    fn a_risky_intent_makes_any_action_risky() {
        assert!(assess(Act::Other, Some("borrar el archivo")).is_some());
        assert!(assess(Act::Click(&[element("AXButton", "Open")]), Some("purchase the plan")).is_some());
    }

    #[test]
    fn a_harmless_intent_never_removes_a_check() {
        assert_eq!(assess(Act::Other, Some("open the menu")), None);
        assert!(assess(Act::Click(&[element("AXButton", "Send")]), Some("just looking")).is_some());
    }
}
