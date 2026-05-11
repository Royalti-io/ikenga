//! Phase 3: convert an ACP `PromptRequest` into the plain-text payload our
//! existing `claude::session::send_user_message` already accepts, and map the
//! `Done.stop_reason` string back to the ACP `StopReason` enum.
//!
//! Phase 7: `extract_content` extends the same shape to capture image
//! content blocks too, returning a richer `PromptContent { text, images }`.
//! `extract_text` is retained (delegating to `extract_content`) for any
//! caller that genuinely only wants the text path — the legacy `claude-cli`
//! adapter doesn't yet know how to ferry images and would crash on one.
//!
//! This module is intentionally pure: extraction and mapping only. The
//! actual stdin write + event subscription lives in
//! `acp::server::handle_prompt` so the I/O path can be tested manually via
//! the iyke smoke binding rather than mocked here.
//!
//! ## Content-block policy
//!
//! `ContentBlock::Text` and `ContentBlock::Image` are supported. Multiple
//! text blocks are joined with a single newline — the same join the user
//! would type if they were pressing Enter between paragraphs. Audio /
//! resource_link / embedded resource variants return `Err(...)` so the
//! frontend gets a clear "not yet" rather than a silent drop.

use agent_client_protocol::schema::{ContentBlock, PromptRequest, StopReason};

/// Structured prompt payload. `text` is the joined text content; `images`
/// is the list of image attachments in the order they appeared in the
/// prompt. Either may be empty individually, but not both — `extract_content`
/// errors if the prompt has zero usable content.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptContent {
    pub text: String,
    pub images: Vec<PromptImage>,
}

/// One image attachment, normalized to the shape claude's stream-json
/// envelope wants: raw base64 data (no `data:` prefix) + a mime type.
/// `uri` is intentionally dropped — claude doesn't fetch by URL on input,
/// only the base64 source matters on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptImage {
    pub mime_type: String,
    pub base64_data: String,
}

/// Default text used when the prompt is image-only. Claude's stream-json
/// path requires content of some shape; an empty user-text alongside an
/// image is technically valid in the Anthropic API but we've observed
/// flaky behavior in claude-cli. Substituting a short explicit prompt
/// gives the model something to anchor on and matches what most chat UIs
/// do for image-only sends.
const DEFAULT_IMAGE_ONLY_PROMPT: &str = "Analyze this image.";

/// Phase 7: pull text + images out of a `PromptRequest.prompt`.
///
/// Returns `Err` on unsupported variants (audio / resource / resource_link)
/// or if the prompt yields neither text nor images (an empty Vec is not a
/// valid prompt — claude will reject it).
///
/// If the prompt is image-only (no text blocks), `text` is defaulted to
/// `DEFAULT_IMAGE_ONLY_PROMPT` so claude has something to ground the turn
/// on. See module header for rationale.
pub fn extract_content(req: &PromptRequest) -> Result<PromptContent, String> {
    if req.prompt.is_empty() {
        return Err("prompt contains no content blocks".to_string());
    }
    let mut text_parts: Vec<&str> = Vec::with_capacity(req.prompt.len());
    let mut images: Vec<PromptImage> = Vec::new();
    for (idx, block) in req.prompt.iter().enumerate() {
        match block {
            ContentBlock::Text(t) => text_parts.push(t.text.as_str()),
            ContentBlock::Image(img) => {
                images.push(PromptImage {
                    mime_type: img.mime_type.clone(),
                    base64_data: img.data.clone(),
                });
            }
            ContentBlock::Audio(_) => {
                return Err(format!(
                    "audio content blocks are not supported yet; got audio at index {idx}",
                ));
            }
            ContentBlock::ResourceLink(_) => {
                return Err(format!(
                    "resource_link content blocks are not supported yet; got resource_link at index {idx}",
                ));
            }
            ContentBlock::Resource(_) => {
                return Err(format!(
                    "resource content blocks are not supported yet; got resource at index {idx}",
                ));
            }
            // The schema enum is `#[non_exhaustive]`; cover future variants
            // explicitly rather than silently coercing.
            _ => {
                return Err(format!(
                    "unsupported content block variant at index {idx}",
                ));
            }
        }
    }
    let joined = text_parts.join("\n");
    let text = if joined.is_empty() && !images.is_empty() {
        DEFAULT_IMAGE_ONLY_PROMPT.to_string()
    } else {
        joined
    };
    if text.is_empty() && images.is_empty() {
        return Err("prompt has no usable text or image content".to_string());
    }
    Ok(PromptContent { text, images })
}

