//! Tauri command surface for the ACP server.
//!
//! Phase 3: thin pass-throughs to `AcpServer`. The frontend speaks ACP
//! types (mirrored in `src/lib/tauri-cmd.ts`); these wrappers exist so
//! we can register them in the `invoke_handler!` macro without dragging
//! `agent-client-protocol` schema concerns into `lib.rs`.

use std::sync::Arc;

use agent_client_protocol::schema::{
    InitializeRequest, InitializeResponse, LoadSessionResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, PromptResponse, RequestPermissionResponse,
};
use tauri::{AppHandle, State};

use crate::acp::fork::{ForkRequest, ForkResult};
use crate::acp::server::AcpServerState;
use crate::claude::session::EffortLevel;
use crate::commands::db::PaDb;

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

/// ADR-011 phase 3: set the session's `--model`. `model = None` clears it
/// so the next spawn falls back to claude's own default. Per-turn
/// switching is deferred — changes mutate `SessionOpts` only; if a
/// streaming child is alive, the change takes effect on the next spawn.
#[tauri::command]
pub async fn acp_set_model(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] threadId: String,
    model: Option<String>,
) -> Result<(), String> {
    state.handle_set_model(threadId, model).await
}

/// ADR-011 phase 3: set the session's extended-thinking effort. Stored
/// on `SessionOpts` and applied via `--thinking-budget-tokens` on next
/// spawn (omitted entirely when `effort = "off"`).
#[tauri::command]
pub async fn acp_set_effort(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] threadId: String,
    effort: EffortLevel,
) -> Result<(), String> {
    state.handle_set_effort(threadId, effort).await
}

/// Phase 8: ACP `session/fork`. Clones an existing thread from a chosen
/// turn — the new thread inherits the source's `claude_session_id` so
/// the first prompt resumes from the on-disk JSONL. See
/// `crate::acp::fork` for the Phase 8 contract; transcript byte-for-byte
/// divergence is deferred to a later phase.
#[tauri::command]
pub async fn acp_fork_session(
    state: State<'_, AcpServerState>,
    db: State<'_, Arc<PaDb>>,
    #[allow(non_snake_case)] sourceThreadId: String,
    #[allow(non_snake_case)] upToTurn: Option<u32>,
    label: Option<String>,
) -> Result<ForkResult, String> {
    state
        .handle_fork_session(
            db.inner(),
            ForkRequest {
                source_thread_id: sourceThreadId,
                up_to_turn: upToTurn,
                label,
            },
        )
        .await
}

/// Phase 8: ACP `session/load`. Re-attach to a session by `threadId`
/// without paying the cold-spawn cost. Returns the session's current
/// mode advertisement so the frontend's mode picker hydrates instantly.
/// The on-disk JSONL transcript is loaded via the existing
/// `claude_read_jsonl` path — this call only signals "loadable".
#[tauri::command]
pub async fn acp_load_session(
    state: State<'_, AcpServerState>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<LoadSessionResponse, String> {
    state.handle_load_session(threadId).await
}
