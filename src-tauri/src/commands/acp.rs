//! Tauri command surface for the ACP server.
//!
//! Phase 3: thin pass-throughs to `AcpServer`. The frontend speaks ACP
//! types (mirrored in `src/lib/tauri-cmd.ts`); these wrappers exist so
//! we can register them in the `invoke_handler!` macro without dragging
//! `agent-client-protocol` schema concerns into `lib.rs`.

use agent_client_protocol::schema::{
    InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    PromptResponse, RequestPermissionResponse,
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

/// Phase 4: client-side reply to a `session/request_permission` we emitted
/// earlier on `acp://session/{id}/request`. The Tauri layer keeps the
/// camelCase parameter naming convention used everywhere else; the inner
/// `RequestPermissionResponse` is the canonical ACP type so the wire shape
/// matches what a real ACP JSON-RPC peer would send.
#[tauri::command]
pub async fn acp_respond_permission(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] requestId: String,
    response: RequestPermissionResponse,
) -> Result<(), String> {
    state.resolve_permission(requestId, response).await
}

/// Phase 5: switch a session's permission mode. `modeId` is one of the four
/// canonical ACP ids: `plan` / `default` / `auto` / `bypassPermissions`. The
/// server updates the tracked mode and — if a streaming child is alive —
/// writes a `set_permission_mode` control_request to its stdin so the
/// change is immediate. Errors with a descriptive message for unknown
/// `modeId` or unknown `threadId`.
#[tauri::command]
pub async fn acp_set_mode(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] threadId: String,
    #[allow(non_snake_case)] modeId: String,
) -> Result<(), String> {
    state.handle_set_mode(threadId, modeId).await
}
