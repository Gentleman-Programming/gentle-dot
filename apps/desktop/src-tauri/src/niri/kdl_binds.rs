//! Managed Niri config snippets as pure text transforms (binds + login spawn).
//!
//! Niri owns every global shortcut, so the app cannot register one itself
//! (upstream does not implement the xdg-desktop-portal GlobalShortcuts
//! interface). The supported route is a `spawn` binding in the user's Niri
//! config; this module makes that binding app-managed instead of hand-written.
//! Only the app's own include file and its own lines are ever touched, and
//! every function here is pure text: I/O, backups, validation and the
//! compositor reload live in the callers.

/// Include file this app owns inside the Niri config directory. `config.kdl`
/// gains exactly one `include "gentle-dot.kdl"` line for it.
pub const SNIPPET_STEM: &str = "gentle-dot.kdl";
/// Argument that asks the running app to toggle the panel.
pub const TOGGLE_ARG: &str = "--toggle";
/// Argument that asks the running app to toggle fullscreen/minimize.
pub const FULLSCREEN_ARG: &str = "--fullscreen";
/// Argument that asks the running app to stop computer control (Stop).
/// Handled through the existing single-instance launch path, never a second
/// helper process: the Niri `spawn` binding below is the Wayland fallback for
/// the panic shortcut, which the global-shortcut plugin may not deliver.
pub const STOP_ARG: &str = "--stop";
/// Default binding for the toggle (S19: first run and Reset to default land here).
pub const DEFAULT_KEY: &str = "Alt+Space";
/// Reserved binding for Stop: the panic shortcut (S24.3), owned by the compositor
/// on Niri through the managed snippet. Alt+Shift+Escape stays reachable even
/// where the global-shortcut plugin cannot deliver it; only the toggle and
/// this Stop binding are ever managed, never a second launch path.
pub const STOP_KEY: &str = "Alt+Shift+Escape";
// NOTE (user decision): no managed fullscreen binding. Fullscreen stays an
// app-internal verb (`--fullscreen`, still parsed and still toggling the mode
// when invoked by hand) with NO key in the snippet: on Niri a second global
// combo fights the compositor's own placement logic, so Settings manages the
// open/close shortcut only.

/// Program name that identifies this app in a `spawn` line. The executable may
/// live anywhere (package, source build, other distro layout), so the FILE NAME
/// is compared and never a hardcoded path — and a `spawn` of any other program
/// is never treated as ours.
const PROGRAM: &str = "gentle-dot";

/// Named keys whose Niri spelling is fixed (XKB names). Anything absent here is
/// rejected rather than guessed, so the app never writes a binding Niri would
/// refuse.
const NAMED_KEYS: [(&str, &str); 8] = [
    ("space", "Space"),
    ("return", "Return"),
    ("enter", "Return"),
    ("escape", "Escape"),
    ("esc", "Escape"),
    ("tab", "Tab"),
    ("backspace", "Backspace"),
    ("delete", "Delete"),
];

fn key_name(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if let Some((_, key)) = NAMED_KEYS.iter().find(|(name, _)| *name == lower) {
        return Some((*key).to_owned());
    }
    if token.len() == 1 && token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(token.to_ascii_uppercase());
    }
    // Function keys F1..F99.
    if matches!(lower.as_bytes().first(), Some(b'f'))
        && lower.len() <= 3
        && lower[1..].chars().all(|c| c.is_ascii_digit())
    {
        return Some(lower.to_ascii_uppercase());
    }
    None
}

/// Niri's spelling for the app accelerator, or `None` when a token has no Niri
/// equivalent. Niri accepts `Mod`/`Super`, `Alt`, `Ctrl` and `Shift`; the app's
/// portable spelling uses `CommandOrControl` and `Control`. Modifiers alone, an
/// unknown key, and a second key token are all rejected rather than guessed.
pub fn niri_key(accelerator: &str) -> Option<String> {
    let mut modifiers: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for token in accelerator.split('+') {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "cmd" | "command" | "super" | "meta" | "mod" => modifiers.push("Mod"),
            "alt" | "option" => modifiers.push("Alt"),
            "control" | "ctrl" => modifiers.push("Ctrl"),
            "shift" => modifiers.push("Shift"),
            _ => {
                if key.is_some() {
                    return None;
                }
                key = Some(key_name(token)?);
            }
        }
    }
    let key = key?;
    modifiers.push(key.as_str());
    Some(modifiers.join("+"))
}

/// KDL string escaping for one quoted value: backslash and quote only, so a
/// hostile path cannot break out of the string.
fn escape_kdl(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// The `spawn` line that runs this app with `arg` (quoted, absolute path,
/// KDL-escaped).
pub fn spawn_line(executable: &str, arg: &str) -> String {
    format!("    spawn \"{}\" \"{}\";", escape_kdl(executable), escape_kdl(arg))
}

/// Code part of one line: cut at `//` outside quotes so comments never read
/// as bindings. A backslash escapes only inside quotes, so an escaped quote
/// in a path cannot smuggle a comment marker.
fn code_part(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut quoted = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if quoted => i += 2,
            b'"' => {
                quoted = !quoted;
                i += 1;
            }
            b'/' if !quoted && i + 1 < bytes.len() && bytes[i + 1] == b'/' => return &line[..i],
            _ => i += 1,
        }
    }
    line
}

/// Per-line membership in a `binds { ... }` block: a scope stack over code
/// parts (quotes stripped), so a commented `binds {` never opens and a
/// `spawn` in a window-rule or any other block never reads as a shortcut.
fn binds_membership(text: &str) -> Vec<bool> {
    let mut stack: Vec<bool> = Vec::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let code = code_part(line);
        out.push(stack.iter().any(|scope| *scope));
        let mut segment = String::new();
        let mut quoted = false;
        let mut chars = code.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' if quoted => {
                    chars.next();
                }
                '"' => quoted = !quoted,
                '{' if !quoted => {
                    stack.push(segment.contains("binds"));
                    segment.clear();
                }
                '}' if !quoted => {
                    stack.pop();
                    segment.clear();
                }
                _ if !quoted => segment.push(c),
                _ => {}
            }
        }
    }
    out
}

