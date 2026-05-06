//! Shared `ChatEvent` enum. Both the live stream-json parser and the on-disk
//! jsonl reader emit values of this type. The frontend listens on
//! `claude://session/<id>` and decodes via the discriminated union in
//! `src/lib/tauri-cmd.ts`.
//!
//! `kind` is the wire discriminator — keep in sync with the TS type.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    /// Session bootstrap. Surfaced from `system:init` (live) or synthesized
    /// from the first envelope (jsonl) so consumers always see one.
    SessionInit {
        #[serde(rename = "sessionId")]
        session_id: String,
        model: Option<String>,
        cwd: Option<String>,
        #[serde(rename = "permissionMode")]
        permission_mode: Option<String>,
    },

    /// Streaming text chunk from an assistant content block.
    Text { delta: String },

    /// Extended-thinking chunk (signed; we forward as opaque text).
    Thinking { delta: String },

    /// Assistant invoked a tool. `parentToolUseId` identifies nested calls
    /// (Task subagents) so the chat UI can render them indented.
    ToolUse {
        id: String,
        name: String,
        input: Value,
        #[serde(rename = "parentToolUseId", skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
    },

    /// Tool result returned to the assistant. `output` is the raw content
    /// (string or block list) — adapter UIs decide how to render.
    ToolResult {
        id: String,
        output: Value,
        #[serde(rename = "isError", skip_serializing_if = "is_false")]
        is_error: bool,
        #[serde(rename = "parentToolUseId", skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
    },

    /// Filesystem artifact correlated by the artifact watcher.
    Artifact {
        path: String,
        mime: String,
        #[serde(rename = "producedBy", skip_serializing_if = "Option::is_none")]
        produced_by: Option<String>,
    },

    /// Hook lifecycle (SessionStart, PreToolUse, etc.) — emitted from
    /// `system:hook_*` envelopes. Kept opaque; UI may filter to a power-user
    /// inspector.
    SystemHook {
        #[serde(rename = "hookEvent")]
        hook_event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Value>,
    },

    /// Rate-limit passthrough. Optional surface.
    RateLimit { info: Value },

    /// Final result of a `claude -p` run. Carries usage + cost so the chat UI
    /// can render a footer.
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "totalCostUsd")]
        total_cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "stopReason")]
        stop_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "durationMs")]
        duration_ms: Option<u64>,
    },

    /// Unrecognized envelope or block. Forwarded so consumers can show raw
    /// JSON instead of dropping bytes.
    Unknown { raw: Value },

    /// Parser hit a malformed line. Logged loudly in dev mode.
    ParseError { message: String, line: String },
}

fn is_false(b: &bool) -> bool {
    !*b
}
