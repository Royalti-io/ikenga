//! Tauri command surface for chat engines.
//!
//! Phase 2 of the multi-engine rebuild: each command takes an `engineId`
//! first arg and dispatches via the `EngineRegistry` to the right engine
//! adapter (`ClaudeCode` or `GeminiAcp`). The frontend's typed wrappers in
//! `src/lib/tauri-cmd.ts` pass the engine id explicitly — defaulting to
//! `'claude-code'` keeps existing call sites working unchanged.
//!
//! Why one set of commands per engine instead of a dispatcher: a
//! dispatcher centralises the `engineId` → handle lookup so every
//! command stays a thin pass-through, and the `EngineHandle` enum keeps
//! the typed `State<'_, T>` problem off the command signatures (Tauri's
//! State machinery is keyed by concrete type).

use std::sync::Arc;

use agent_client_protocol::schema::{
    InitializeRequest, InitializeResponse, LoadSessionResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, PromptResponse, RequestPermissionResponse,
};
use tauri::{AppHandle, State};

use crate::claude::session::EffortLevel;
use crate::commands::db::PaDb;
use crate::engines::claude_code::fork::{ForkRequest, ForkResult};
use crate::engines::{EngineHandle, EngineRegistryState};

/// FE-facing snapshot of which engine ids are registered in the dispatcher.
/// Pairs with `detect_agents` on the frontend side: the catalog UI shows a
/// row only when an engine id is BOTH registered here AND the matching CLI
/// is detected on PATH (and authed where the auth check is decisive). Keeps
/// "live install state" honest without duplicating the `agent_detect`
/// auth-probe logic in the chat layer.
#[tauri::command]
pub async fn chat_engines_list(
    registry: State<'_, EngineRegistryState>,
) -> Result<Vec<String>, String> {
    Ok(registry.ids().await)
}

/// Default engine id used when the caller omits one. Keeps the legacy
/// FE call sites (which don't yet pass `engineId`) routing to the
/// Claude Code adapter while the migration is in flight.
const DEFAULT_ENGINE_ID: &str = "claude-code";

/// Resolve `engineId` to a concrete `EngineHandle`. Empty / unknown ids
/// fall through to a typed error so the FE sees a clear failure rather
/// than a silent route to the wrong engine.
async fn resolve_engine(
    registry: &EngineRegistryState,
    engine_id: Option<String>,
) -> Result<EngineHandle, String> {
    let id = engine_id.unwrap_or_else(|| DEFAULT_ENGINE_ID.to_string());
    registry
        .get(&id)
        .await
        .ok_or_else(|| format!("unknown chat engineId: {id}"))
}

#[tauri::command]
pub async fn chat_initialize(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    req: InitializeRequest,
) -> Result<InitializeResponse, String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => Ok(state.handle_initialize(req)),
        EngineHandle::GeminiAcp(state) => Ok(state.handle_initialize(req)),
        EngineHandle::CodexPty(state) => Ok(state.handle_initialize(req)),
        EngineHandle::CursorAgent(state) => Ok(state.handle_initialize(req)),
    }
}

#[tauri::command]
pub async fn chat_new_session(
    app: AppHandle,
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    req: NewSessionRequest,
) -> Result<NewSessionResponse, String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_new_session(app, req).await,
        EngineHandle::GeminiAcp(state) => state.handle_new_session(app, req).await,
        EngineHandle::CodexPty(state) => {
            // Codex doesn't speak ACP. Use the shell's thread-id convention
            // (FE passes `_meta.threadId`) so the id matches the chat store.
            let thread_id = req
                .meta
                .as_ref()
                .and_then(|m| m.get("threadId"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let cwd = req.cwd.to_string_lossy().into_owned();
            state.handle_new_session(thread_id, cwd).await
        }
        EngineHandle::CursorAgent(state) => state.handle_new_session(app, req).await,
    }
}

#[tauri::command]
pub async fn chat_prompt(
    app: AppHandle,
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    req: PromptRequest,
) -> Result<PromptResponse, String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_prompt(app, req).await,
        EngineHandle::GeminiAcp(state) => state.handle_prompt(app, req).await,
        EngineHandle::CodexPty(state) => {
            // Codex sees plain text. Join all text blocks; skip non-text
            // (image / audio / resource) variants since the PTY path can't
            // ferry them anyway.
            let text = req
                .prompt
                .iter()
                .filter_map(|b| match b {
                    agent_client_protocol::schema::ContentBlock::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let thread_id = req.session_id.0.to_string();
            state.handle_prompt(app, thread_id, text).await
        }
        EngineHandle::CursorAgent(state) => state.handle_prompt(app, req).await,
    }
}

#[tauri::command]
pub async fn chat_cancel(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<(), String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_cancel(threadId).await,
        EngineHandle::GeminiAcp(state) => state.handle_cancel(threadId).await,
        EngineHandle::CodexPty(state) => state.handle_cancel(threadId).await,
        EngineHandle::CursorAgent(state) => state.handle_cancel(threadId).await,
    }
}

