//! Tauri command surface for the ACP server.
//!
//! Phase 3: thin pass-throughs to `AcpServer`. The frontend speaks ACP
//! types (mirrored in `src/lib/tauri-cmd.ts`); these wrappers exist so
//! we can register them in the `invoke_handler!` macro without dragging
//! `agent-client-protocol` schema concerns into `lib.rs`.

use agent_client_protocol::schema::{
    InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    PromptResponse,
};
use tauri::{AppHandle, State};

use crate::acp::server::AcpServerState;

#[tauri::command]
pub async fn acp_initialize(
    state: State<'_, AcpServerState>,
    req: InitializeRequest,
) -> Result<InitializeResponse, String> {
    Ok(state.handle_initialize(req))
}

#[tauri::command]
pub async fn acp_new_session(
    app: AppHandle,
    state: State<'_, AcpServerState>,
    req: NewSessionRequest,
) -> Result<NewSessionResponse, String> {
    state.handle_new_session(app, req).await
}

#[tauri::command]
pub async fn acp_prompt(
    app: AppHandle,
    state: State<'_, AcpServerState>,
    req: PromptRequest,
) -> Result<PromptResponse, String> {
    state.handle_prompt(app, req).await
}

#[tauri::command]
pub async fn acp_cancel(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<(), String> {
    state.handle_cancel(threadId).await
}
