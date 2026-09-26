//! Input hardening. Every value that originates from a client and is later
//! echoed to other clients passes through here first: HTML tags and control
//! characters are stripped, lengths are capped, and identifiers are restricted
//! to a safe alphabet so nothing can be used as an injection vector.

/// Strip `<...>` tags and ASCII/C1 control characters, trim, then cap length
/// (by Unicode scalar values, not bytes).
///
/// The length cap is applied FIRST, not last. Every step below allocates a
/// fresh String the size of its input, so capping at the end meant a 64 MB
/// frame (axum's default max_message_size) cost ~200 MB of transient
/// allocation before being truncated to a 32-character nickname. The cap is
/// generous -- 4x max_len -- so that tags and control characters stripped
/// later cannot push legitimate input over the limit.
pub fn sanitize_text(input: &str, max_len: usize) -> String {
    let bounded: String = input.chars().take(max_len.saturating_mul(4)).collect();
    let no_tags = strip_tags(&bounded);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_length_by_scalar_values() {
        assert_eq!(sanitize_text("abcdef", 3), "abc");
        assert_eq!(sanitize_text("héllo wörld", 5).chars().count(), 5);
    }

    /// The pre-cap must not change results for input within the limit, even
    /// when most of it is stripped as tags or control characters.
    #[test]
    fn early_cap_does_not_truncate_legitimate_input() {
        let noisy = "<b><i><em><strong>hi</strong></em></i></b>";
        assert_eq!(sanitize_text(noisy, 8), "hi");
        let controls = "a\u{0}\u{1}\u{2}\u{3}\u{4}\u{5}\u{6}\u{7}b";
        assert_eq!(sanitize_text(controls, 4), "ab");
    }

    #[test]
    fn huge_input_is_bounded_and_still_correct() {
        let huge = "x".repeat(1_000_000);
        assert_eq!(sanitize_text(&huge, 32).chars().count(), 32);
    }

    #[test]
    fn strips_tags_and_controls() {
        assert_eq!(sanitize_text("<script>alert(1)</script>hi", 64), "alert(1)hi");
        assert_eq!(sanitize_text("  spaced  ", 64), "spaced");
    }

    #[test]
    fn nickname_falls_back_to_guest() {
        assert_eq!(sanitize_nickname("   ", 32), "guest");
        assert_eq!(sanitize_nickname("<>", 32), "guest");
        assert_eq!(sanitize_nickname("Ada", 32), "Ada");
    }
}
