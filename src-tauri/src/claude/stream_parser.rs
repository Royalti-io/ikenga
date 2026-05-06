//! Incremental parser for `claude --output-format stream-json --verbose`.
//!
//! Bytes arrive from the PTY in arbitrary chunks. We buffer until `\n`, then
//! parse each line as a JSON envelope. Top-level envelope types captured
//! 2026-04-30 against Claude Code v2.1.123:
//!
//! | type                | subtype        | meaning                     |
//! |---------------------|----------------|-----------------------------|
//! | `system`            | `init`         | session bootstrap           |
//! | `system`            | `hook_started` | hook lifecycle              |
//! | `system`            | `hook_response`| hook lifecycle              |
//! | `assistant`         | —              | wraps an Anthropic message  |
//! | `user`              | —              | wraps tool_result blocks    |
//! | `rate_limit_event`  | —              | passthrough                 |
//! | `result`            | success/error  | final summary               |
//!
//! Inside `assistant.message.content[]` and `user.message.content[]` we walk
//! Anthropic-style blocks: `text`, `thinking`, `tool_use`, `tool_result`.

use serde_json::Value;

use super::event::ChatEvent;

#[derive(Default)]
pub struct StreamParser {
    /// Accumulator for the current incomplete line.
    buf: Vec<u8>,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed PTY bytes; emit zero or more parsed events.
    ///
    /// Lines are LF-delimited. CR is tolerated. Anything that is not valid
    /// JSON yields a `ParseError` event and the parser continues — never
    /// poison the stream over a single bad line.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ChatEvent> {
        let mut out = Vec::new();
        for byte in bytes {
            match *byte {
                b'\n' => {
                    let line = std::mem::take(&mut self.buf);
                    let line = strip_cr(line);
                    if !line.is_empty() {
                        self.dispatch_line(&line, &mut out);
                    }
                }
                _ => self.buf.push(*byte),
            }
        }
        out
    }

    fn dispatch_line(&self, line: &[u8], out: &mut Vec<ChatEvent>) {
        let text = match std::str::from_utf8(line) {
            Ok(t) => t,
            Err(_) => {
                out.push(ChatEvent::ParseError {
                    message: "non-utf8 line".into(),
                    line: String::from_utf8_lossy(line).to_string(),
                });
                return;
            }
        };
        // Lines that aren't JSON are almost always claude TUI noise that
        // leaked when stream-json wasn't honored — surface, but don't choke.
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                out.push(ChatEvent::ParseError {
                    message: format!("json: {e}"),
                    line: text.to_string(),
                });
                return;
            }
        };
        dispatch_envelope(&value, out);
    }
}

fn strip_cr(mut buf: Vec<u8>) -> Vec<u8> {
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    buf
}

/// Dispatch a single parsed envelope. Shared with the on-disk jsonl reader,
/// which builds the same event vector by feeding lines one at a time.
pub(crate) fn dispatch_envelope(value: &Value, out: &mut Vec<ChatEvent>) {
    let envelope_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match envelope_type {
        "system" => dispatch_system(value, out),
        "assistant" => dispatch_assistant(value, out),
        "user" => dispatch_user(value, out),
        "result" => out.push(ChatEvent::Done {
            usage: value.get("usage").cloned(),
            total_cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            stop_reason: value
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            duration_ms: value.get("duration_ms").and_then(Value::as_u64),
        }),
        "rate_limit_event" => out.push(ChatEvent::RateLimit {
            info: value.clone(),
        }),
        // Internal/control envelopes — JSONL bookkeeping that's not part of
        // the conversation. Drop silently; they're noise to the chat feed.
        "attachment" | "queue-operation" | "last-prompt" | "skill_listing"
        | "deferred_tools_delta" | "command_permissions" => {}
        _ => out.push(ChatEvent::Unknown {
            raw: value.clone(),
        }),
    }
}

fn dispatch_system(value: &Value, out: &mut Vec<ChatEvent>) {
    let subtype = value
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("");
    match subtype {
        "init" => out.push(ChatEvent::SessionInit {
            session_id: value
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            model: value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            cwd: value
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string),
            permission_mode: value
                .get("permissionMode")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "hook_started" | "hook_response" => out.push(ChatEvent::SystemHook {
            hook_event: subtype.to_string(),
            name: value
                .get("hookName")
                .and_then(Value::as_str)
                .map(str::to_string),
            content: Some(value.clone()),
        }),
        _ => out.push(ChatEvent::Unknown {
            raw: value.clone(),
        }),
    }
}

fn dispatch_assistant(value: &Value, out: &mut Vec<ChatEvent>) {
    let parent_tool_use_id = value
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array);
    let blocks = match content {
        Some(b) => b,
        None => {
            out.push(ChatEvent::Unknown {
                raw: value.clone(),
            });
            return;
        }
    };
    for block in blocks {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        match block_type {
            "text" => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    out.push(ChatEvent::Text {
                        delta: t.to_string(),
                    });
                }
            }
            "thinking" => {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    out.push(ChatEvent::Thinking {
                        delta: t.to_string(),
                    });
                }
            }
            "tool_use" => out.push(ChatEvent::ToolUse {
                id: block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: block.get("input").cloned().unwrap_or(Value::Null),
                parent_tool_use_id: parent_tool_use_id.clone(),
            }),
            _ => out.push(ChatEvent::Unknown {
                raw: block.clone(),
            }),
        }
    }
}