/// Quoted tokens after `spawn`, unescaped: `spawn "exe" "arg"`. An escaped
/// quote cannot smuggle a second token.
fn spawn_tokens(after_spawn: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur: Option<String> = None;
    let mut chars = after_spawn.chars();
    while let Some(c) = chars.next() {
        if let Some(token) = cur.as_mut() {
            match c {
                '\\' => {
                    if let Some(e) = chars.next() {
                        token.push(e);
                    }
                }
                '"' => tokens.push(cur.take().unwrap_or_default()),
                _ => token.push(c),
            }
        } else if c == '"' {
            cur = Some(String::new());
        }
    }
    tokens
}

/// The argument of a single-line binding that spawns THIS app, when the line
/// is one: quotes are tolerated (unescaped) and the executable may be any
/// path, because a source build and a package install differ while the
/// program name identifies us. A `spawn` of any other program is never ours.
/// Comments never match (code part only) and a continuation line of a
/// multiline block never matches (the key's `{` must open before `spawn`).
fn spawned_arg(line: &str) -> Option<String> {
    let code = code_part(line);
    let at = code.find("spawn")?;
    let brace = code.find('{')?;
    if brace > at {
        return None;
    }
    let tokens = spawn_tokens(&code[at + "spawn".len()..]);
    let executable = tokens.first()?;
    if std::path::Path::new(executable).file_name().and_then(|name| name.to_str()) != Some(PROGRAM) {
        return None;
    }
    let arg = tokens.get(1)?;
    arg.starts_with("--").then(|| arg.to_owned())
}

/// Key of the existing single-line binding for `arg` inside a binds block,
/// if the text already binds it. First match wins when duplicates exist.
pub fn bound_key(text: &str, arg: &str) -> Option<String> {
    let inside = binds_membership(text);
    text.lines().enumerate().find_map(|(i, line)| {
        if !inside.get(i).copied().unwrap_or(false) {
            return None;
        }
        if spawned_arg(line).as_deref() != Some(arg) {
            return None;
        }
        let head = code_part(line).split_whitespace().next()?;
        let key = head.split('{').next()?.trim();
        (!key.is_empty() && key != "binds").then(|| key.to_owned())
    })
}

/// True when the snippet mentions our program plus `arg` inside a binds block
/// yet no single-line binding is recognized (a hand-written multiline block):
/// adding a line would duplicate the binding, so callers must merge by hand.
pub fn has_unsupported_binding_layout(text: &str, arg: &str) -> bool {
    if bound_key(text, arg).is_some() {
        return false;
    }
    let inside = binds_membership(text);
    text.lines().enumerate().any(|(i, line)| {
        inside.get(i).copied().unwrap_or(false)
            && code_part(line).contains(PROGRAM)
            && code_part(line).contains(arg)
    })
}

/// Why a binding cannot be upserted safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertError {
    /// A hand-written multiline block binds our arg: adding a single line
    /// would duplicate it. Merge by hand instead.
    UnsupportedLayout,
}

/// Insert the binding for `arg`, replace the key of the existing one(s), or
/// refuse a layout that would duplicate. Every duplicate line binding `arg`
/// collapses into one at the first position; every other line survives byte
/// for byte; a missing `binds` block is added at the end.
pub fn try_upsert_binding(
    text: &str,
    executable: &str,
    arg: &str,
    key: &str,
) -> Result<String, UpsertError> {
    if has_unsupported_binding_layout(text, arg) {
        return Err(UpsertError::UnsupportedLayout);
    }
    let replacement =
        format!("    {key} hotkey-overlay-title=\"Gentle Dot\" {{ {} }}", spawn_line(executable, arg).trim());
    let lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let inside = binds_membership(text);
    let mut first: Option<usize> = None;
    let mut kept: Vec<String> = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        if inside.get(i).copied().unwrap_or(false) && spawned_arg(line).as_deref() == Some(arg) {
            if first.is_none() {
                first = Some(kept.len());
                kept.push(replacement.clone());
            }
        } else {
            kept.push(line.clone());
        }
    }
    if first.is_none() {
        if let Some(open) = kept.iter().position(|line| code_part(line).trim_end().ends_with("binds {")) {
            kept.insert(open + 1, replacement);
        } else {
            let trailing = kept.last().map(|line| line.trim().is_empty()).unwrap_or(false);
            if !kept.is_empty() && !trailing {
                kept.push(String::new());
            }
            kept.push("binds {".to_owned());
            kept.push(replacement);
            kept.push("}".to_owned());
        }
    }
    let mut joined = kept.join("\n");
    joined.push('\n');
    Ok(joined)
}

/// Insert the binding for `arg`, or replace the key of the existing one(s).
/// Same as [`try_upsert_binding`], but total for existing callers: an
/// unsupported multiline layout returns the input unchanged (fail closed,
/// never a duplicate) until callers are wired to the `Result`. New callers
/// must use [`try_upsert_binding`] and surface the error instead.
pub fn upsert_binding(text: &str, executable: &str, arg: &str, key: &str) -> String {
    try_upsert_binding(text, executable, arg, key).unwrap_or_else(|_| text.to_owned())
}

/// Remove the binding for `arg`; every other line survives. A no-op when the
/// text does not bind it, so callers never need to probe first.
pub fn remove_binding(text: &str, arg: &str) -> String {
    let inside = binds_membership(text);
    let kept: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(i, line)| {
            !inside.get(*i).copied().unwrap_or(false) || spawned_arg(line).as_deref() != Some(arg)
        })
        .map(|(_, line)| line)
        .collect();
    let mut joined = kept.join("\n");
    joined.push('\n');
    joined
}

/// Titles of this app's own windows. Only a `window-rule` block that already
/// matches one of these is ever touched; a missing block is never invented.
const APP_TITLES: [&str; 2] = ["^Gentle Dot Panel$", "^Gentle Dot$"];

