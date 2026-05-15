//! Phase 2: pure-function bridge from our `claude::event::ChatEvent` enum
//! to ACP `agent_client_protocol::schema::SessionUpdate` notifications.
//!
//! This module is deliberately I/O-free and state-free. Given a single
//! `ChatEvent`, `chat_event_to_session_updates` returns the zero-or-more
//! `SessionUpdate`s that an ACP client would expect to see for that bit
//! of agent output. Phase 3 will glue this layer into the prompt-handling
//! pipeline so the stream-json events flowing out of `claude` get reframed
//! as ACP `session/update` notifications.
//!
//! ## Mapping table
//!
//! See `<workspace>/plans/shell/docs/acp-migration.md` (Phase 2 section) for the canonical table.
//! Quick reference:
//!
//! | `ChatEvent`        | `SessionUpdate`(s)                                   |
//! |--------------------|------------------------------------------------------|
//! | `Text`             | `AgentMessageChunk(ContentChunk::text)`              |
//! | `Thinking`         | `AgentThoughtChunk(ContentChunk::text)`              |
//! | `ToolUse`          | `ToolCall { status: pending, kind: <see below> }`    |
//! | `ToolResult`       | `ToolCallUpdate { status: completed | failed }`      |
//! | `Artifact`         | *dropped* (the producing tool's `ToolResult` already |
//! |                    | reports the artifact via raw output)                 |
//! | `SessionInit`      | *dropped* (session bootstrap is returned by          |
//! |                    | `session/new`, not streamed)                         |
//! | `SystemHook`       | *dropped* (Phase 9 will surface Notification +       |
//! |                    | PermissionRequest hooks; everything else is          |
//! |                    | diagnostic)                                          |
//! | `RateLimit`        | *dropped* (Phase 9 may add `UsageUpdate`)            |
//! | `Done`             | *dropped* — terminates the `session/prompt` response |
//! | `Unknown`,         | log warn, return empty                               |
//! | `ParseError`       |                                                      |
//!
//! ## Tool kind heuristic
//!
//! ACP's `ToolKind` advertises a small fixed taxonomy. We map Anthropic
//! tool names by string match:
//!
//! | claude tool name                            | `ToolKind` |
//! |---------------------------------------------|------------|
//! | `Read`                                      | `Read`     |
//! | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`| `Edit`     |
//! | `Bash`, `BashOutput`, `KillBash`            | `Execute`  |
//! | `Glob`, `Grep`                              | `Search`   |
//! | `WebFetch`                                  | `Fetch`    |
//! | `WebSearch`                                 | `Search`   |
//! | `Task`, `ExitPlanMode`                      | `Think`    |
//! | (anything else, incl. MCP tools)            | `Other`    |

use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, SessionUpdate, TextContent, ToolCall, ToolCallContent, ToolCallId,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use serde_json::{Map, Value};

use crate::claude::event::ChatEvent;