fn dispatch_user(value: &Value, out: &mut Vec<ChatEvent>) {
    let parent_tool_use_id = value
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = value.get("message").and_then(|m| m.get("content"));
    // user.message.content is sometimes a plain string (slash-command echoes),
    // sometimes an array of blocks. Only the array form carries tool_result.
    let blocks = match content.and_then(Value::as_array) {
        Some(b) => b,
        None => return,
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            out.push(ChatEvent::ToolResult {
                id: block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output: block.get("content").cloned().unwrap_or(Value::Null),
                is_error: block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                parent_tool_use_id: parent_tool_use_id.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_kind(events: &[ChatEvent]) -> &'static str {
        match events.first() {
            Some(ChatEvent::SessionInit { .. }) => "session_init",
            Some(ChatEvent::Text { .. }) => "text",
            Some(ChatEvent::Thinking { .. }) => "thinking",
            Some(ChatEvent::ToolUse { .. }) => "tool_use",
            Some(ChatEvent::ToolResult { .. }) => "tool_result",
            Some(ChatEvent::Done { .. }) => "done",
            Some(ChatEvent::RateLimit { .. }) => "rate_limit",
            Some(ChatEvent::SystemHook { .. }) => "system_hook",
            Some(ChatEvent::Artifact { .. }) => "artifact",
            Some(ChatEvent::Unknown { .. }) => "unknown",
            Some(ChatEvent::ParseError { .. }) => "parse_error",
            None => "<none>",
        }
    }

    #[test]
    fn parses_system_init() {
        let mut p = StreamParser::new();
        let line = br#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-4-7","cwd":"/x","permissionMode":"default"}
"#;
        let events = p.feed(line);
        assert_eq!(events.len(), 1);
        assert_eq!(first_kind(&events), "session_init");
        match &events[0] {
            ChatEvent::SessionInit {
                session_id, model, ..
            } => {
                assert_eq!(session_id, "abc");
                assert_eq!(model.as_deref(), Some("claude-opus-4-7"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn parses_assistant_tool_use() {
        let mut p = StreamParser::new();
        let line = br#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]},"parent_tool_use_id":null}
"#;
        let events = p.feed(line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::ToolUse { id, name, .. } => {
                assert_eq!(id, "toolu_1");
                assert_eq!(name, "Bash");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_with_parent() {
        let mut p = StreamParser::new();
        let line = br#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]},"parent_tool_use_id":"toolu_parent"}
"#;
        let events = p.feed(line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::ToolResult {
                id,
                is_error,
                parent_tool_use_id,
                ..
            } => {
                assert_eq!(id, "toolu_1");
                assert!(!is_error);
                assert_eq!(parent_tool_use_id.as_deref(), Some("toolu_parent"));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn parses_done_with_cost() {
        let mut p = StreamParser::new();
        let line = br#"{"type":"result","subtype":"success","total_cost_usd":0.351,"stop_reason":"end_turn","duration_ms":7028}
"#;
        let events = p.feed(line);
        match &events[0] {
            ChatEvent::Done {
                total_cost_usd,
                stop_reason,
                duration_ms,
                ..
            } => {
                assert!((total_cost_usd.unwrap() - 0.351).abs() < 1e-6);
                assert_eq!(stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(*duration_ms, Some(7028));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn handles_partial_lines() {
        let mut p = StreamParser::new();
        let part1 = br#"{"type":"assistant","message":{"content":[{"type":"text","text":"hel"#;
        let part2 = br#"lo"}]},"parent_tool_use_id":null}
"#;
        let mut events = p.feed(part1);
        assert!(events.is_empty(), "no newline yet");
        events = p.feed(part2);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::Text { delta } => assert_eq!(delta, "hello"),
            _ => unreachable!(),
        }
    }

    #[test]
    fn malformed_line_yields_parse_error_and_continues() {
        let mut p = StreamParser::new();
        let bytes = b"this is not json\n{\"type\":\"result\",\"subtype\":\"success\"}\n";
        let events = p.feed(bytes);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], ChatEvent::ParseError { .. }));
        assert!(matches!(events[1], ChatEvent::Done { .. }));
    }

    #[test]
    fn tolerates_crlf() {
        let mut p = StreamParser::new();
        let bytes = b"{\"type\":\"result\",\"subtype\":\"success\"}\r\n";
        let events = p.feed(bytes);
        assert!(matches!(events[0], ChatEvent::Done { .. }));
    }
}
