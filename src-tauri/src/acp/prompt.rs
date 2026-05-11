//! Phase 3: convert an ACP `PromptRequest` into the plain-text payload our
//! existing `claude::session::send_user_message` already accepts, and map the
//! `Done.stop_reason` string back to the ACP `StopReason` enum.
//!
//! This module is intentionally pure: extraction and mapping only. The
//! actual stdin write + event subscription lives in
//! `acp::server::handle_prompt` so the I/O path can be tested manually via
//! the iyke smoke binding rather than mocked here.
//!
//! ## Content-block policy (Phase 3)
//!
//! Only `ContentBlock::Text` is supported. Multiple text blocks are joined
//! with a single newline — the same join the user would type if they were
//! pressing Enter between paragraphs. Image / audio / resource_link /
//! embedded resource variants return `Err(...)` so the frontend gets a clear
//! "not yet" rather than a silent drop. Image input arrives in Phase 7.

use agent_client_protocol::schema::{ContentBlock, PromptRequest, StopReason};

/// Pull a single string payload out of a `PromptRequest.prompt`.
///
/// Returns `Err` if any non-text variant is present — Phase 3 doesn't yet
/// know how to ferry images / resources through the stream-json envelope
/// and we'd rather refuse than misrepresent.
pub fn extract_text(req: &PromptRequest) -> Result<String, String> {
    let mut parts: Vec<&str> = Vec::with_capacity(req.prompt.len());
    for (idx, block) in req.prompt.iter().enumerate() {
        match block {
            ContentBlock::Text(t) => parts.push(t.text.as_str()),
            ContentBlock::Image(_) => {
                return Err(format!(
                    "Phase 3 only supports text content blocks; got image at index {idx}",
                ));
            }
            ContentBlock::Audio(_) => {
                return Err(format!(
                    "Phase 3 only supports text content blocks; got audio at index {idx}",
                ));
            }
            ContentBlock::ResourceLink(_) => {
                return Err(format!(
                    "Phase 3 only supports text content blocks; got resource_link at index {idx}",
                ));
            }
            ContentBlock::Resource(_) => {
                return Err(format!(
                    "Phase 3 only supports text content blocks; got resource at index {idx}",
                ));
            }
            // The schema enum is `#[non_exhaustive]`; cover future variants
            // explicitly rather than silently coercing to text.
            _ => {
                return Err(format!(
                    "Phase 3 only supports text content blocks; got unknown variant at index {idx}",
                ));
            }
        }
    }
    Ok(parts.join("\n"))
}

/// Translate `claude` stream-json `stop_reason` strings into the ACP enum.
/// Unknown / missing reasons fall back to `EndTurn` — claude reliably emits
/// `end_turn` for normal completion; the other variants are best-effort.
pub fn map_stop_reason(raw: Option<&str>) -> StopReason {
    match raw.unwrap_or("end_turn") {
        "end_turn" => StopReason::EndTurn,
        "refusal" => StopReason::Refusal,
        "max_tokens" => StopReason::MaxTokens,
        "max_turn_requests" => StopReason::MaxTurnRequests,
        // The cancelled stop reason is special: spec says we MUST return it
        // when the client sent `session/cancel`. Phase 6 wires up the real
        // path; Phase 3 just maps the string so existing transcripts
        // round-trip cleanly.
        "cancelled" | "canceled" => StopReason::Cancelled,
        _ => StopReason::EndTurn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::{
        ImageContent, ResourceLink, SessionId, TextContent,
    };

    fn req(blocks: Vec<ContentBlock>) -> PromptRequest {
        PromptRequest::new(SessionId::new("sess_test"), blocks)
    }

    #[test]
    fn prompt_with_text_block_extracts_text() {
        let r = req(vec![ContentBlock::Text(TextContent::new("hello"))]);
        assert_eq!(extract_text(&r).unwrap(), "hello");
    }

    #[test]
    fn prompt_with_multiple_text_blocks_concatenates() {
        // Joined with `\n` — the most readable round-trip for a user who
        // structured their prompt as multiple paragraphs. Documented in
        // the module header.
        let r = req(vec![
            ContentBlock::Text(TextContent::new("line one")),
            ContentBlock::Text(TextContent::new("line two")),
        ]);
        assert_eq!(extract_text(&r).unwrap(), "line one\nline two");
    }

    #[test]
    fn prompt_with_image_block_returns_error() {
        let img = ImageContent::new("base64==".to_string(), "image/png".to_string());
        let r = req(vec![ContentBlock::Image(img)]);
        let err = extract_text(&r).unwrap_err();
        assert!(
            err.contains("Phase 3 only supports text"),
            "unexpected error message: {err}"
        );
        assert!(err.contains("image"), "error should name the variant: {err}");
    }

    #[test]
    fn prompt_with_resource_link_returns_error() {
        let link = ResourceLink::new("file", "file:///tmp/x");
        let r = req(vec![ContentBlock::ResourceLink(link)]);
        let err = extract_text(&r).unwrap_err();
        assert!(err.contains("resource_link"), "got: {err}");
    }

    #[test]
    fn stop_reason_mapping() {
        assert_eq!(map_stop_reason(Some("end_turn")), StopReason::EndTurn);
        assert_eq!(map_stop_reason(Some("refusal")), StopReason::Refusal);
        assert_eq!(map_stop_reason(Some("max_tokens")), StopReason::MaxTokens);
        assert_eq!(map_stop_reason(Some("cancelled")), StopReason::Cancelled);
        assert_eq!(map_stop_reason(Some("canceled")), StopReason::Cancelled);
        // Unknown → EndTurn fallback per the spec contract noted above.
        assert_eq!(map_stop_reason(Some("wat")), StopReason::EndTurn);
        // Missing → EndTurn (also the default when the result envelope
        // doesn't carry a stop_reason at all, e.g. very old claude builds).
        assert_eq!(map_stop_reason(None), StopReason::EndTurn);
    }
}