/// Map a single `ChatEvent` to the zero-or-more `SessionUpdate`s an ACP
/// client should observe. Pure function; no I/O, no allocation outside
/// the returned `Vec`.
pub fn chat_event_to_session_updates(event: &ChatEvent) -> Vec<SessionUpdate> {
    match event {
        ChatEvent::Text { delta, message_id } => {
            vec![SessionUpdate::AgentMessageChunk(text_chunk(
                delta,
                message_id.as_deref(),
            ))]
        }
        ChatEvent::Thinking { delta, message_id } => {
            vec![SessionUpdate::AgentThoughtChunk(text_chunk(
                delta,
                message_id.as_deref(),
            ))]
        }
        ChatEvent::ToolUse {
            id,
            name,
            input,
            parent_tool_use_id,
        } => vec![SessionUpdate::ToolCall(build_tool_call(
            id,
            name,
            input,
            parent_tool_use_id.as_deref(),
        ))],
        ChatEvent::ToolResult {
            id,
            output,
            is_error,
            parent_tool_use_id,
        } => vec![SessionUpdate::ToolCallUpdate(build_tool_result_update(
            id,
            output,
            *is_error,
            parent_tool_use_id.as_deref(),
        ))],

        // The artifact watcher correlates files produced by the previous
        // tool call. The producing tool's own `ToolResult` already carries
        // the same information via `raw_output`, so emitting a second
        // `ToolCallUpdate` would be duplicative. Re-evaluate when we have
        // a concrete UX reason to surface artifacts independently (Phase 9?).
        ChatEvent::Artifact { .. } => Vec::new(),

        // `SessionInit` data ships in the `session/new` response. There is
        // no `SessionUpdate` variant that conveys "session started" —
        // mode/commands updates are separate (CurrentModeUpdate /
        // AvailableCommandsUpdate) and will be wired in Phase 5.
        ChatEvent::SessionInit { .. } => Vec::new(),

        // Most hooks are diagnostic. Phase 9 will fork `Notification` +
        // `PermissionRequest` into OS notifications + ACP permission
        // round-trips; until then we stay quiet on the wire.
        ChatEvent::SystemHook { .. } => Vec::new(),

        // ACP `UsageUpdate` is feature-gated. Skip for now; Phase 9 may
        // add a real translation once we decide on a UI surface.
        ChatEvent::RateLimit { .. } => Vec::new(),

        // `Done` terminates a `session/prompt` response; Phase 3 reads it
        // as the end-of-stream signal, NOT as a `SessionUpdate`.
        ChatEvent::Done { .. } => Vec::new(),

        // Phase 4: `ControlRequest` is NOT a SessionUpdate — it triggers a
        // distinct ACP `session/request_permission` *request* that the
        // server emits out-of-band. `handle_prompt` watches for this
        // variant explicitly; the mapper drops it from the SessionUpdate
        // stream so we don't accidentally double-route it.
        ChatEvent::ControlRequest { .. } => Vec::new(),

        ChatEvent::Unknown { raw } => {
            log::warn!(target: "ikenga::acp::mapping", "dropping Unknown event: {raw}");
            Vec::new()
        }
        ChatEvent::ParseError { message, line } => {
            log::warn!(
                target: "ikenga::acp::mapping",
                "dropping ParseError event: {message} (line: {line})"
            );
            Vec::new()
        }
    }
}

/// Build a `ContentChunk` carrying a single text block, optionally
/// stamped with the Anthropic `message.id` via the unstable `messageId`
/// field. Falls back to attaching the id under `_meta.ikenga.messageId`
/// when the `unstable_message_id` schema feature is off (defensive — our
/// Cargo.toml currently turns it on through `features = ["unstable"]`).
fn text_chunk(text: &str, message_id: Option<&str>) -> ContentChunk {
    let block = ContentBlock::Text(TextContent::new(text.to_string()));
    let chunk = ContentChunk::new(block);
    attach_message_id(chunk, message_id)
}

#[cfg(feature = "unstable_message_id")]
fn attach_message_id(chunk: ContentChunk, message_id: Option<&str>) -> ContentChunk {
    match message_id {
        Some(id) => chunk.message_id(id.to_string()),
        None => chunk,
    }
}

#[cfg(not(feature = "unstable_message_id"))]
fn attach_message_id(chunk: ContentChunk, message_id: Option<&str>) -> ContentChunk {
    // Without the schema feature, fall back to `_meta.ikenga.messageId`
    // so we don't lose the dedupe key on the wire.
    match message_id {
        Some(id) => {
            let mut meta = Map::new();
            meta.insert(
                "ikenga".into(),
                Value::Object({
                    let mut inner = Map::new();
                    inner.insert("messageId".into(), Value::String(id.to_string()));
                    inner
                }),
            );
            chunk.meta(meta)
        }
        None => chunk,
    }
}

/// Build a fresh `ToolCall` for a newly-issued tool invocation.
///
/// The `parent_tool_use_id` (from Task subagents) has no native ACP
/// equivalent — we tuck it under `_meta.ikenga.parentToolUseId` so the
/// UI can rebuild the hierarchy without inventing a custom variant.
fn build_tool_call(
    id: &str,
    name: &str,
    input: &Value,
    parent_tool_use_id: Option<&str>,
) -> ToolCall {
    let kind = tool_kind_for(name);
    let title = title_for(name, input);
    let raw_input = if input.is_null() {
        None
    } else {
        Some(input.clone())
    };

    let mut tc = ToolCall::new(ToolCallId::new(id), title)
        .kind(kind)
        .status(ToolCallStatus::Pending)
        .raw_input(raw_input);

    if let Some(parent) = parent_tool_use_id {
        let mut meta = Map::new();
        meta.insert(
            "ikenga".into(),
            Value::Object({
                let mut inner = Map::new();
                inner.insert("parentToolUseId".into(), Value::String(parent.to_string()));
                inner
            }),
        );
        tc = tc.meta(meta);
    }
    tc
}

