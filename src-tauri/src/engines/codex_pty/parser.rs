//! Pure-function parser for the codex CLI's PTY byte stream.
//!
//! The codex TUI looks roughly like this on a fresh prompt:
//!
//! ```text
//! ╭─────────────────────────────────────────────╮
//! │  Codex 0.4.1 — gpt-5 (medium)               │
//! ╰─────────────────────────────────────────────╯
//! >>> hello
//! Hello! How can I help today?
//! ❯
//! ```
//!
//! We don't try to be clever about anchoring the parse to the prompt's
//! visual box. ANSI cursor positioning makes that fragile across terminal
//! widths. Instead we:
//!
//!   1. Strip ANSI escape sequences from the chunk (CSI, OSC, etc.).
//!   2. Split on `\n`.
//!   3. Drop empty lines, lines starting with box-drawing chars
//!      (`╭ │ ╰ ╮ ╯ ─`), and the user-echo prefix (`>>> `, `>> `, `> `).
//!   4. Emit each surviving line as an `agent_message_chunk` with a
//!      single-text content block.
//!
//! Heuristic for "turn done": the parser knows about an idle-prompt marker
//! (`is_done_marker`). The engine loop calls this on every line and returns
//! from the prompt handler when it sees `true`. A 60s wallclock timeout
//! (enforced engine-side) guards against the marker never showing up.

use agent_client_protocol::schema::{ContentBlock, ContentChunk, SessionUpdate, TextContent};

/// Codex's idle prompt is `❯ ` (U+276F). Older builds use `› ` (U+203A).
/// Either at column zero (after the leading whitespace strip below) signals
/// "the model is done streaming, awaiting next input". We're permissive:
/// the marker might appear bare (`❯`) or followed by trailing whitespace
/// from cursor positioning leftovers.
const DONE_MARKERS: &[&str] = &["❯", "›"];

/// Lines starting with these characters are part of the TUI's drawn chrome
/// and never carry assistant content. We drop them outright.
const BOX_DRAWING_PREFIXES: &[char] = &['╭', '╮', '╰', '╯', '│', '─', '━', '┃', '┌', '┐', '└', '┘'];

/// Parse a raw PTY chunk into zero or more `SessionUpdate`s.
///
/// Pure function — easy to test against a recorded byte stream without
/// spawning a child. Returns an empty vec when the chunk is all chrome /
/// whitespace; the engine loop just keeps reading.
pub fn parse_chunk(chunk: &[u8]) -> Vec<SessionUpdate> {
    let stripped = strip_ansi_escapes::strip(chunk);
    let text = String::from_utf8_lossy(&stripped);

    let mut updates = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim_end_matches(['\r', ' ', '\t']);
        if trimmed.is_empty() {
            continue;
        }
        // The done-marker may share a line with cursor-position garbage;
        // detect it but don't emit anything (the engine sees this via its
        // own `is_done_marker` pass on the same stripped text).
        if is_done_marker(trimmed) {
            continue;
        }
        if is_chrome(trimmed) {
            continue;
        }
        if is_user_echo(trimmed) {
            continue;
        }
        updates.push(make_chunk(trimmed));
    }
    updates
}

/// True when the line is (or contains, at its leading edge) codex's idle
/// prompt marker. Tolerant of leading whitespace, since cursor positioning
/// can leave a few spaces in front of `❯`.
pub fn is_done_marker(line: &str) -> bool {
    let leading = line.trim_start();
    if leading.is_empty() {
        return false;
    }
    DONE_MARKERS.iter().any(|m| leading.starts_with(m))
}

fn is_chrome(line: &str) -> bool {
    let leading = line.trim_start();
    let Some(first) = leading.chars().next() else {
        return false;
    };
    BOX_DRAWING_PREFIXES.contains(&first)
}

/// Codex echoes the user's prompt back as `>>> hello` (or `>> ` / `> `)
/// before the assistant response. We don't want to surface that as
/// assistant content.
fn is_user_echo(line: &str) -> bool {
    let leading = line.trim_start();
    leading.starts_with(">>>") || leading.starts_with(">> ") || leading.starts_with("> ")
}

