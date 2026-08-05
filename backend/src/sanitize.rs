//! Input hardening. Every value that originates from a client and is later
//! echoed to other clients passes through here first: HTML tags and control
//! characters are stripped, lengths are capped, and identifiers are restricted
//! to a safe alphabet so nothing can be used as an injection vector.

/// Strip `<...>` tags and ASCII/C1 control characters, trim, then cap length
/// (by Unicode scalar values, not bytes).
pub fn sanitize_text(input: &str, max_len: usize) -> String {
    let no_tags = strip_tags(input);
    let cleaned: String = no_tags.chars().filter(|c| !is_control_like(*c)).collect();
    let trimmed = cleaned.trim();
    trimmed.chars().take(max_len).collect()
}

pub fn sanitize_nickname(input: &str, max_len: usize) -> String {
    let cleaned = sanitize_text(input, max_len);
    if cleaned.is_empty() {
        "guest".to_string()
    } else {
        cleaned
    }
}

pub fn sanitize_chat(input: &str, max_len: usize) -> String {
    sanitize_text(input, max_len)
}

/// Must be an absolute http(s) URL; capped before validation so a megabyte
/// "URL" can't slip through.
pub fn sanitize_url(input: &str, max_len: usize) -> Option<String> {
    let trimmed: String = input.trim().chars().take(max_len).collect();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(trimmed)
    } else {
        None
    }
}

/// A browser-generated stable identity. Restrict to `[A-Za-z0-9_-]` and length
/// so it can never carry a payload when echoed to other clients. Returns `None`
/// for anything shorter than 8 valid characters.
pub fn sanitize_client_id(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if cleaned.len() >= 8 {
        Some(cleaned)
    } else {
        None
    }
}

/// Reactions are short emoji (possibly multi-codepoint, e.g. ❤️). Strip markup
/// and control chars and keep it tiny so it can't carry a wall of text.
pub fn sanitize_reaction(input: &str) -> Option<String> {
    let no_tags = strip_tags(input);
    let cleaned: String = no_tags
        .chars()
        .filter(|c| !is_control_like(*c))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(8).collect())
}

/// Remove everything between `<` and the next `>` (inclusive), matching the
/// legacy `/<[^>]*>/g` behaviour.
fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// ASCII C0 controls (0x00–0x1F), DEL (0x7F), and the C1 range (0x80–0x9F).
fn is_control_like(c: char) -> bool {
    let n = c as u32;
    n <= 0x1f || (0x7f..=0x9f).contains(&n)
}