/// Build a `ToolCallUpdate` for the result side of a tool call.
fn build_tool_result_update(
    id: &str,
    output: &Value,
    is_error: bool,
    parent_tool_use_id: Option<&str>,
) -> ToolCallUpdate {
    let status = if is_error {
        ToolCallStatus::Failed
    } else {
        ToolCallStatus::Completed
    };
    let content = tool_output_to_content(output);

    let mut fields = ToolCallUpdateFields::new()
        .status(status)
        .raw_output(if output.is_null() {
            None
        } else {
            Some(output.clone())
        });
    if !content.is_empty() {
        fields = fields.content(content);
    }

    let mut update = ToolCallUpdate::new(ToolCallId::new(id), fields);
    if let Some(parent) = parent_tool_use_id {
        let mut meta = Map::new();
        meta.insert(
            "ikenga".into(),
            Value::Object({
                let mut inner = Map::new();
                inner.insert("parentToolUseId".into(), Value::String(parent.to_string()));
                inner
            }),
        );
        update = update.meta(meta);
    }
    update
}

/// Crude string→kind classifier. Falls back to `Other` for unknown
/// (notably MCP-provided) tools. Keep in sync with the table at the
/// top of this module.
fn tool_kind_for(name: &str) -> ToolKind {
    match name {
        "Read" => ToolKind::Read,
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ToolKind::Edit,
        "Bash" | "BashOutput" | "KillBash" => ToolKind::Execute,
        "Glob" | "Grep" | "WebSearch" => ToolKind::Search,
        "WebFetch" => ToolKind::Fetch,
        "Task" | "ExitPlanMode" => ToolKind::Think,
        _ => ToolKind::Other,
    }
}

/// Compose a human-readable title from a tool name + input. We keep
/// these short — the chat UI surfaces them as the row header. The
/// fallback is the bare tool name, which is always safe.
fn title_for(name: &str, input: &Value) -> String {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return name.to_string(),
    };

    // A handful of pretty cases that show up most often. Anything not
    // listed here just renders as the tool name — adapters can use
    // `raw_input` for richer rendering.
    match name {
        "Bash" => obj
            .get("command")
            .and_then(Value::as_str)
            .map(|c| format!("Bash: {}", truncate(c, 80)))
            .unwrap_or_else(|| name.to_string()),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => obj
            .get("file_path")
            .and_then(Value::as_str)
            .map(|p| format!("{name}: {p}"))
            .unwrap_or_else(|| name.to_string()),
        "Glob" => obj
            .get("pattern")
            .and_then(Value::as_str)
            .map(|p| format!("Glob: {p}"))
            .unwrap_or_else(|| name.to_string()),
        "Grep" => obj
            .get("pattern")
            .and_then(Value::as_str)
            .map(|p| format!("Grep: {p}"))
            .unwrap_or_else(|| name.to_string()),
        "WebFetch" | "WebSearch" => obj
            .get("url")
            .or_else(|| obj.get("query"))
            .and_then(Value::as_str)
            .map(|q| format!("{name}: {q}"))
            .unwrap_or_else(|| name.to_string()),
        _ => name.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let cutoff = s
            .char_indices()
            .take_while(|(i, _)| *i < max)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}…", &s[..cutoff])
    }
}

/// Convert the loosely-typed `tool_result.content` payload into a set
/// of `ToolCallContent::Content` blocks. Stream-json carries this as
/// either a string (most tools) or an array of Anthropic content blocks
/// (uncommon, but legal — e.g. tools that return images). Anything we
/// can't structurally recognize is JSON-stringified into a text block.
fn tool_output_to_content(output: &Value) -> Vec<ToolCallContent> {
    match output {
        Value::Null => Vec::new(),
        Value::String(s) => {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![text_tool_content(s)]
            }
        }
        Value::Array(items) => items
            .iter()
            .filter_map(anthropic_block_to_content)
            .collect(),
        other => vec![text_tool_content(&other.to_string())],
    }
}

fn text_tool_content(s: &str) -> ToolCallContent {
    ToolCallContent::from(ContentBlock::Text(TextContent::new(s.to_string())))
}

