//! JSONL stream parser for `codex exec --json`.
//!
//! ADR-013 Phase 3: Codex CLI doesn't speak ACP natively, but its
//! non-interactive `codex exec --json` mode emits a stable line-delimited
//! JSON event stream. We parse each event, then translate the meaningful
//! ones into ACP `SessionUpdate` values so the FE sees the same envelope
//! shape it gets from Claude / Gemini.
//!
//! ## Event vocabulary
//!
//! Top-level event types (each is one full JSON line):
//!
//! - `thread.started` — `{ "type":"thread.started", "thread_id":"<uuid>" }`.
//!   Emitted once at session start. Carries the id we feed into
//!   `--resume` on the next turn.
//! - `turn.started` — `{ "type":"turn.started" }`. Turn boundary.
//! - `turn.completed` — `{ "type":"turn.completed", "usage":{...} }`.
//!   Success.
//! - `turn.failed` — `{ "type":"turn.failed", "error":{"message":"..."} }`.
//!   Failure.
//! - `error` — `{ "type":"error", "message":"..." }`. Non-fatal warning.
//! - `item.started` / `item.updated` / `item.completed` —
//!   `{ "type":"item.<phase>", "item":{ "id":"...", "item_type":"...",
//!     ... } }` (or `type` instead of `item_type` — we accept both).
//!
//! Item subtypes under `item.item_type`:
//!
//! | item_type           | Translated to                              |
//! |---------------------|--------------------------------------------|
//! | `agent_message`     | `AgentMessageChunk(text)`                  |
//! | `reasoning`         | `AgentThoughtChunk(text)`                  |
//! | `command_execution` | `ToolCall` (started) / `ToolCallUpdate`    |
//! | `file_change`       | `ToolCall` / `ToolCallUpdate` (per change) |
//! | `mcp_tool_call`     | `ToolCall` / `ToolCallUpdate`              |
//! | `web_search`        | `ToolCall` (kind=Search)                   |
//! | `todo_list`         | `Plan` (with PlanEntry list)               |
//! | `plan_update`       | `Plan`                                     |
//! | `error`             | `AgentMessageChunk` (prefixed "[error]")   |
//! | anything else       | logged at debug + dropped                  |
//!
//! ## Sequence
//!
//! ```text
//! thread.started (once per session)
//! turn.started
//!   item.started   (only for items with meaningful in-progress state)
//!   item.updated   (todo_list / agent_message in newer builds)
//!   item.completed
//!   ... more items ...
//! turn.completed | turn.failed
//! ```
//!
//! The engine loop owns the higher-level "did the turn end" decision —
//! the parser is pure and stateless. Unknown event shapes are surfaced as
//! `ParsedEvent::Unknown` so callers can log/skip them without aborting.

use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus, SessionUpdate,
    TextContent, ToolCall, ToolCallContent, ToolCallId, ToolCallStatus, ToolCallUpdate,
    ToolCallUpdateFields, ToolKind,
};
use serde_json::{Map, Value};

/// One parsed event from the `codex exec --json` stream.
///
/// `Unknown` carries the original JSON object so callers can log it for
/// future-proofing without panicking on shape drift.
#[derive(Debug, Clone)]
pub enum ParsedEvent {
    ThreadStarted {
        thread_id: String,
    },
    TurnStarted,
    TurnCompleted {
        usage: Option<Value>,
    },
    TurnFailed {
        message: String,
    },
    /// Top-level non-fatal warning (codex emits `{"type":"error",...}` for
    /// recoverable issues — e.g. a single MCP tool failing without aborting
    /// the turn).
    Error {
        message: String,
    },
    Item {
        phase: ItemPhase,
        kind: ItemKind,
    },
    Unknown(Value),
}

/// Phase of an item event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemPhase {
    Started,
    Updated,
    Completed,
}