/// Off rules that must sit inside each owned `window-rule` block. Niri draws
/// border/focus-ring/shadow compositor-side, so a client-side opacity 0
/// cannot hide them; without these the hidden surface leaves a hollow outline.
const DECORATION_RULES: [&str; 3] = [
    "border { off; }",
    "focus-ring { off; }",
    "shadow { off; }",
];

/// True when `block_code` (comments already stripped) targets one of our own
/// window titles: a `match title=` for an anchored `^Gentle Dot( Panel)?$`.
fn block_targets_app(block_code: &str) -> bool {
    if !(block_code.contains("match") && block_code.contains("title")) {
        return false;
    }
    APP_TITLES.iter().any(|title| {
        block_code.contains(&format!("\"{title}\"")) || block_code.contains(&format!("'{title}'"))
    })
}

/// Line ranges (inclusive) of top-level `window-rule { ... }` blocks. The
/// scan mirrors [`binds_membership`]: quote-aware brace matching over code
/// parts, so a commented `window-rule {` never opens and braces inside
/// strings never count. The declaration segment is carried across lines so a
/// `window-rule` whose `{` opens on a later line is still found (it used to
/// be silently left unhealed); only owned blocks matching our titles are
/// ever touched, so a stale mark on any other block stays a no-op.
fn window_rule_blocks(text: &str) -> Vec<(usize, usize)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut stack: Vec<(bool, usize)> = Vec::new();
    let mut blocks = Vec::new();
    let mut segment = String::new();
    for (idx, line) in lines.iter().enumerate() {
        let code = code_part(line);
        let mut quoted = false;
        let mut chars = code.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' if quoted => {
                    chars.next();
                }
                '"' => quoted = !quoted,
                '{' if !quoted => {
                    let is_rule = segment.contains("window-rule");
                    stack.push((is_rule, idx));
                    segment.clear();
                }
                '}' if !quoted => {
                    if let Some((is_rule, start)) = stack.pop() {
                        if is_rule {
                            blocks.push((start, idx));
                        }
                    }
                    segment.clear();
                }
                _ if !quoted => segment.push(c),
                _ => {}
            }
        }
    }
    blocks
}