/// Best-effort translation of a single Anthropic-style content block
/// inside a `tool_result`. Currently we only surface `text` — images
/// will land in Phase 7 when we wire image input both ways.
fn anthropic_block_to_content(block: &Value) -> Option<ToolCallContent> {
    let obj = block.as_object()?;
    let block_type = obj.get("type").and_then(Value::as_str)?;
    match block_type {
        "text" => obj
            .get("text")
            .and_then(Value::as_str)
            .map(text_tool_content),
        // TODO(phase-2): image/tool_result content blocks. Phase 7 will
        // need to round-trip ImageContent here; for now we stringify so
        // information isn't silently lost.
        _ => Some(text_tool_content(&block.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::stream_parser::StreamParser;
    use serde_json::json;

    /// Walk a `SessionUpdate` and pull out the inner text, if any, so
    /// tests can assert payload contents without matching the full
    /// non-exhaustive enum structure.
    fn extract_chunk_text(update: &SessionUpdate) -> Option<&str> {
        let chunk = match update {
            SessionUpdate::AgentMessageChunk(c) | SessionUpdate::AgentThoughtChunk(c) => c,
            _ => return None,
        };
        match &chunk.content {
            ContentBlock::Text(t) => Some(t.text.as_str()),
            _ => None,
        }
    }

    fn discriminant(update: &SessionUpdate) -> &'static str {
        match update {
            SessionUpdate::UserMessageChunk(_) => "user_message_chunk",
            SessionUpdate::AgentMessageChunk(_) => "agent_message_chunk",
            SessionUpdate::AgentThoughtChunk(_) => "agent_thought_chunk",
            SessionUpdate::ToolCall(_) => "tool_call",
            SessionUpdate::ToolCallUpdate(_) => "tool_call_update",
            SessionUpdate::Plan(_) => "plan",
            SessionUpdate::AvailableCommandsUpdate(_) => "available_commands_update",
            SessionUpdate::CurrentModeUpdate(_) => "current_mode_update",
            SessionUpdate::ConfigOptionUpdate(_) => "config_option_update",
            SessionUpdate::SessionInfoUpdate(_) => "session_info_update",
            _ => "other",
        }
    }

    #[test]
    fn text_event_maps_to_agent_message_chunk() {
        let ev = ChatEvent::Text {
            delta: "hello".into(),
            message_id: Some("msg_1".into()),
        };
        let updates = chat_event_to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(discriminant(&updates[0]), "agent_message_chunk");
        assert_eq!(extract_chunk_text(&updates[0]), Some("hello"));
    }

    #[test]
    fn thinking_event_maps_to_thought_chunk() {
        let ev = ChatEvent::Thinking {
            delta: "pondering".into(),
            message_id: None,
        };
        let updates = chat_event_to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(discriminant(&updates[0]), "agent_thought_chunk");
        assert_eq!(extract_chunk_text(&updates[0]), Some("pondering"));
    }

    #[test]
    fn tool_use_emits_pending_tool_call() {
        let ev = ChatEvent::ToolUse {
            id: "toolu_1".into(),
            name: "Bash".into(),
            input: json!({"command": "ls -la"}),
            parent_tool_use_id: None,
        };
        let updates = chat_event_to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.tool_call_id.0.as_ref(), "toolu_1");
                assert_eq!(tc.status, ToolCallStatus::Pending);
                assert_eq!(tc.kind, ToolKind::Execute);
                assert!(tc.title.starts_with("Bash:"));
                assert!(tc.raw_input.is_some());
            }
            other => panic!("expected ToolCall, got {}", discriminant(other)),
        }
    }

    #[test]
    fn tool_result_success_emits_completed_update() {
        let ev = ChatEvent::ToolResult {
            id: "toolu_1".into(),
            output: json!("file1\nfile2\n"),
            is_error: false,
            parent_tool_use_id: None,
        };
        let updates = chat_event_to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.tool_call_id.0.as_ref(), "toolu_1");
                assert_eq!(u.fields.status, Some(ToolCallStatus::Completed));
                let content = u.fields.content.as_ref().expect("content set");
                assert_eq!(content.len(), 1);
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn tool_result_failure_emits_failed_update() {
        let ev = ChatEvent::ToolResult {
            id: "toolu_2".into(),
            output: json!("permission denied"),
            is_error: true,
            parent_tool_use_id: None,
        };
        let updates = chat_event_to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Failed));
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn done_emits_no_session_updates() {
        let ev = ChatEvent::Done {
            usage: None,
            total_cost_usd: Some(0.123),
            stop_reason: Some("end_turn".into()),
            duration_ms: Some(42),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn unknown_event_emits_no_session_updates() {
        let ev = ChatEvent::Unknown {
            raw: json!({"type": "mystery"}),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn parse_error_event_emits_no_session_updates() {
        let ev = ChatEvent::ParseError {
            message: "bad json".into(),
            line: "not json".into(),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn session_init_emits_no_session_updates() {
        let ev = ChatEvent::SessionInit {
            session_id: "abc".into(),
            model: Some("claude-opus".into()),
            cwd: Some("/tmp".into()),
            permission_mode: Some("default".into()),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn control_request_event_emits_no_session_updates() {
        // Phase 4: ControlRequest is routed separately by the server as a
        // `session/request_permission` request. It must NOT show up in the
        // SessionUpdate stream.
        let ev = ChatEvent::ControlRequest {
            request_id: "req_1".into(),
            subtype: "permission".into(),
            tool_name: Some("Bash".into()),
            tool_input: Some(json!({"command": "ls"})),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn artifact_event_emits_no_session_updates() {
        let ev = ChatEvent::Artifact {
            path: "/tmp/out.png".into(),
            mime: "image/png".into(),
            produced_by: Some("toolu_1".into()),
        };
        assert!(chat_event_to_session_updates(&ev).is_empty());
    }

    #[test]
    fn tool_kind_mapping_table() {
        // Spot-check the table at the top of the module so a future
        // refactor doesn't silently shuffle the buckets.
        assert_eq!(tool_kind_for("Read"), ToolKind::Read);
        assert_eq!(tool_kind_for("Write"), ToolKind::Edit);
        assert_eq!(tool_kind_for("MultiEdit"), ToolKind::Edit);
        assert_eq!(tool_kind_for("Bash"), ToolKind::Execute);
        assert_eq!(tool_kind_for("Grep"), ToolKind::Search);
        assert_eq!(tool_kind_for("WebFetch"), ToolKind::Fetch);
        assert_eq!(tool_kind_for("Task"), ToolKind::Think);
        assert_eq!(tool_kind_for("mcp__weird__tool"), ToolKind::Other);
    }

    /// End-to-end: feed a synthetic stream-json transcript through the
    /// real `StreamParser`, then run each event through the mapper, and
    /// assert the resulting `SessionUpdate` shape.
    ///
    /// Transcript: system:init → assistant text → assistant tool_use →
    /// user tool_result → result(success).
    ///
    /// Expected ACP shape: [agent_message_chunk, tool_call, tool_call_update].
    /// (init + done are deliberately empty — see mapping table.)
    #[test]
    fn end_to_end_fixture_yields_expected_session_update_sequence() {
        let transcript = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess_e2e","model":"claude-opus-4-7","cwd":"/work","permissionMode":"default"}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_a","content":[{"type":"text","text":"running ls"}]},"parent_tool_use_id":null}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_a","content":[{"type":"tool_use","id":"toolu_e2e","name":"Bash","input":{"command":"ls"}}]},"parent_tool_use_id":null}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_e2e","content":"file1\nfile2","is_error":false}]},"parent_tool_use_id":null}"#,
            "\n",
            r#"{"type":"result","subtype":"success","total_cost_usd":0.01,"stop_reason":"end_turn","duration_ms":250}"#,
            "\n",
        );

        let mut parser = StreamParser::new();
        let events = parser.feed(transcript.as_bytes());
        // 5 envelopes → 5 events (init, text, tool_use, tool_result, done).
        assert_eq!(events.len(), 5, "stream parser should emit 5 events");

        let updates: Vec<SessionUpdate> = events
            .iter()
            .flat_map(chat_event_to_session_updates)
            .collect();

        let kinds: Vec<&str> = updates.iter().map(discriminant).collect();
        assert_eq!(
            kinds,
            vec![
                "agent_message_chunk", // text
                "tool_call",           // tool_use
                "tool_call_update",    // tool_result
            ],
            "init + done must drop out of the SessionUpdate stream",
        );

        // Sanity-check payloads on the two interesting updates.
        assert_eq!(extract_chunk_text(&updates[0]), Some("running ls"));
        if let SessionUpdate::ToolCall(tc) = &updates[1] {
            assert_eq!(tc.tool_call_id.0.as_ref(), "toolu_e2e");
            assert_eq!(tc.kind, ToolKind::Execute);
            assert_eq!(tc.status, ToolCallStatus::Pending);
        } else {
            panic!("expected ToolCall at index 1");
        }
        if let SessionUpdate::ToolCallUpdate(u) = &updates[2] {
            assert_eq!(u.tool_call_id.0.as_ref(), "toolu_e2e");
            assert_eq!(u.fields.status, Some(ToolCallStatus::Completed));
        } else {
            panic!("expected ToolCallUpdate at index 2");
        }
    }
}
