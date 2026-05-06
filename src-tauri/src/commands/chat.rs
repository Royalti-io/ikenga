//! Chat (Anthropic SDK adapter) commands. Stubs in phase 1 — phase 5 fills in
//! the streaming HTTP client, tool-use loop, and event emission. Types mirror
//! `tauri-cmd.ts` so the surface area is locked in.

use serde::Deserialize;

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ToolDef {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

#[tauri::command]
pub async fn chat_send(
    #[allow(non_snake_case)] _threadId: String,
    _messages: Vec<ChatMsg>,
    _tools: Vec<ToolDef>,
    _model: String,
) -> Result<String, String> {
    Err("unimplemented".to_string())
}

#[tauri::command]
pub async fn chat_cancel(
    #[allow(non_snake_case)] _streamId: String,
) -> Result<(), String> {
    Err("unimplemented".to_string())
}