/// Structured representation of `item.item_type` payloads. Unknown
/// item_types collapse into `Other` with the raw JSON preserved so the
/// engine can log them without losing fidelity.
#[derive(Debug, Clone)]
pub enum ItemKind {
    AgentMessage {
        id: String,
        text: String,
    },
    Reasoning {
        id: String,
        text: String,
    },
    CommandExecution {
        id: String,
        command: String,
        aggregated_output: Option<String>,
        exit_code: Option<i64>,
        status: Option<String>,
    },
    FileChange {
        id: String,
        changes: Vec<FileChangeEntry>,
        status: Option<String>,
    },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        arguments: Option<Value>,
        result: Option<Value>,
        error: Option<String>,
        status: Option<String>,
    },
    WebSearch {
        id: String,
        query: String,
    },
    TodoList {
        id: String,
        items: Vec<TodoEntry>,
    },
    PlanUpdate {
        id: String,
        items: Vec<TodoEntry>,
    },
    /// `item.item_type == "error"` — non-fatal warning carried as an item.
    InlineError {
        id: String,
        message: String,
    },
    /// Future item_types we don't recognise. The `raw` is the full item
    /// object so we can log it intact.
    Other {
        id: String,
        item_type: String,
        raw: Value,
    },
}

/// One entry in a `file_change` item's `changes` array.
#[derive(Debug, Clone)]
pub struct FileChangeEntry {
    pub path: String,
    /// `add` | `delete` | `update` (codex's vocabulary).
    pub kind: String,
}

/// One entry in a `todo_list` / `plan_update` item.
#[derive(Debug, Clone)]
pub struct TodoEntry {
    pub text: String,
    pub completed: bool,
}