/// Pull a single string payload out of a `PromptRequest.prompt`.
///
/// Backwards-compatible wrapper around `extract_content`: errors if any
/// non-text block is present, so legacy callers (any code that still
/// expects "text or bust") get the same refusal they did in Phase 3.
/// Phase 7 callers that want images should use `extract_content` directly.
pub fn extract_text(req: &PromptRequest) -> Result<String, String> {
    let content = extract_content(req)?;
    if !content.images.is_empty() {
        return Err(
            "extract_text() was called on a prompt containing images; use extract_content() instead"
                .to_string(),
        );
    }
    Ok(content.text)
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
    fn prompt_with_image_block_extract_text_returns_error() {
        // `extract_text` is the legacy text-only path. With images present
        // it now refuses (and points the caller at `extract_content`)
        // rather than blanket-rejecting at the variant match — the error
        // message changed in Phase 7.
        let img = ImageContent::new("base64==".to_string(), "image/png".to_string());
        let r = req(vec![ContentBlock::Image(img)]);
        let err = extract_text(&r).unwrap_err();
        assert!(
            err.contains("extract_content"),
            "expected hint about extract_content, got: {err}"
        );
    }

    #[test]
    fn prompt_with_resource_link_returns_error() {
        let link = ResourceLink::new("file", "file:///tmp/x");
        let r = req(vec![ContentBlock::ResourceLink(link)]);
        let err = extract_text(&r).unwrap_err();
        assert!(err.contains("resource_link"), "got: {err}");
    }

    // ── Phase 7: extract_content ──────────────────────────────────────

    #[test]
    fn extract_content_handles_pure_text() {
        let r = req(vec![ContentBlock::Text(TextContent::new("hello world"))]);
        let content = extract_content(&r).expect("ok");
        assert_eq!(content.text, "hello world");
        assert!(content.images.is_empty());
    }

    #[test]
    fn extract_content_handles_pure_image() {
        // Image-only prompts are valid for "what's in this?" use cases;
        // we default `text` to a short anchor so claude has something to
        // ground on (documented at the module level).
        let img = ImageContent::new("aGVsbG8=".to_string(), "image/png".to_string());
        let r = req(vec![ContentBlock::Image(img)]);
        let content = extract_content(&r).expect("ok");
        assert_eq!(content.text, "Analyze this image.");
        assert_eq!(content.images.len(), 1);
        assert_eq!(content.images[0].mime_type, "image/png");
        assert_eq!(content.images[0].base64_data, "aGVsbG8=");
    }

    #[test]
    fn extract_content_handles_mixed_text_and_image() {
        let img = ImageContent::new("aGVsbG8=".to_string(), "image/jpeg".to_string());
        let r = req(vec![
            ContentBlock::Text(TextContent::new("what is in this?")),
            ContentBlock::Image(img),
        ]);
        let content = extract_content(&r).expect("ok");
        assert_eq!(content.text, "what is in this?");
        assert_eq!(content.images.len(), 1);
        assert_eq!(content.images[0].mime_type, "image/jpeg");
    }

    #[test]
    fn extract_content_joins_multiple_text_blocks() {
        let r = req(vec![
            ContentBlock::Text(TextContent::new("line one")),
            ContentBlock::Text(TextContent::new("line two")),
        ]);
        let content = extract_content(&r).expect("ok");
        assert_eq!(content.text, "line one\nline two");
    }

    #[test]
    fn extract_content_errors_on_unsupported_audio_block() {
        use agent_client_protocol::schema::AudioContent;
        let audio = AudioContent::new("aGVsbG8=".to_string(), "audio/mpeg".to_string());
        let r = req(vec![ContentBlock::Audio(audio)]);
        let err = extract_content(&r).unwrap_err();
        assert!(err.contains("audio"), "got: {err}");
    }

    #[test]
    fn extract_content_errors_on_completely_empty_prompt() {
        let r = req(vec![]);
        let err = extract_content(&r).unwrap_err();
        assert!(err.contains("no content blocks"), "got: {err}");
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
