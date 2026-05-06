//! Artifact correlation for a live session.
//!
//! When the assistant runs `Write` / `Edit` / `MultiEdit`, we get a
//! `tool_use` event with the target path inside `input`. The matching
//! `tool_result` comes later, possibly minutes later if Bash mediated. This
//! tracker pairs them: a `Write` tool_use sets a pending entry; the matching
//! `tool_result` (by id) flushes it as an `Artifact` event with mime sniffed
//! from the file extension. Errors drop the pending entry silently.
//!
//! The "watch the cwd via notify" approach was considered and rejected: tool
//! ids already give us perfect correlation, and a recursive notify watch on
//! `royalti-co/` floods on every save in unrelated editors. We can revisit
//! if a tool ever writes outside its declared input path.

use std::collections::HashMap;

use serde_json::Value;

use super::event::ChatEvent;

/// Tracks in-flight Write/Edit/MultiEdit tool calls and emits `Artifact`
/// events when they complete successfully. Single-session-scoped — spawn one
/// instance per `claude_spawn_session` invocation.
#[derive(Default)]
pub struct ArtifactWatcher {
    pending: HashMap<String, Pending>,
}

struct Pending {
    path: String,
    tool_name: String,
}

impl ArtifactWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inspect parsed events from the stream. Returns any `Artifact` events
    /// to splice into the outgoing event stream.
    pub fn observe(&mut self, events: &[ChatEvent]) -> Vec<ChatEvent> {
        let mut out = Vec::new();
        for event in events {
            match event {
                ChatEvent::ToolUse {
                    id, name, input, ..
                } => {
                    if let Some(path) = artifact_target(name, input) {
                        self.pending.insert(
                            id.clone(),
                            Pending {
                                path,
                                tool_name: name.clone(),
                            },
                        );
                    }
                }
                ChatEvent::ToolResult { id, is_error, .. } => {
                    if let Some(p) = self.pending.remove(id) {
                        if !is_error {
                            out.push(ChatEvent::Artifact {
                                path: p.path.clone(),
                                mime: mime_for_path(&p.path),
                                produced_by: Some(p.tool_name),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }
}

fn artifact_target(tool: &str, input: &Value) -> Option<String> {
    match tool {
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn mime_for_path(path: &str) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_then_result_emits_artifact() {
        let mut w = ArtifactWatcher::new();
        let use_event = ChatEvent::ToolUse {
            id: "t1".into(),
            name: "Write".into(),
            input: json!({ "file_path": "/tmp/foo.md", "content": "hi" }),
            parent_tool_use_id: None,
        };
        let result_event = ChatEvent::ToolResult {
            id: "t1".into(),
            output: Value::String("ok".into()),
            is_error: false,
            parent_tool_use_id: None,
        };
        let out1 = w.observe(&[use_event]);
        assert!(out1.is_empty());
        let out2 = w.observe(&[result_event]);
        assert_eq!(out2.len(), 1);
        match &out2[0] {
            ChatEvent::Artifact { path, mime, .. } => {
                assert_eq!(path, "/tmp/foo.md");
                assert!(mime.contains("markdown") || mime == "text/markdown");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn errored_result_does_not_emit() {
        let mut w = ArtifactWatcher::new();
        w.observe(&[ChatEvent::ToolUse {
            id: "t1".into(),
            name: "Edit".into(),
            input: json!({ "file_path": "/tmp/foo.md" }),
            parent_tool_use_id: None,
        }]);
        let out = w.observe(&[ChatEvent::ToolResult {
            id: "t1".into(),
            output: Value::String("err".into()),
            is_error: true,
            parent_tool_use_id: None,
        }]);
        assert!(out.is_empty());
    }

    #[test]
    fn ignores_non_write_tools() {
        let mut w = ArtifactWatcher::new();
        let out = w.observe(&[ChatEvent::ToolUse {
            id: "t1".into(),
            name: "Bash".into(),
            input: json!({ "command": "ls" }),
            parent_tool_use_id: None,
        }]);
        assert!(out.is_empty());
    }
}