/// Parse failures. Today there's just one case (malformed JSON); we keep
/// the enum for forward-compat if we add stricter validation later.
#[derive(Debug)]
pub enum ParseError {
    Json(serde_json::Error),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Json(e) => write!(f, "codex json parse: {e}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Parse one line from `codex exec --json` stdout.
///
/// Returns `Unknown` for any envelope that decodes as JSON but doesn't
/// match a known top-level `type`. Returns `Err` only for malformed JSON
/// (codex shouldn't emit that, but be defensive).
pub fn parse_event(line: &str) -> Result<ParsedEvent, ParseError> {
    let value: Value = serde_json::from_str(line).map_err(ParseError::Json)?;
    Ok(classify(&value))
}

fn classify(value: &Value) -> ParsedEvent {
    let Some(obj) = value.as_object() else {
        return ParsedEvent::Unknown(value.clone());
    };
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "thread.started" => {
            let thread_id = obj
                .get("thread_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ParsedEvent::ThreadStarted { thread_id }
        }
        "turn.started" => ParsedEvent::TurnStarted,
        "turn.completed" => ParsedEvent::TurnCompleted {
            usage: obj.get("usage").cloned(),
        },
        "turn.failed" => {
            let message = obj
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("(turn failed)")
                .to_string();
            ParsedEvent::TurnFailed { message }
        }
        "error" => {
            let message = obj
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("(error)")
                .to_string();
            ParsedEvent::Error { message }
        }
        "item.started" | "item.updated" | "item.completed" => {
            let phase = match ty {
                "item.started" => ItemPhase::Started,
                "item.updated" => ItemPhase::Updated,
                _ => ItemPhase::Completed,
            };
            let item = obj
                .get("item")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let kind = classify_item(&item);
            ParsedEvent::Item { phase, kind }
        }
        _ => ParsedEvent::Unknown(value.clone()),
    }
}

/// Inspect an `item.*` payload and pick the right `ItemKind`. Codex
/// has used both `item_type` and `type` across versions; we accept either.
fn classify_item(item: &Map<String, Value>) -> ItemKind {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let item_type = item
        .get("item_type")
        .and_then(Value::as_str)
        .or_else(|| item.get("type").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    match item_type.as_str() {
        "agent_message" => ItemKind::AgentMessage {
            id,
            text: item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        "reasoning" => ItemKind::Reasoning {
            id,
            text: item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        "command_execution" => ItemKind::CommandExecution {
            id,
            command: item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            aggregated_output: item
                .get("aggregated_output")
                .and_then(Value::as_str)
                .map(str::to_string),
            exit_code: item.get("exit_code").and_then(Value::as_i64),
            status: item
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "file_change" => ItemKind::FileChange {
            id,
            changes: item
                .get("changes")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            let o = c.as_object()?;
                            Some(FileChangeEntry {
                                path: o
                                    .get("path")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                kind: o
                                    .get("kind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("update")
                                    .to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            status: item
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "mcp_tool_call" => ItemKind::McpToolCall {
            id,
            server: item
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            tool: item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: item.get("arguments").cloned(),
            result: item.get("result").cloned(),
            error: item
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
            status: item
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "web_search" => ItemKind::WebSearch {
            id,
            query: item
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        "todo_list" => ItemKind::TodoList {
            id,
            items: extract_todo_items(item),
        },
        "plan_update" => ItemKind::PlanUpdate {
            id,
            items: extract_todo_items(item),
        },
        "error" => ItemKind::InlineError {
            id,
            message: item
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("(error)")
                .to_string(),
        },
        other => ItemKind::Other {
            id,
            item_type: other.to_string(),
            raw: Value::Object(item.clone()),
        },
    }
}

fn extract_todo_items(item: &Map<String, Value>) -> Vec<TodoEntry> {
    item.get("items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let o = v.as_object()?;
                    Some(TodoEntry {
                        text: o
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        completed: o.get("completed").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Translate one `ParsedEvent` into zero-or-more `SessionUpdate`s for the
/// FE. Pure function so we can unit-test against literal JSON lines
/// without spawning a child.
///
/// Top-level events (turn.*, thread.started) do NOT translate to
/// SessionUpdates — the engine loop owns those decisions. They return an
/// empty Vec here.
pub fn to_session_updates(event: &ParsedEvent) -> Vec<SessionUpdate> {
    match event {
        ParsedEvent::ThreadStarted { .. }
        | ParsedEvent::TurnStarted
        | ParsedEvent::TurnCompleted { .. }
        | ParsedEvent::Unknown(_) => Vec::new(),

        // Surface turn failure + transient errors as a final assistant
        // chunk so the FE renders them inline (the engine ALSO returns
        // StopReason::Refusal on TurnFailed so the user sees a clear
        // "failed" affordance).
        ParsedEvent::TurnFailed { message } => {
            vec![text_chunk_update(&format!("[error] {message}"))]
        }
        ParsedEvent::Error { message } => {
            vec![text_chunk_update(&format!("[warning] {message}"))]
        }

        ParsedEvent::Item { phase, kind } => item_to_updates(*phase, kind),
    }
}

fn item_to_updates(phase: ItemPhase, kind: &ItemKind) -> Vec<SessionUpdate> {
    match kind {
        ItemKind::AgentMessage { text, .. } => {
            // Codex emits agent_message as a single completed item with
            // the full text. We map the completed phase to a single
            // AgentMessageChunk so the FE's chunk-accumulator works.
            // `started` carries no content; skip.
            if matches!(phase, ItemPhase::Completed | ItemPhase::Updated) && !text.is_empty() {
                vec![text_chunk_update(text)]
            } else {
                Vec::new()
            }
        }
        ItemKind::Reasoning { text, .. } => {
            if matches!(phase, ItemPhase::Completed | ItemPhase::Updated) && !text.is_empty() {
                vec![thought_chunk_update(text)]
            } else {
                Vec::new()
            }
        }
        ItemKind::CommandExecution {
            id,
            command,
            aggregated_output,
            exit_code,
            status,
        } => command_execution_to_updates(
            phase,
            id,
            command,
            aggregated_output.as_deref(),
            *exit_code,
            status.as_deref(),
        ),
        ItemKind::FileChange {
            id,
            changes,
            status,
        } => file_change_to_updates(phase, id, changes, status.as_deref()),
        ItemKind::McpToolCall {
            id,
            server,
            tool,
            arguments,
            result,
            error,
            status,
        } => mcp_tool_call_to_updates(
            phase,
            id,
            server,
            tool,
            arguments.as_ref(),
            result.as_ref(),
            error.as_deref(),
            status.as_deref(),
        ),
        ItemKind::WebSearch { id, query } => web_search_to_updates(phase, id, query),
        ItemKind::TodoList { items, .. } | ItemKind::PlanUpdate { items, .. } => {
            // Both event variants render as a `Plan` update — the protocol
            // doesn't distinguish "todo" vs "plan-update" beyond naming.
            // `started` carries no items; only emit on updated/completed.
            if matches!(phase, ItemPhase::Updated | ItemPhase::Completed) {
                vec![SessionUpdate::Plan(build_plan(items))]
            } else {
                Vec::new()
            }
        }
        ItemKind::InlineError { message, .. } => {
            vec![text_chunk_update(&format!("[warning] {message}"))]
        }
        ItemKind::Other { item_type, .. } => {
            log::debug!(
                target: "ikenga::engines::codex_pty::parser",
                "dropping unknown codex item_type={item_type}",
            );
            Vec::new()
        }
    }
}

fn command_execution_to_updates(
    phase: ItemPhase,
    id: &str,
    command: &str,
    aggregated_output: Option<&str>,
    exit_code: Option<i64>,
    status: Option<&str>,
) -> Vec<SessionUpdate> {
    match phase {
        ItemPhase::Started => {
            let raw_input = Some(serde_json::json!({ "command": command }));
            let tc = ToolCall::new(
                ToolCallId::new(id),
                format!("Bash: {}", truncate(command, 80)),
            )
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::Pending)
            .raw_input(raw_input);
            vec![SessionUpdate::ToolCall(tc)]
        }
        ItemPhase::Updated | ItemPhase::Completed => {
            let status_enum = match (status, exit_code, phase) {
                (Some("failed"), _, _) => ToolCallStatus::Failed,
                (_, Some(c), ItemPhase::Completed) if c != 0 => ToolCallStatus::Failed,
                (_, _, ItemPhase::Completed) => ToolCallStatus::Completed,
                _ => ToolCallStatus::InProgress,
            };
            let mut fields = ToolCallUpdateFields::new().status(status_enum);
            if let Some(out) = aggregated_output.filter(|s| !s.is_empty()) {
                fields = fields.content(vec![text_tool_content(out)]);
            }
            let raw_output = serde_json::json!({
                "command": command,
                "exit_code": exit_code,
                "status": status,
            });
            fields = fields.raw_output(Some(raw_output));
            vec![SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                ToolCallId::new(id),
                fields,
            ))]
        }
    }
}

fn file_change_to_updates(
    phase: ItemPhase,
    id: &str,
    changes: &[FileChangeEntry],
    status: Option<&str>,
) -> Vec<SessionUpdate> {
    // Bundle all changes into one tool call (mirrors Claude's MultiEdit
    // path). Title = "Edit: N file(s)" with the path of the first as a
    // hint.
    let title = match changes.first() {
        Some(first) if changes.len() == 1 => {
            format!("{}: {}", verb_for_kind(&first.kind), first.path)
        }
        Some(first) => format!(
            "{}: {} (+{} more)",
            verb_for_kind(&first.kind),
            first.path,
            changes.len() - 1
        ),
        None => "file_change".to_string(),
    };
    let raw_input = Some(serde_json::json!({
        "changes": changes
            .iter()
            .map(|c| serde_json::json!({ "path": c.path, "kind": c.kind }))
            .collect::<Vec<_>>()
    }));
    match phase {
        ItemPhase::Started => {
            let tc = ToolCall::new(ToolCallId::new(id), title)
                .kind(ToolKind::Edit)
                .status(ToolCallStatus::Pending)
                .raw_input(raw_input);
            vec![SessionUpdate::ToolCall(tc)]
        }
        ItemPhase::Updated | ItemPhase::Completed => {
            let status_enum = match (status, phase) {
                (Some("failed"), _) => ToolCallStatus::Failed,
                (_, ItemPhase::Completed) => ToolCallStatus::Completed,
                _ => ToolCallStatus::InProgress,
            };
            let summary = changes
                .iter()
                .map(|c| format!("- {} {}", verb_for_kind(&c.kind), c.path))
                .collect::<Vec<_>>()
                .join("\n");
            let mut fields = ToolCallUpdateFields::new().status(status_enum);
            if !summary.is_empty() {
                fields = fields.content(vec![text_tool_content(&summary)]);
            }
            fields = fields.raw_output(raw_input);
            vec![SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                ToolCallId::new(id),
                fields,
            ))]
        }
    }
}

fn verb_for_kind(kind: &str) -> &'static str {
    match kind {
        "add" => "Add",
        "delete" => "Delete",
        "update" => "Update",
        _ => "Change",
    }
}

#[allow(clippy::too_many_arguments)]
fn mcp_tool_call_to_updates(
    phase: ItemPhase,
    id: &str,
    server: &str,
    tool: &str,
    arguments: Option<&Value>,
    result: Option<&Value>,
    error: Option<&str>,
    status: Option<&str>,
) -> Vec<SessionUpdate> {
    let title = format!("{server}.{tool}");
    match phase {
        ItemPhase::Started => {
            let mut tc = ToolCall::new(ToolCallId::new(id), title)
                .kind(ToolKind::Other)
                .status(ToolCallStatus::Pending);
            if let Some(args) = arguments {
                tc = tc.raw_input(Some(args.clone()));
            }
            vec![SessionUpdate::ToolCall(tc)]
        }
        ItemPhase::Updated | ItemPhase::Completed => {
            let status_enum = if error.is_some() || matches!(status, Some("failed")) {
                ToolCallStatus::Failed
            } else if matches!(phase, ItemPhase::Completed) {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::InProgress
            };
            let mut fields = ToolCallUpdateFields::new().status(status_enum);
            let content = mcp_result_content(result, error);
            if !content.is_empty() {
                fields = fields.content(content);
            }
            if let Some(r) = result {
                fields = fields.raw_output(Some(r.clone()));
            }
            vec![SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                ToolCallId::new(id),
                fields,
            ))]
        }
    }
}

fn mcp_result_content(result: Option<&Value>, error: Option<&str>) -> Vec<ToolCallContent> {
    if let Some(err) = error {
        return vec![text_tool_content(err)];
    }
    let Some(r) = result else { return Vec::new() };
    // Codex's mcp_tool_call result shape: `{ content: [...], structured_content?: ... }`.
    if let Some(arr) = r.get("content").and_then(Value::as_array) {
        let mut out = Vec::new();
        for block in arr {
            if let Some(obj) = block.as_object() {
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    out.push(text_tool_content(text));
                    continue;
                }
            }
            out.push(text_tool_content(&block.to_string()));
        }
        if !out.is_empty() {
            return out;
        }
    }
    // Fall back to stringifying the whole result.
    vec![text_tool_content(&r.to_string())]
}

fn web_search_to_updates(phase: ItemPhase, id: &str, query: &str) -> Vec<SessionUpdate> {
    match phase {
        ItemPhase::Started => {
            let tc = ToolCall::new(ToolCallId::new(id), format!("Search: {query}"))
                .kind(ToolKind::Search)
                .status(ToolCallStatus::Pending)
                .raw_input(Some(serde_json::json!({ "query": query })));
            vec![SessionUpdate::ToolCall(tc)]
        }
        ItemPhase::Updated | ItemPhase::Completed => {
            let status_enum = if matches!(phase, ItemPhase::Completed) {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::InProgress
            };
            let fields = ToolCallUpdateFields::new().status(status_enum);
            vec![SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                ToolCallId::new(id),
                fields,
            ))]
        }
    }
}

fn build_plan(items: &[TodoEntry]) -> Plan {
    let entries = items
        .iter()
        .map(|item| {
            let status = if item.completed {
                PlanEntryStatus::Completed
            } else {
                PlanEntryStatus::Pending
            };
            // No priority signal from codex's todo_list — default to medium.
            PlanEntry::new(item.text.clone(), PlanEntryPriority::Medium, status)
        })
        .collect();
    Plan::new(entries)
}

fn text_chunk_update(text: &str) -> SessionUpdate {
    let block = ContentBlock::Text(TextContent::new(text.to_string()));
    SessionUpdate::AgentMessageChunk(ContentChunk::new(block))
}

fn thought_chunk_update(text: &str) -> SessionUpdate {
    let block = ContentBlock::Text(TextContent::new(text.to_string()));
    SessionUpdate::AgentThoughtChunk(ContentChunk::new(block))
}

fn text_tool_content(s: &str) -> ToolCallContent {
    ToolCallContent::from(ContentBlock::Text(TextContent::new(s.to_string())))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    // ----- top-level events -------------------------------------------------

    #[test]
    fn parses_thread_started_and_captures_id() {
        let line = r#"{"type":"thread.started","thread_id":"abc-123"}"#;
        let ev = parse_event(line).expect("parse ok");
        match ev {
            ParsedEvent::ThreadStarted { thread_id } => assert_eq!(thread_id, "abc-123"),
            other => panic!("expected ThreadStarted, got {other:?}"),
        }
    }

    #[test]
    fn thread_started_emits_no_session_updates() {
        let ev = parse_event(r#"{"type":"thread.started","thread_id":"x"}"#).unwrap();
        assert!(to_session_updates(&ev).is_empty());
    }

    #[test]
    fn parses_turn_started_and_completed_and_failed() {
        let started = parse_event(r#"{"type":"turn.started"}"#).unwrap();
        assert!(matches!(started, ParsedEvent::TurnStarted));

        let completed = parse_event(
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}"#,
        )
        .unwrap();
        match completed {
            ParsedEvent::TurnCompleted { usage } => {
                let usage = usage.expect("usage present");
                assert_eq!(usage["input_tokens"], 10);
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }

        let failed =
            parse_event(r#"{"type":"turn.failed","error":{"message":"out of tokens"}}"#).unwrap();
        match failed {
            ParsedEvent::TurnFailed { message } => assert_eq!(message, "out of tokens"),
            other => panic!("expected TurnFailed, got {other:?}"),
        }
    }

    #[test]
    fn turn_failed_emits_error_chunk() {
        let ev = parse_event(r#"{"type":"turn.failed","error":{"message":"boom"}}"#).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(discriminant(&updates[0]), "agent_message_chunk");
        assert_eq!(extract_chunk_text(&updates[0]), Some("[error] boom"));
    }

    #[test]
    fn top_level_error_emits_warning_chunk() {
        let ev = parse_event(r#"{"type":"error","message":"network blip"}"#).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(
            extract_chunk_text(&updates[0]),
            Some("[warning] network blip")
        );
    }

    #[test]
    fn unknown_top_level_type_parses_as_unknown_and_emits_no_updates() {
        let ev = parse_event(r#"{"type":"future.event","payload":42}"#).unwrap();
        assert!(matches!(ev, ParsedEvent::Unknown(_)));
        assert!(to_session_updates(&ev).is_empty());
    }

    #[test]
    fn malformed_json_errors() {
        let err = parse_event("not json at all").unwrap_err();
        assert!(format!("{err}").starts_with("codex json parse:"));
    }

    // ----- item events ------------------------------------------------------

    #[test]
    fn agent_message_completed_emits_agent_message_chunk() {
        let line = r#"{"type":"item.completed","item":{"id":"i1","item_type":"agent_message","text":"Hello!"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(discriminant(&updates[0]), "agent_message_chunk");
        assert_eq!(extract_chunk_text(&updates[0]), Some("Hello!"));
    }

    #[test]
    fn agent_message_started_emits_no_updates() {
        // `started` for agent_message carries no text — nothing to chunk yet.
        let line = r#"{"type":"item.started","item":{"id":"i1","item_type":"agent_message"}}"#;
        let ev = parse_event(line).unwrap();
        assert!(to_session_updates(&ev).is_empty());
    }

    #[test]
    fn reasoning_completed_emits_thought_chunk() {
        let line = r#"{"type":"item.completed","item":{"id":"r1","item_type":"reasoning","text":"Hmm..."}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        assert_eq!(discriminant(&updates[0]), "agent_thought_chunk");
        assert_eq!(extract_chunk_text(&updates[0]), Some("Hmm..."));
    }

    #[test]
    fn command_execution_started_emits_pending_tool_call() {
        let line = r#"{"type":"item.started","item":{"id":"c1","item_type":"command_execution","command":"ls -la","status":"in_progress"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.tool_call_id.0.as_ref(), "c1");
                assert_eq!(tc.kind, ToolKind::Execute);
                assert_eq!(tc.status, ToolCallStatus::Pending);
                assert!(tc.title.contains("ls -la"));
            }
            other => panic!("expected ToolCall, got {}", discriminant(other)),
        }
    }

    #[test]
    fn command_execution_completed_success_emits_completed_update() {
        let line = r#"{"type":"item.completed","item":{"id":"c1","item_type":"command_execution","command":"ls","aggregated_output":"file1\nfile2","exit_code":0,"status":"completed"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Completed));
                assert!(u.fields.content.is_some());
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn command_execution_completed_nonzero_exit_is_failed() {
        let line = r#"{"type":"item.completed","item":{"id":"c1","item_type":"command_execution","command":"false","exit_code":1,"status":"completed"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Failed));
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn file_change_completed_emits_edit_tool_call_update() {
        let line = r#"{"type":"item.completed","item":{"id":"f1","item_type":"file_change","status":"completed","changes":[{"path":"/tmp/a.txt","kind":"update"},{"path":"/tmp/b.txt","kind":"add"}]}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Completed));
                let content = u.fields.content.as_ref().expect("content present");
                assert_eq!(content.len(), 1);
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn file_change_started_emits_edit_tool_call() {
        let line = r#"{"type":"item.started","item":{"id":"f1","item_type":"file_change","status":"in_progress","changes":[{"path":"/x","kind":"add"}]}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.kind, ToolKind::Edit);
                assert_eq!(tc.status, ToolCallStatus::Pending);
            }
            other => panic!("expected ToolCall, got {}", discriminant(other)),
        }
    }

    #[test]
    fn mcp_tool_call_started_emits_other_tool_call() {
        let line = r#"{"type":"item.started","item":{"id":"m1","item_type":"mcp_tool_call","server":"royalti","tool":"list_releases","arguments":{"limit":10},"status":"in_progress"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.kind, ToolKind::Other);
                assert_eq!(tc.title, "royalti.list_releases");
                assert!(tc.raw_input.is_some());
            }
            other => panic!("expected ToolCall, got {}", discriminant(other)),
        }
    }

    #[test]
    fn mcp_tool_call_completed_with_text_content_extracts_text() {
        let line = r#"{"type":"item.completed","item":{"id":"m1","item_type":"mcp_tool_call","server":"royalti","tool":"x","status":"completed","result":{"content":[{"type":"text","text":"hello mcp"}]}}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Completed));
                let content = u.fields.content.as_ref().expect("content");
                assert_eq!(content.len(), 1);
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn mcp_tool_call_with_error_is_failed() {
        let line = r#"{"type":"item.completed","item":{"id":"m1","item_type":"mcp_tool_call","server":"s","tool":"t","error":"timeout"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCallUpdate(u) => {
                assert_eq!(u.fields.status, Some(ToolCallStatus::Failed));
            }
            other => panic!("expected ToolCallUpdate, got {}", discriminant(other)),
        }
    }

    #[test]
    fn web_search_started_emits_search_tool_call() {
        let line = r#"{"type":"item.started","item":{"id":"w1","item_type":"web_search","query":"rust async"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        match &updates[0] {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.kind, ToolKind::Search);
                assert_eq!(tc.title, "Search: rust async");
            }
            other => panic!("expected ToolCall, got {}", discriminant(other)),
        }
    }

    #[test]
    fn todo_list_completed_emits_plan() {
        let line = r#"{"type":"item.completed","item":{"id":"t1","item_type":"todo_list","items":[{"text":"draft","completed":true},{"text":"review","completed":false}]}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(updates.len(), 1);
        match &updates[0] {
            SessionUpdate::Plan(p) => {
                assert_eq!(p.entries.len(), 2);
                assert_eq!(p.entries[0].status, PlanEntryStatus::Completed);
                assert_eq!(p.entries[1].status, PlanEntryStatus::Pending);
            }
            other => panic!("expected Plan, got {}", discriminant(other)),
        }
    }

    #[test]
    fn plan_update_emits_plan() {
        let line = r#"{"type":"item.updated","item":{"id":"p1","item_type":"plan_update","items":[{"text":"step","completed":false}]}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert!(matches!(updates[0], SessionUpdate::Plan(_)));
    }

    #[test]
    fn item_with_type_instead_of_item_type_still_classifies() {
        // Defensive: some codex builds use `type` inside the item object
        // instead of `item_type`. Accept either.
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"compat"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(extract_chunk_text(&updates[0]), Some("compat"));
    }

    #[test]
    fn unknown_item_type_logs_and_emits_no_updates() {
        let line =
            r#"{"type":"item.completed","item":{"id":"x","item_type":"future_thing","data":1}}"#;
        let ev = parse_event(line).unwrap();
        // Classifies as Other; produces no SessionUpdates.
        match &ev {
            ParsedEvent::Item {
                kind: ItemKind::Other { item_type, .. },
                ..
            } => assert_eq!(item_type, "future_thing"),
            other => panic!("expected Item::Other, got {other:?}"),
        }
        assert!(to_session_updates(&ev).is_empty());
    }

    #[test]
    fn inline_error_item_emits_warning_chunk() {
        let line = r#"{"type":"item.completed","item":{"id":"e1","item_type":"error","message":"tool fail"}}"#;
        let ev = parse_event(line).unwrap();
        let updates = to_session_updates(&ev);
        assert_eq!(extract_chunk_text(&updates[0]), Some("[warning] tool fail"));
    }

    // ----- end-to-end -------------------------------------------------------

    #[test]
    fn end_to_end_canonical_sequence() {
        // Synthetic transcript covering a full turn: thread.started →
        // turn.started → (command_execution started + completed) →
        // (agent_message completed) → turn.completed.
        let lines = vec![
            r#"{"type":"thread.started","thread_id":"sess-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"c1","item_type":"command_execution","command":"echo hi","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"c1","item_type":"command_execution","command":"echo hi","aggregated_output":"hi","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"a1","item_type":"agent_message","text":"Done."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":3}}"#,
        ];
        let events: Vec<_> = lines.into_iter().map(|l| parse_event(l).unwrap()).collect();
        let updates: Vec<SessionUpdate> = events.iter().flat_map(to_session_updates).collect();
        let kinds: Vec<&str> = updates.iter().map(discriminant).collect();
        assert_eq!(
            kinds,
            vec!["tool_call", "tool_call_update", "agent_message_chunk",],
            "thread.started + turn.* must drop out; only items produce updates",
        );
    }

    #[test]
    fn json_with_no_object_root_is_unknown() {
        // Defensive: codex shouldn't emit naked arrays/strings, but if it
        // does we shouldn't crash.
        let ev = parse_event(r#"[1,2,3]"#).unwrap();
        assert!(matches!(ev, ParsedEvent::Unknown(_)));
        let ev2 = parse_event(r#""hello""#).unwrap();
        assert!(matches!(ev2, ParsedEvent::Unknown(_)));
    }

    #[test]
    fn truncate_handles_unicode_safely() {
        // Hot path inside command_execution title — make sure we don't
        // slice in the middle of a multi-byte glyph.
        let s = "❯".repeat(200);
        let _ = json!(s);
        // truncate must not panic and must return ≤ s.
        let out = truncate(&s, 10);
        assert!(out.chars().count() <= 11); // 10 chars + the ellipsis
    }
}