/// Client-side reply to a `session/request_permission`. Same shape for
/// both engines; the dispatch is on `engineId`.
#[tauri::command]
pub async fn chat_respond_permission(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] requestId: String,
    response: RequestPermissionResponse,
) -> Result<(), String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.resolve_permission(requestId, response).await,
        EngineHandle::GeminiAcp(state) => state.resolve_permission(requestId, response).await,
        EngineHandle::CodexPty(state) => state.resolve_permission(requestId, response).await,
        EngineHandle::CursorAgent(state) => state.resolve_permission(requestId, response).await,
    }
}

#[tauri::command]
pub async fn chat_answer_question(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] callbackId: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    // Phase 3: AskUserQuestion answers arrive as a structured map.
    // We synthesize an ACP RequestPermissionResponse with the answers
    // in meta, matching what PermissionDialog does today but bypassing
    // the generic permission surface.
    use agent_client_protocol::schema::{
        PermissionOptionId, RequestPermissionOutcome, SelectedPermissionOutcome,
    };
    let response = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
        SelectedPermissionOutcome::new(PermissionOptionId::new("allow_once")),
    ))
    .meta({
        let mut m = serde_json::Map::new();
        m.insert("answers".into(), answers);
        m
    });

    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.resolve_permission(callbackId, response).await,
        EngineHandle::GeminiAcp(state) => state.resolve_permission(callbackId, response).await,
        EngineHandle::CodexPty(state) => state.resolve_permission(callbackId, response).await,
        EngineHandle::CursorAgent(state) => state.resolve_permission(callbackId, response).await,
    }
}

/// Switch a session's permission mode. Gemini accepts mode ids
/// passthrough; Claude validates against its four canonical ids.
#[tauri::command]
pub async fn chat_set_mode(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] threadId: String,
    #[allow(non_snake_case)] modeId: String,
) -> Result<(), String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_set_mode(threadId, modeId).await,
        EngineHandle::GeminiAcp(state) => state.handle_set_mode(threadId, modeId).await,
        EngineHandle::CodexPty(state) => state.handle_set_mode(threadId, modeId).await,
        EngineHandle::CursorAgent(state) => state.handle_set_mode(threadId, modeId).await,
    }
}

/// Set the session's model. Claude applies via `--model` on next spawn;
/// Gemini is a no-op (model switching deferred — see CAP_GEMINI).
#[tauri::command]
pub async fn chat_set_model(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] threadId: String,
    model: Option<String>,
) -> Result<(), String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_set_model(threadId, model).await,
        EngineHandle::GeminiAcp(state) => state.handle_set_model(threadId, model).await,
        EngineHandle::CodexPty(state) => state.handle_set_model(threadId, model).await,
        EngineHandle::CursorAgent(state) => state.handle_set_model(threadId, model).await,
    }
}

/// Set the session's extended-thinking effort. Claude applies via
/// `--thinking-budget-tokens`; Gemini is a no-op (effortControl = false).
#[tauri::command]
pub async fn chat_set_effort(
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] threadId: String,
    effort: EffortLevel,
) -> Result<(), String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_set_effort(threadId, effort).await,
        EngineHandle::GeminiAcp(state) => state.handle_set_effort(threadId, effort).await,
        EngineHandle::CodexPty(state) => state.handle_set_effort(threadId, effort).await,
        EngineHandle::CursorAgent(state) => state.handle_set_effort(threadId, effort).await,
    }
}

/// Phase 8 fork — Claude-specific (relies on JSONL transcript and
/// `--resume`). Gemini's fork story is deferred; calls with a Gemini
/// engine id return an error rather than silently doing nothing.
#[tauri::command]
pub async fn chat_fork_session(
    registry: State<'_, EngineRegistryState>,
    db: State<'_, Arc<PaDb>>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] sourceThreadId: String,
    #[allow(non_snake_case)] upToTurn: Option<u32>,
    label: Option<String>,
) -> Result<ForkResult, String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => {
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
        EngineHandle::GeminiAcp(_) => {
            Err("chat_fork_session: gemini engine does not yet support session fork".to_string())
        }
        EngineHandle::CodexPty(_) => {
            Err("chat_fork_session: codex engine does not yet support session fork".to_string())
        }
        EngineHandle::CursorAgent(_) => {
            Err("session/fork is not supported for cursor-agent (ADR-013 §7 OQ#3)".to_string())
        }
    }
}

/// Re-attach to a session by `threadId` without paying cold-spawn cost.
/// Claude returns its mode advertisement directly. Gemini ensures a
/// child exists and forwards `session/load`; the cwd comes from a best-
/// effort lookup (today: $HOME — the FE doesn't pass cwd on load).
#[tauri::command]
pub async fn chat_load_session(
    app: AppHandle,
    registry: State<'_, EngineRegistryState>,
    #[allow(non_snake_case)] engineId: Option<String>,
    #[allow(non_snake_case)] threadId: String,
) -> Result<LoadSessionResponse, String> {
    match resolve_engine(&registry, engineId).await? {
        EngineHandle::ClaudeCode(state) => state.handle_load_session(threadId).await,
        EngineHandle::GeminiAcp(state) => {
            state
                .handle_load_session(threadId, String::new(), app)
                .await
        }
        EngineHandle::CodexPty(state) => state.handle_load_session(threadId).await,
        EngineHandle::CursorAgent(state) => {
            state
                .handle_load_session(threadId, String::new(), app)
                .await
        }
    }
}