fn make_chunk(text: &str) -> SessionUpdate {
    let block = ContentBlock::Text(TextContent::new(text.to_string()));
    let chunk = ContentChunk::new(block);
    SessionUpdate::AgentMessageChunk(chunk)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extract the text payload from an `AgentMessageChunk` for test
    /// assertions. Panics if the variant isn't a text chunk — fine for
    /// tests, the parser is the only producer here.
    fn chunk_text(u: &SessionUpdate) -> &str {
        match u {
            SessionUpdate::AgentMessageChunk(c) => match &c.content {
                ContentBlock::Text(t) => t.text.as_str(),
                _ => panic!("non-text content block"),
            },
            other => panic!("expected AgentMessageChunk, got {other:?}"),
        }
    }

    #[test]
    fn strips_ansi_csi_color_sequences() {
        // `\x1b[31m` = red foreground; `\x1b[0m` = reset. Real codex output
        // is liberally sprinkled with these.
        let raw = b"\x1b[31mHello\x1b[0m world\n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Hello world");
    }

    #[test]
    fn strips_ansi_cursor_positioning() {
        // `\x1b[2J` = clear screen, `\x1b[H` = move cursor to home, then
        // text. All three should collapse to just the text.
        let raw = b"\x1b[2J\x1b[HReady\n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Ready");
    }

    #[test]
    fn drops_box_drawing_chrome() {
        let raw = "╭──────────╮\n│  Codex   │\n╰──────────╯\nHi\n".as_bytes();
        let out = parse_chunk(raw);
        // The only surviving line is "Hi" — all box-drawing lines drop.
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Hi");
    }

    #[test]
    fn drops_user_echo_lines() {
        let raw = b">>> write a haiku\nClouds drift past the moon\n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Clouds drift past the moon");
    }

    #[test]
    fn drops_blank_and_whitespace_only_lines() {
        let raw = b"\n   \n\t\nHello\n\n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Hello");
    }

    #[test]
    fn done_marker_detected_on_bare_glyph() {
        assert!(is_done_marker("❯"));
        assert!(is_done_marker("❯ "));
        assert!(is_done_marker("  ❯"));
        assert!(is_done_marker("›"));
        assert!(is_done_marker("› "));
    }

    #[test]
    fn done_marker_not_triggered_by_content() {
        assert!(!is_done_marker("Hello"));
        assert!(!is_done_marker("> not a marker"));
        assert!(!is_done_marker(">>> echo"));
        assert!(!is_done_marker(""));
        assert!(!is_done_marker("   "));
    }

    #[test]
    fn done_marker_line_is_not_emitted_as_content() {
        let raw = "Reply text\n❯ \n".as_bytes();
        let out = parse_chunk(raw);
        // Reply line emits; the prompt-marker line drops.
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Reply text");
    }

    #[test]
    fn handles_combined_chrome_and_ansi() {
        // Realistic-shape codex chunk: ANSI-styled box around plain text,
        // then an answer, then the idle marker.
        let raw = b"\x1b[2J\x1b[H\x1b[1m\xe2\x95\xad\xe2\x94\x80\xe2\x95\xae\x1b[0m\n\
            \x1b[1m\xe2\x94\x82\x1b[0m hi \x1b[1m\xe2\x94\x82\x1b[0m\n\
            \x1b[1m\xe2\x95\xb0\xe2\x94\x80\xe2\x95\xaf\x1b[0m\n\
            Hello there\n\xe2\x9d\xaf \n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(chunk_text(&out[0]), "Hello there");
    }

    #[test]
    fn multiple_content_lines_each_emit() {
        let raw = b"Line one\nLine two\nLine three\n";
        let out = parse_chunk(raw);
        assert_eq!(out.len(), 3);
        assert_eq!(chunk_text(&out[0]), "Line one");
        assert_eq!(chunk_text(&out[1]), "Line two");
        assert_eq!(chunk_text(&out[2]), "Line three");
    }

    #[test]
    fn empty_input_yields_no_updates() {
        assert!(parse_chunk(b"").is_empty());
        assert!(parse_chunk(b"\n\n\n").is_empty());
    }
}