/// Heal every `rule { ... }` occurrence inside one owned `window-rule`
/// block whose inner does not already carry `off`: the inner bytes become
/// ` off; ` in place, so `border { on; }` converges to `border { off; }`
/// instead of gaining a second block that `on` would still win over.
/// Returns the healed block plus whether the rule occurred at all (a rule
/// with no occurrence is the caller's append case, never invented here).
/// Quote- and comment-aware, one nesting level: decoration inners never
/// nest, and braces inside strings or `//` comments never count.
fn heal_rule_in_block(block: &str, rule: &str) -> (String, bool) {
    let bytes = block.as_bytes();
    let needle = rule.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut found = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            out.push(bytes[i]);
            i += 1;
            while i < bytes.len() {
                out.push(bytes[i]);
                if bytes[i] == b'\\' {
                    i += 1;
                    if i < bytes.len() {
                        out.push(bytes[i]);
                        i += 1;
                    }
                    continue;
                }
                i += 1;
                if bytes[i - 1] == b'"' {
                    break;
                }
            }
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(bytes[i]);
                i += 1;
            }
            continue;
        }
        let matches = i + needle.len() <= bytes.len()
            && &bytes[i..i + needle.len()] == needle
            && (i == 0 || !is_word(bytes[i - 1]))
            && (i + needle.len() >= bytes.len() || !is_word(bytes[i + needle.len()]));
        if matches {
            let mut j = i + needle.len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'{' {
                let mut k = j + 1;
                let mut quoted = false;
                let mut close = None;
                while k < bytes.len() {
                    if quoted {
                        if bytes[k] == b'\\' {
                            k += 2;
                            continue;
                        }
                        if bytes[k] == b'"' {
                            quoted = false;
                        }
                        k += 1;
                        continue;
                    }
                    if bytes[k] == b'"' {
                        quoted = true;
                        k += 1;
                        continue;
                    }
                    if bytes[k] == b'/' && k + 1 < bytes.len() && bytes[k + 1] == b'/' {
                        while k < bytes.len() && bytes[k] != b'\n' {
                            k += 1;
                        }
                        continue;
                    }
                    if bytes[k] == b'}' {
                        close = Some(k);
                        break;
                    }
                    // A second `{` means nesting this healer does not
                    // model: leave the whole occurrence untouched.
                    if bytes[k] == b'{' {
                        close = None;
                        break;
                    }
                    k += 1;
                }
                if let Some(close) = close {
                    found = true;
                    let inner = &bytes[j + 1..close];
                    let mut has_off = false;
                    let mut t = 0;
                    while t + 3 <= inner.len() {
                        if inner[t..].starts_with(b"off")
                            && (t == 0 || !is_word(inner[t - 1]))
                            && (t + 3 >= inner.len() || !is_word(inner[t + 3]))
                        {
                            has_off = true;
                            break;
                        }
                        t += 1;
                    }
                    if has_off {
                        out.extend_from_slice(&bytes[i..=close]);
                    } else {
                        out.extend_from_slice(&bytes[i..=j]);
                        out.extend_from_slice(b" off; ");
                        out.push(b'}');
                    }
                    i = close + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    (String::from_utf8(out).unwrap_or_else(|_| block.to_owned()), found)
}

/// Ensure every existing `window-rule` block that already matches one of our
/// own titles contains `border { off; }`, `focus-ring { off; }` and
/// `shadow { off; }`. Idempotent pure text: a block whose matching inner
/// already carries `off` returns byte-identical; a block carrying any other
/// inner (e.g. `border { on; }`) has THAT inner rewritten to the off form in
/// place, so the block converges to one authoritative rule instead of an
/// `on`-wins pair; only a rule with no occurrence at all is appended
/// (4-space indent, before the block's closing `}`). Every other byte —
/// comments, hand-written rules, unrelated blocks — survives; a snippet
/// with no matching block returns unchanged and no block is ever invented.
pub fn ensure_decorations_off(text: &str) -> String {
    if text.is_empty() {
        return text.to_owned();
    }
    let lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let codes: Vec<String> = lines.iter().map(|line| code_part(line).to_owned()).collect();
    let blocks = window_rule_blocks(text);
    let owned: Vec<(usize, usize)> = blocks
        .into_iter()
        .filter(|pair| {
            let e = pair.1.min(codes.len().saturating_sub(1));
            let joined = codes[pair.0..=e].join("\n");
            block_targets_app(&joined)
        })
        .collect();
    if owned.is_empty() {
        return text.to_owned();
    }
    let mut out = lines;
    let mut changed_any = false;
    // Latest block first so earlier indices stay valid when a heal changes
    // the line count.
    for (start, end) in owned.into_iter().rev() {
        let end = end.min(out.len().saturating_sub(1));
        let block_text = out[start..=end].join("\n");
        let mut healed = block_text.clone();
        let mut seen = [false; DECORATION_RULES.len()];
        for (idx, rule) in DECORATION_RULES.iter().enumerate() {
            let name = rule.split_whitespace().next().unwrap_or(rule);
            let (next, found) = heal_rule_in_block(&healed, name);
            healed = next;
            seen[idx] = found;
        }
        let missing: Vec<&str> = DECORATION_RULES
            .iter()
            .enumerate()
            .filter(|(idx, _)| !seen[*idx])
            .map(|(_, rule)| *rule)
            .collect();
        if healed == block_text && missing.is_empty() {
            continue;
        }
        changed_any = true;
        let mut fresh: Vec<String> = healed.split('\n').map(str::to_owned).collect();
        if !missing.is_empty() {
            if fresh.len() == 1 {
                let line = fresh[0].clone();
                if let Some(close_at) = line.rfind('}') {
                    let mut replacement = String::with_capacity(line.len() + 64);
                    replacement.push_str(&line[..close_at]);
                    if !replacement.ends_with('\n') {
                        replacement.push('\n');
                    }
                    for rule in &missing {
                        replacement.push_str("    ");
                        replacement.push_str(rule);
                        replacement.push('\n');
                    }
                    replacement.push_str(&line[close_at..]);
                    fresh[0] = replacement;
                }
            } else {
                let pos = fresh.len() - 1;
                for (k, rule) in missing.iter().enumerate() {
                    fresh.insert(pos + k, format!("    {rule}"));
                }
            }
        }
        out.splice(start..=end, fresh);
    }
    if !changed_any {
        return text.to_owned();
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// Compositor-side focus steal fix: every owned `window-rule` block gains
/// exactly one `open-focused false`, so a newly mapped rose never takes
/// keyboard focus (startup, remap, workspace return). An explicit client
/// activation (chat-open `set_focus` via xdg-activation) still focuses, so
/// typing works there. Idempotent pure text like [`ensure_decorations_off`]:
/// a present false stays byte-identical, a true is rewritten in place (never
/// a second line), and only a missing rule is appended. Foreign blocks stay
/// untouched and no block is ever invented.
const FOCUS_RULE: &str = "open-focused false";

fn is_focus_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
}

fn heal_open_focused_in_block(block: &str) -> (String, bool) {
    let mut found = false;
    let mut lines: Vec<String> = block.split('\n').map(str::to_owned).collect();
    for line in lines.iter_mut() {
        let code = code_part(line).to_owned();
        let Some(at) = code.find("open-focused") else { continue };
        let before_ok = at == 0 || !is_focus_word(code.as_bytes()[at - 1]);
        let after_at = at + "open-focused".len();
        let after_ok = after_at >= code.len() || !is_focus_word(code.as_bytes()[after_at]);
        if !(before_ok && after_ok) {
            continue;
        }
        found = true;
        let has_false = code.contains("false");
        if has_false {
            continue;
        }
        if let Some(true_at) = code.find("true") {
            line.replace_range(true_at..true_at + "true".len(), "false");
        } else {
            let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
            let suffix = line[code.len()..].to_owned();
            *line = format!("{indent}{FOCUS_RULE}{suffix}");
        }
    }
    (lines.join("\n"), found)
}

/// Ensure `open-focused false` in every owned `window-rule` block. See
/// [`FOCUS_RULE`] for why; idempotent, foreign-safe, invents nothing.
pub fn ensure_open_focused_off(text: &str) -> String {
    if text.is_empty() {
        return text.to_owned();
    }
    let lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let codes: Vec<String> = lines.iter().map(|line| code_part(line).to_owned()).collect();
    let owned: Vec<(usize, usize)> = window_rule_blocks(text)
        .into_iter()
        .filter(|pair| {
            let e = pair.1.min(codes.len().saturating_sub(1));
            block_targets_app(&codes[pair.0..=e].join("\n"))
        })
        .collect();
    if owned.is_empty() {
        return text.to_owned();
    }
    let mut out = lines;
    let mut changed_any = false;
    for (start, end) in owned.into_iter().rev() {
        let end = end.min(out.len().saturating_sub(1));
        let block_text = out[start..=end].join("\n");
        let (mut healed, seen) = heal_open_focused_in_block(&block_text);
        if seen && healed == block_text {
            continue;
        }
        changed_any = true;
        if !seen {
            let mut fresh: Vec<String> = healed.split('\n').map(str::to_owned).collect();
            if fresh.len() == 1 {
                if let Some(close_at) = fresh[0].rfind('}') {
                    let mut replacement = String::with_capacity(fresh[0].len() + 32);
                    replacement.push_str(&fresh[0][..close_at]);
                    replacement.push('\n');
                    replacement.push_str("    ");
                    replacement.push_str(FOCUS_RULE);
                    replacement.push('\n');
                    replacement.push_str(&fresh[0][close_at..]);
                    fresh[0] = replacement;
                }
            } else {
                let pos = fresh.len() - 1;
                fresh.insert(pos, format!("    {FOCUS_RULE}"));
            }
            healed = fresh.join("\n");
        }
        let fresh: Vec<String> = healed.split('\n').map(str::to_owned).collect();
        out.splice(start..=end, fresh);
    }
    if !changed_any {
        return text.to_owned();
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// Whether `config.kdl` already includes the app's snippet, matching either the
/// bare stem or a path ending in it (the include may be relative or absolute).
pub fn includes_snippet(text: &str) -> bool {
    text.lines().any(|line| {
        let code = code_part(line);
        code.trim_start().starts_with("include")
            && code.trim_end().trim_end_matches(';').trim_end().ends_with(&format!("{SNIPPET_STEM}\""))
    })
}

/// KDL-escaped path for an `include` line: backslash and quote only, so a
/// hostile directory name cannot break out of the string.
pub fn escape_include_path(path: &str) -> String {
    escape_kdl(path)
}

/// Quoted path of an `include` line (code part only, unescaped), or `None`
/// for comments, other nodes, a keyword run-on (`included`), or missing
/// quotes. The keyword boundary is one char: `include` must be followed by
/// whitespace or the opening quote itself.
pub fn include_path(line: &str) -> Option<String> {
    let code = code_part(line);
    let rest = code.trim_start().strip_prefix("include")?;
    match rest.chars().next()? {
        '"' | ' ' | '\t' => {}
        _ => return None,
    }
    spawn_tokens(rest).into_iter().next()
}

/// Whether an include path targets the app-owned snippet: the bare stem or
/// any absolute/relative path ending in it, compared by file name.
pub fn is_owned_include(path: &str) -> bool {
    std::path::Path::new(path).file_name().and_then(|name| name.to_str()) == Some(SNIPPET_STEM)
}

/// Splice a new quoted path into an `include` line, preserving leading
/// whitespace, the keyword gap, and any trailing `;`/comment bytes. `None`
/// when the line carries no quoted span. The line must already parse via
/// [`include_path`]: comment-only lines never reach the splice.
pub fn rewrite_include_path(line: &str, new_path: &str) -> Option<String> {
    if include_path(line).is_none() {
        return None;
    }
    let bytes = line.as_bytes();
    let mut open = 0;
    while open < bytes.len() && bytes[open] != b'"' {
        open += 1;
    }
    if open >= bytes.len() {
        return None;
    }
    let mut close = open + 1;
    while close < bytes.len() {
        match bytes[close] {
            b'\\' => close += 2,
            b'"' => break,
            _ => close += 1,
        }
    }
    if close >= bytes.len() {
        return None;
    }
    // Slice points sit on ASCII quotes only, so byte indices are boundaries.
    let mut out = String::with_capacity(line.len() + new_path.len());
    out.push_str(&line[..open + 1]);
    out.push_str(&escape_include_path(new_path));
    out.push_str(&line[close..]);
    Some(out)
}

/// The include line to append when the snippet is not included yet.
pub fn include_line() -> String {
    format!("include \"{SNIPPET_STEM}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/usr/bin/gentle-dot";
    const SNIPPET: &str = concat!(
        "// Gentle Dot on Niri\n",
        "window-rule {\n    match title=\"^Gentle Dot$\"\n    open-floating true\n}\n",
        "\n",
        "binds {\n",
        "    Mod+Alt+D hotkey-overlay-title=\"Toggle Gentle Dot\" { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
        "    Mod+Shift+F { spawn \"/usr/bin/gentle-dot\" \"--fullscreen\"; }\n",
        "}\n",
    );

    #[test]
    fn default_binding_is_alt_space() {
        // S19: first run and Reset to default land on Alt+Space.
        assert_eq!(DEFAULT_KEY, "Alt+Space");
    }

    #[test]
    fn maps_the_app_accelerator_to_niris_spelling() {
        assert_eq!(niri_key("Alt+Space").as_deref(), Some("Alt+Space"));
        assert_eq!(niri_key("CommandOrControl+Shift+D").as_deref(), Some("Mod+Shift+D"));
        assert_eq!(niri_key("Super+Alt+d").as_deref(), Some("Mod+Alt+D"));
        assert_eq!(niri_key("Ctrl+f").as_deref(), Some("Ctrl+F"));
        assert_eq!(niri_key("Mod+F5").as_deref(), Some("Mod+F5"));
        assert_eq!(niri_key("Mod+Space").as_deref(), Some("Mod+Space"));
        // Modifiers alone, unknown tokens and a second key are rejected, never
        // guessed, so the app never writes a binding Niri would refuse.
        assert_eq!(niri_key("Alt+Shift"), None);
        assert_eq!(niri_key("Alt+SuperKey"), None);
        assert_eq!(niri_key("Alt+Space+D"), None);
        assert_eq!(niri_key("Alt+"), None);
        assert_eq!(niri_key(""), None);
    }

    #[test]
    fn reads_the_effective_binding_for_each_verb() {
        assert_eq!(bound_key(SNIPPET, TOGGLE_ARG).as_deref(), Some("Mod+Alt+D"));
        assert_eq!(bound_key(SNIPPET, FULLSCREEN_ARG).as_deref(), Some("Mod+Shift+F"));
        assert_eq!(bound_key(SNIPPET, "--other"), None);
        assert_eq!(bound_key("binds {\n}\n", TOGGLE_ARG), None);
    }

    #[test]
    fn stop_stays_reachable_through_the_managed_snippet() {
        // The panic shortcut (S24.3) is a Niri-owned key on Wayland: the Stop
        // arg upserts through the same pure-text mechanism as the toggle,
        // never a second launch path, and the key is the panic shortcut itself.
        assert_eq!(STOP_ARG, "--stop");
        assert_eq!(niri_key(crate::computer::app::PANIC_SHORTCUT), Some(STOP_KEY.to_owned()));
        let with_stop = try_upsert_binding(SNIPPET, EXE, STOP_ARG, STOP_KEY).expect("stop upserts");
        assert_eq!(bound_key(&with_stop, STOP_ARG).as_deref(), Some(STOP_KEY));
        // The toggle binding and every other line survive the Stop upsert.
        assert_eq!(bound_key(&with_stop, TOGGLE_ARG).as_deref(), Some("Mod+Alt+D"));
        assert_eq!(bound_key(&with_stop, FULLSCREEN_ARG).as_deref(), Some("Mod+Shift+F"));
        // Idempotent: re-applying the same Stop key is byte-identical.
        assert_eq!(
            try_upsert_binding(&with_stop, EXE, STOP_ARG, STOP_KEY).expect("stop idempotent"),
            with_stop
        );
        // Removing Stop keeps the toggle.
        assert_eq!(bound_key(&remove_binding(&with_stop, STOP_ARG), STOP_ARG), None);
        assert_eq!(
            bound_key(&remove_binding(&with_stop, STOP_ARG), TOGGLE_ARG).as_deref(),
            Some("Mod+Alt+D")
        );
    }

    #[test]
    fn changes_only_the_key_of_our_own_binding() {
        let changed = upsert_binding(SNIPPET, EXE, TOGGLE_ARG, "Alt+Space");
        assert_eq!(bound_key(&changed, TOGGLE_ARG).as_deref(), Some("Alt+Space"));
        // The fullscreen binding, the window rules and the comments survive.
        assert_eq!(bound_key(&changed, FULLSCREEN_ARG).as_deref(), Some("Mod+Shift+F"));
        assert!(changed.contains("window-rule {\n    match title=\"^Gentle Dot$\""));
        assert!(changed.contains("// Gentle Dot on Niri"));
        assert_eq!(changed.lines().count(), SNIPPET.lines().count());
        // Idempotent: re-applying the same key is byte-identical.
        assert_eq!(upsert_binding(&changed, EXE, TOGGLE_ARG, "Alt+Space"), changed);
    }

    #[test]
    fn adds_a_binding_and_a_missing_binds_block() {
        let rules_only = "window-rule {\n    match title=\"^Gentle Dot$\"\n    open-floating true\n}\n";
        let added = upsert_binding(rules_only, EXE, TOGGLE_ARG, DEFAULT_KEY);
        assert_eq!(bound_key(&added, TOGGLE_ARG).as_deref(), Some(DEFAULT_KEY));
        assert!(added.contains("binds {\n"));
        assert!(added.starts_with(rules_only));
        assert!(added.contains(&format!("spawn \"{EXE}\" \"{TOGGLE_ARG}\"")));
        // An empty file still produces a valid binds block.
        let from_empty = upsert_binding("", EXE, TOGGLE_ARG, DEFAULT_KEY);
        assert_eq!(bound_key(&from_empty, TOGGLE_ARG).as_deref(), Some(DEFAULT_KEY));
        assert!(!from_empty.starts_with('\n'));
    }

    #[test]
    fn removes_only_our_binding_and_keeps_the_rest() {
        let removed = remove_binding(SNIPPET, TOGGLE_ARG);
        assert_eq!(bound_key(&removed, TOGGLE_ARG), None);
        assert_eq!(bound_key(&removed, FULLSCREEN_ARG).as_deref(), Some("Mod+Shift+F"));
        assert!(removed.contains("open-floating true"));
        // Removing something that is not bound changes nothing.
        assert_eq!(remove_binding(SNIPPET, "--other"), SNIPPET);
    }

    #[test]
    fn detects_whether_our_snippet_is_already_included() {
        assert!(includes_snippet("include \"gentle-dot.kdl\"\n"));
        assert!(includes_snippet("include \"/home/jona/.config/niri/gentle-dot.kdl\"\n"));
        assert!(includes_snippet("  include \"gentle-dot.kdl\";\n"));
        assert!(!includes_snippet("include \"dms/binds.kdl\"\n"));
        assert!(!includes_snippet("// include \"gentle-dot.kdl\"\n"));
        assert_eq!(include_line(), "include \"gentle-dot.kdl\"");
    }

    #[test]
    fn a_spawn_of_a_different_program_is_never_ours() {
        let other = "binds {\n    Mod+Alt+D { spawn \"kitty\" \"--toggle\"; }\n}\n";
        assert_eq!(bound_key(other, TOGGLE_ARG), None);
        assert_eq!(remove_binding(other, TOGGLE_ARG), other);
        let changed = upsert_binding(other, EXE, FULLSCREEN_ARG, DEFAULT_KEY);
        assert_eq!(bound_key(&changed, FULLSCREEN_ARG).as_deref(), Some(DEFAULT_KEY));
        assert!(changed.contains("spawn \"kitty\" \"--toggle\""));
    }

    #[test]
    fn commented_and_out_of_block_spawns_are_ignored() {
        let text = concat!(
            "// Alt+Space { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
            "window-rule {\n",
            "    Alt+Space { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
            "}\n",
            "binds {\n",
            "    Mod+Q { close-window; }\n",
            "}\n",
        );
        assert_eq!(bound_key(text, TOGGLE_ARG), None);
        // Repair adds one real line inside binds and keeps every other byte.
        let repaired = upsert_binding(text, EXE, TOGGLE_ARG, DEFAULT_KEY);
        assert_eq!(bound_key(&repaired, TOGGLE_ARG).as_deref(), Some(DEFAULT_KEY));
        assert!(repaired.contains("// Alt+Space { spawn"));
        assert!(repaired.contains("window-rule {"));
        // Removing what was never bound changes nothing.
        assert_eq!(remove_binding(text, TOGGLE_ARG), text);
    }

    #[test]
    fn executable_quoting_is_escaped() {
        let line = spawn_line("C:\\a\"b", TOGGLE_ARG);
        assert!(line.contains("C:\\\\a\\\"b"), "raw path must not break the KDL string: {line}");
    }

    #[test]
    fn quoted_executable_round_trips_through_a_binding() {
        let exe = "/opt/my\"dir/gentle-dot";
        let text = upsert_binding("", exe, TOGGLE_ARG, DEFAULT_KEY);
        assert_eq!(bound_key(&text, TOGGLE_ARG).as_deref(), Some(DEFAULT_KEY));
        assert!(text.contains("spawn"));
    }

    #[test]
    fn multiline_toggle_layout_does_not_duplicate() {
        let text = concat!(
            "binds {\n",
            "    Alt+Space {\n",
            "        spawn \"/usr/bin/gentle-dot\" \"--toggle\";\n",
            "    }\n",
            "}\n",
        );
        assert_eq!(bound_key(text, TOGGLE_ARG), None);
        // Fail closed: no second binding is added and no line is deleted.
        assert_eq!(upsert_binding(text, EXE, TOGGLE_ARG, DEFAULT_KEY), text);
    }

    #[test]
    fn duplicate_toggle_lines_collapse_to_one_without_touching_others() {
        let text = concat!(
            "binds {\n",
            "    Mod+Alt+D { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
            "    Mod+Q { close-window; }\n",
            "    Ctrl+T { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
            "}\n",
        );
        let fixed = upsert_binding(text, EXE, TOGGLE_ARG, DEFAULT_KEY);
        assert_eq!(fixed.matches("--toggle").count(), 1);
        assert!(fixed.contains("Mod+Q { close-window; }"));
        assert_eq!(bound_key(&fixed, TOGGLE_ARG).as_deref(), Some(DEFAULT_KEY));
    }

    #[test]
    fn include_with_trailing_comment_still_counts() {
        assert!(includes_snippet("include \"gentle-dot.kdl\" // managed\n"));
    }

    #[test]
    fn include_path_parses_quoted_targets() {
        assert_eq!(include_path("include \"gentle-dot.kdl\"\n"), Some("gentle-dot.kdl".to_owned()));
        assert_eq!(
            include_path("  include \"/x/y/gentle-dot.kdl\"; // ours\n"),
            Some("/x/y/gentle-dot.kdl".to_owned())
        );
        assert_eq!(include_path("// include \"gentle-dot.kdl\"\n"), None);
        assert_eq!(include_path("binds {\n"), None);
        assert_eq!(include_path("included \"x\"\n"), None);
    }

    #[test]
    fn owned_includes_match_by_file_name() {
        assert!(is_owned_include("gentle-dot.kdl"));
        assert!(is_owned_include("/home/u/.config/niri/gentle-dot.kdl"));
        assert!(!is_owned_include("other.kdl"));
        assert!(!is_owned_include(""));
    }

    #[test]
    fn include_escapes_round_trip() {
        let rewritten = rewrite_include_path("include \"old.kdl\"; // keep\n", "a\"b\\c.kdl").unwrap();
        assert!(rewritten.contains("a\\\"b\\\\c.kdl"), "escaped path must survive: {rewritten}");
        assert!(rewritten.ends_with("; // keep\n"), "trailing bytes preserved: {rewritten}");
        assert_eq!(escape_include_path("plain.kdl"), "plain.kdl");
    }

    #[test]
    fn checked_upsert_refuses_multiline_and_matches_legacy_on_clean_input() {
        let multiline = concat!(
            "binds {\n",
            "    Alt+Space {\n",
            "        spawn \"/usr/bin/gentle-dot\" \"--toggle\";\n",
            "    }\n",
            "}\n",
        );
        assert!(has_unsupported_binding_layout(multiline, TOGGLE_ARG));
        assert_eq!(
            try_upsert_binding(multiline, EXE, TOGGLE_ARG, DEFAULT_KEY),
            Err(UpsertError::UnsupportedLayout)
        );
        // Clean input: checked and legacy agree byte for byte.
        assert!(!has_unsupported_binding_layout(SNIPPET, TOGGLE_ARG));
        assert_eq!(
            try_upsert_binding(SNIPPET, EXE, TOGGLE_ARG, "Alt+Space").unwrap(),
            upsert_binding(SNIPPET, EXE, TOGGLE_ARG, "Alt+Space")
        );
        // Duplicates collapse through the checked path too.
        let dup = "binds {\n    Mod+A { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n    Mod+B { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n}\n";
        let fixed = try_upsert_binding(dup, EXE, TOGGLE_ARG, DEFAULT_KEY).unwrap();
        assert_eq!(fixed.matches("--toggle").count(), 1);
    }

    const RULES_SNIPPET: &str = concat!(
        "// Gentle Dot on Niri\n",
        "window-rule {\n",
        "    match title=\"^Gentle Dot Panel$\"\n",
        "    open-floating true\n",
        "}\n",
        "\n",
        "binds {\n",
        "    Alt+Space hotkey-overlay-title=\"Gentle Dot\" { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
        "}\n",
    );

    #[test]
    fn decorations_already_present_leave_text_unchanged() {
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "    border { off; }\n",
            "    focus-ring { off; }\n",
            "    shadow { off; }\n",
            "}\n",
        );
        assert_eq!(ensure_decorations_off(text), text);
        // Idempotent: a second pass is still byte-identical.
        assert_eq!(ensure_decorations_off(&ensure_decorations_off(text)), text);
    }

    #[test]
    fn decorations_missing_inside_an_existing_block_are_inserted() {
        let fixed = ensure_decorations_off(RULES_SNIPPET);
        assert!(fixed.contains("border { off; }"));
        assert!(fixed.contains("focus-ring { off; }"));
        assert!(fixed.contains("shadow { off; }"));
        // Every other byte survives: comment, match, binds line.
        assert!(fixed.contains("// Gentle Dot on Niri"));
        assert!(fixed.contains("match title=\"^Gentle Dot Panel$\""));
        assert!(fixed.contains("open-floating true"));
        assert!(fixed.contains("Alt+Space"));
        // Removing the inserted lines restores the original bytes exactly.
        let mut stripped = fixed.clone();
        for rule in ["    border { off; }\n", "    focus-ring { off; }\n", "    shadow { off; }\n"] {
            assert!(stripped.contains(rule), "missing inserted line: {rule}");
            stripped = stripped.replacen(rule, "", 1);
        }
        assert_eq!(stripped, RULES_SNIPPET);
        // And the fixed text is now stable.
        assert_eq!(ensure_decorations_off(&fixed), fixed);
    }

    #[test]
    fn decorations_cover_both_title_blocks() {
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot$\"\n",
            "    open-floating true\n",
            "}\n",
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "}\n",
        );
        let fixed = ensure_decorations_off(text);
        assert_eq!(fixed.matches("border { off; }").count(), 2);
        assert_eq!(fixed.matches("focus-ring { off; }").count(), 2);
        assert_eq!(fixed.matches("shadow { off; }").count(), 2);
        assert_eq!(ensure_decorations_off(&fixed), fixed);
    }

    #[test]
    fn decorations_ignore_snippets_without_a_matching_block() {
        let text = "binds {\n    Alt+Space { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n}\n";
        assert_eq!(ensure_decorations_off(text), text);
        let foreign = "window-rule {\n    match title=\"^Other App$\"\n    open-floating true\n}\n";
        assert_eq!(ensure_decorations_off(foreign), foreign);
        assert_eq!(ensure_decorations_off(""), "");
        // A commented match never counts as a block to repair.
        let commented = "// window-rule {\n//     match title=\"^Gentle Dot Panel$\"\n";
        assert_eq!(ensure_decorations_off(commented), commented);
    }

    #[test]
    fn decorations_tolerate_duplicates_and_whitespace() {
        // Odd spacing still reads as present: no write, no dedup.
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    border{off;}\n",
            "    focus-ring   {  off ;  }\n",
            "    shadow {\n",
            "        off;\n",
            "    }\n",
            "}\n",
        );
        assert_eq!(ensure_decorations_off(text), text);
        // A partial block gains only the missing lines.
        let partial = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    border { off; }\n",
            "    border { off; }\n",
            "}\n",
        );
        let fixed = ensure_decorations_off(partial);
        assert_eq!(fixed.matches("border { off; }").count(), 2, "duplicates are kept, never deduped");
        assert_eq!(fixed.matches("focus-ring { off; }").count(), 1);
        assert_eq!(fixed.matches("shadow { off; }").count(), 1);
    }

    #[test]
    fn heal_rewrites_on_in_place_without_a_second_block() {
        // Advisory 1 RED: an owned block with `border { on; }` must end
        // with exactly one border rule, in off form (`on` wins over `off`
        // in Niri, so appending a second block would heal nothing).
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "    border { on; }\n",
            "    focus-ring { on; }\n",
            "    shadow { on; }\n",
            "}\n",
        );
        let fixed = ensure_decorations_off(text);
        assert_eq!(fixed.matches("border").count(), 1, "one border rule: {fixed}");
        assert_eq!(fixed.matches("focus-ring").count(), 1, "one focus-ring rule: {fixed}");
        assert_eq!(fixed.matches("shadow").count(), 1, "one shadow rule: {fixed}");
        assert!(fixed.contains("border { off; }"), "off form: {fixed}");
        assert!(fixed.contains("focus-ring { off; }"), "off form: {fixed}");
        assert!(fixed.contains("shadow { off; }"), "off form: {fixed}");
        assert!(!fixed.contains("on;"), "no surviving on: {fixed}");
        // Converges: the healed bytes are a fixed point.
        assert_eq!(ensure_decorations_off(&fixed), fixed);
    }

    #[test]
    fn heal_leaves_foreign_on_blocks_and_missing_blocks_untouched() {
        let foreign = concat!(
            "window-rule {\n",
            "    match title=\"^Other App$\"\n",
            "    border { on; }\n",
            "}\n",
        );
        assert_eq!(ensure_decorations_off(foreign), foreign);
        let no_block = "binds {\n    Mod+Q { close-window; }\n}\n";
        assert_eq!(ensure_decorations_off(no_block), no_block);
    }

    #[test]
    fn heal_finds_a_brace_on_the_next_line() {
        // Advisory 3: a `window-rule` whose `{` is not on the declaration
        // line is healed, never silently skipped.
        let text = concat!(
            "window-rule\n",
            "{\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "}\n",
        );
        let fixed = ensure_decorations_off(text);
        assert!(fixed.contains("border { off; }"), "healed: {fixed}");
        assert!(fixed.contains("focus-ring { off; }"), "healed: {fixed}");
        assert!(fixed.contains("shadow { off; }"), "healed: {fixed}");
        assert!(fixed.starts_with("window-rule\n{\n"), "layout kept: {fixed}");
        assert_eq!(ensure_decorations_off(&fixed), fixed);
    }

    #[test]
    fn open_focused_false_is_added_to_owned_blocks() {
        // Rose-only must never take focus on map: the compositor rule stops
        // the startup steal at the source, where client code cannot.
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "}\n",
        );
        let fixed = ensure_open_focused_off(text);
        assert_eq!(fixed.matches("open-focused").count(), 1, "one rule: {fixed}");
        assert!(fixed.contains("open-focused false"), "off form: {fixed}");
        assert_eq!(ensure_open_focused_off(&fixed), fixed);
    }

    #[test]
    fn open_focused_true_is_rewritten_in_place() {
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "    open-focused true\n",
            "}\n",
        );
        let fixed = ensure_open_focused_off(text);
        assert_eq!(fixed.matches("open-focused").count(), 1, "one rule: {fixed}");
        assert!(fixed.contains("open-focused false"), "off form: {fixed}");
        assert!(!fixed.contains("open-focused true"), "no surviving true: {fixed}");
        assert_eq!(ensure_open_focused_off(&fixed), fixed);
    }

    #[test]
    fn open_focused_false_is_stable_and_foreign_untouched() {
        let text = concat!(
            "window-rule {\n",
            "    match title=\"^Gentle Dot Panel$\"\n",
            "    open-floating true\n",
            "    open-focused false\n",
            "}\n",
        );
        assert_eq!(ensure_open_focused_off(text), text);
        assert_eq!(ensure_open_focused_off(&ensure_open_focused_off(text)), text);
        let foreign = concat!(
            "window-rule {\n",
            "    match title=\"^Other App$\"\n",
            "    open-focused true\n",
            "}\n",
        );
        assert_eq!(ensure_open_focused_off(foreign), foreign);
        assert_eq!(ensure_open_focused_off(""), "");
    }
}
