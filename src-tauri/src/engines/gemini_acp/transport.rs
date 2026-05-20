//! JSON-RPC stdio transport for the Gemini ACP engine.
//!
//! Spawns `gemini --acp` (or a configurable command, for
//! tests) and reads line-delimited JSON-RPC envelopes from the child's
//! stdout. Each envelope is dispatched in three directions:
//!
//!   1. A `Response` matches an in-flight request id (we sent a
//!      `session/prompt` etc.) — fire the parked oneshot.
//!   2. A `Request` from the child (today only `session/request_permission`)
//!      — emit on `chat://session/{threadId}/request` and park a waiter so
//!      the FE's `chat_respond_permission` can drive the JSON-RPC response
//!      back over stdin.
//!   3. A `Notification` (only `session/update` matters) — emit on
//!      `chat://session/{threadId}` so the FE adapter renders the streamed
//!      turn.
//!
//! Why bare tokio + manual line framing instead of
//! `agent-client-protocol-tokio`'s `AcpAgent::connect_to(...)`: the actor
//! crate is built around `Client.builder().connect_with(|cx| async move
//! { ... })` where the connection lifetime is the inner closure. That
//! shape fights long-lived sessions that receive many independent prompts
//! across the lifetime of a single child. The bare approach lets us keep
//! the child alive across `chat_prompt` calls and own the in-flight-id
//! table directly.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use agent_client_protocol::schema::{RequestPermissionRequest, SessionNotification};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};

/// JSON-RPC method name strings. The schema crate's constants for these
/// are `pub(crate)`, so we mirror the literals here. They are
/// load-bearing — drifting from the spec will silently break parsing.
pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_SESSION_NEW: &str = "session/new";
pub const METHOD_SESSION_LOAD: &str = "session/load";
pub const METHOD_SESSION_PROMPT: &str = "session/prompt";
pub const METHOD_SESSION_CANCEL: &str = "session/cancel";
pub const METHOD_SESSION_SET_MODE: &str = "session/set_mode";
pub const METHOD_SESSION_UPDATE: &str = "session/update";
pub const METHOD_SESSION_REQUEST_PERMISSION: &str = "session/request_permission";

/// Default command the engine spawns. Public so the `commands/chat.rs`
/// dispatcher can override it (e.g. for tests or alternative installs);
/// today we hard-code it. Matches the recipe used by
/// `agent_client_protocol_tokio::AcpAgent::google_gemini()`.
pub const DEFAULT_GEMINI_CMD: &str = "gemini";
// ADR-013 §1: `--acp` is the canonical flag in gemini-cli 0.42+;
// `--experimental-acp` is deprecated and prints a stderr warning.
pub const DEFAULT_GEMINI_ARGS: &[&str] = &["--acp"];

/// Errors returned from the JSON-RPC transport. Kept as `String` at the
/// public boundary so they slot into Tauri's Result<T, String> convention
/// without an extra conversion.
pub type TransportError = String;

/// One in-flight outbound request (we sent a JSON-RPC request to the
/// child). When the matching `Response` arrives the reader fires the
/// oneshot; if the child dies first we drop the sender and the caller
/// sees `RecvError`.
type ResponseWaiter = oneshot::Sender<Result<Value, JsonRpcError>>;

/// One in-flight inbound request (the child sent us a JSON-RPC request,
/// e.g. `session/request_permission`). The transport parks a oneshot
/// keyed by the *child's* request id. The FE's `chat_respond_permission`
/// drives the matching `respond_to_inbound_request` call, which writes
/// the JSON-RPC response back to the child's stdin.
type InboundRequestWaiter = oneshot::Sender<Value>;

/// Parsed JSON-RPC envelope. Mirrors the three shapes that can appear on
/// stdout: a request from the child, a response to one we sent, or a
/// notification. We keep `id` typed as `Value` to round-trip whatever
/// the peer used (number or string).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum InboundEnvelope {
    /// `{"jsonrpc":"2.0","id":1,"method":"...","params":{...}}` — child
    /// is asking us to do something (permission round-trip).
    Request {
        id: Value,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// `{"jsonrpc":"2.0","id":1,"result":{...}}` — child is replying to
    /// a request we sent.
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<JsonRpcError>,
    },
    /// `{"jsonrpc":"2.0","method":"...","params":{...}}` — child is
    /// pushing a notification (session/update).
    Notification {
        method: String,
        #[serde(default)]
        params: Value,
    },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Outbound JSON-RPC request envelope. We construct these manually rather
/// than reusing the schema crate's `Request<P>` because that wrapper
/// requires `Arc<str>` and a typed Params, and we want the freedom to
/// pass `serde_json::Value` here.
#[derive(Serialize)]
struct OutboundRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Serialize)]
struct OutboundResponse<'a> {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a JsonRpcError>,
}

#[derive(Serialize)]
struct OutboundNotification<'a> {
    jsonrpc: &'static str,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

/// Inner state shared between the transport's public surface (the engine
/// calls `request` / `notify` / `respond`) and its background reader task
/// (which fires waiters as responses come back).
pub struct TransportInner {
    /// Stdin handle to the child. Locked across writes so concurrent
    /// `request` calls don't interleave bytes.
    stdin: TokioMutex<ChildStdin>,
    /// Monotonic id allocator for outbound requests.
    next_id: TokioMutex<u64>,
    /// Parked oneshots for outbound requests we're waiting on a reply to.
    response_waiters: TokioMutex<HashMap<u64, ResponseWaiter>>,
    /// Parked oneshots for inbound requests the child sent us (today only
    /// `session/request_permission`). Keyed by the child's id (we store
    /// it as a String to handle both number + string ids uniformly).
    inbound_waiters: TokioMutex<HashMap<String, InboundRequestWaiter>>,
}

/// Public transport handle. Cloneable via `Arc`; multiple chat-command
/// handlers can share one and the in-flight tables stay coherent.
#[derive(Clone)]
pub struct Transport {
    inner: Arc<TransportInner>,
}

/// Per-thread session state. The transport owns one child process per
/// `threadId` — spawned lazily on `ensure_for_thread` and kept alive
/// across prompts.
pub struct GeminiChild {
    pub transport: Transport,
    /// Held so the child stays alive; dropped on session teardown.
    pub child: TokioMutex<Child>,
    /// Whether we've sent the `initialize` handshake yet. The Gemini ACP
    /// CLI requires this before any session/* call.
    pub initialized: TokioMutex<bool>,
    /// Gemini's own session id (returned from `session/new` — agent-allocated
    /// per ACP). All subsequent session/* requests MUST address Gemini using
    /// THIS id, not the Ikenga `threadId` we use as the FE-visible session
    /// key. `None` until `session/new` has run; populated by
    /// `handle_new_session` and read by every forwarding call site so the
    /// kernel never sends gemini a sessionId it has never heard of (the
    /// `-32602 Session not found` bug).
    pub gemini_session_id: TokioMutex<Option<String>>,
}

impl Transport {
    /// Spawn `gemini --acp` (or the override command, used
    /// by tests) and wire up its stdio. Spawns a background task that
    /// reads stdout line by line, dispatches inbound envelopes, and
    /// fires the response waiters. The returned `Transport` plus the
    /// owned `Child` should be stored on the per-session state — drop
    /// either to tear the child down.
    pub async fn spawn(
        thread_id: String,
        cwd: &str,
        app: AppHandle,
        command: &str,
        args: &[&str],
    ) -> Result<(Self, Child), TransportError> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Augmented PATH so the spawned CLI (and any node/bun it shells
            // out to) resolves under nvm/npm/homebrew even when the app
            // inherited a thin GUI $PATH (ADR-013 §Addendum Decision 2).
            .env("PATH", crate::runtime::augmented_path())
            .kill_on_drop(true);
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn {command}: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "gemini stdin not piped".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "gemini stdout not piped".to_string())?;
        // Stderr is read-and-log to keep the OS pipe from filling up.
        // Crucially we never block waiting on it.
        if let Some(stderr) = child.stderr.take() {
            let tid = thread_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::debug!(
                        target: "ikenga::engines::gemini_acp",
                        "gemini[{tid}] stderr: {line}",
                    );
                }
            });
        }

        let inner = Arc::new(TransportInner {
            stdin: TokioMutex::new(stdin),
            next_id: TokioMutex::new(1),
            response_waiters: TokioMutex::new(HashMap::new()),
            inbound_waiters: TokioMutex::new(HashMap::new()),
        });
        let transport = Self {
            inner: inner.clone(),
        };

        // Reader task: line-buffer stdout, dispatch envelopes.
        let app_for_reader = app.clone();
        let tid_for_reader = thread_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        dispatch_line(&inner, &app_for_reader, &tid_for_reader, &line).await;
                    }
                    Ok(None) => break, // EOF — child exited
                    Err(e) => {
                        log::warn!(
                            target: "ikenga::engines::gemini_acp",
                            "gemini[{tid_for_reader}] stdout read error: {e}",
                        );
                        break;
                    }
                }
            }
            // Fire any remaining waiters with a closed-stream error so
            // pending requests don't dangle forever.
            let mut waiters = inner.response_waiters.lock().await;
            for (_, tx) in waiters.drain() {
                let _ = tx.send(Err(JsonRpcError {
                    code: -32000,
                    message: "gemini child exited".to_string(),
                    data: None,
                }));
            }
        });

        Ok((transport, child))
    }

    /// Send a JSON-RPC request and await its reply. Returns the typed
    /// result value (i.e. the JSON-RPC `result` field, NOT the full
    /// envelope). Errors out if the child returned a JSON-RPC error or
    /// the connection closed.
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, TransportError> {
        let id = {
            let mut next = self.inner.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };
        let (tx, rx) = oneshot::channel();
        self.inner.response_waiters.lock().await.insert(id, tx);

        let envelope = OutboundRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        let line = serde_json::to_string(&envelope)
            .map_err(|e| format!("serialize {method}: {e}"))?;
        self.write_line(&line).await?;

        match rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(format!("{} returned error {}: {}", method, e.code, e.message)),
            Err(_) => Err(format!("{} channel closed (child likely exited)", method)),
        }
    }

    /// Send a JSON-RPC notification (no reply expected). Used for
    /// `session/cancel`.
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), TransportError> {
        let envelope = OutboundNotification {
            jsonrpc: "2.0",
            method,
            params,
        };
        let line = serde_json::to_string(&envelope)
            .map_err(|e| format!("serialize notification {method}: {e}"))?;
        self.write_line(&line).await
    }

    /// Reply to an inbound request the child sent us. `id` must be the
    /// id of that request as the child sent it (round-tripped through
    /// the `session/request_permission` event payload).
    pub async fn respond(
        &self,
        id: Value,
        result: Option<Value>,
        error: Option<JsonRpcError>,
    ) -> Result<(), TransportError> {
        let envelope = OutboundResponse {
            jsonrpc: "2.0",
            id,
            result: result.as_ref(),
            error: error.as_ref(),
        };
        let line = serde_json::to_string(&envelope)
            .map_err(|e| format!("serialize response: {e}"))?;
        self.write_line(&line).await
    }

    /// Park a oneshot keyed by the child's inbound request id. The
    /// engine's `resolve_permission` looks this up + fires it when the
    /// FE calls `chat_respond_permission`.
    pub async fn park_inbound_waiter(&self, request_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .inbound_waiters
            .lock()
            .await
            .insert(request_id, tx);
        rx
    }

    /// Resolve a parked inbound waiter. Returns false when the id is
    /// unknown (stale UI reply).
    pub async fn resolve_inbound_waiter(&self, request_id: &str, response: Value) -> bool {
        if let Some(tx) = self.inner.inbound_waiters.lock().await.remove(request_id) {
            let _ = tx.send(response);
            true
        } else {
            false
        }
    }

    async fn write_line(&self, line: &str) -> Result<(), TransportError> {
        let mut stdin = self.inner.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("write stdin newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin: {e}"))?;
        Ok(())
    }
}

/// Parse one stdout line + route it to the right place. Pure async — no
/// panics, no early returns that would skip waker work; on parse failure
/// we log and drop.
async fn dispatch_line(inner: &Arc<TransportInner>, app: &AppHandle, thread_id: &str, line: &str) {
    let envelope: InboundEnvelope = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                target: "ikenga::engines::gemini_acp",
                "gemini[{thread_id}] failed to parse line: {e}; raw: {line}",
            );
            return;
        }
    };

    match envelope {
        InboundEnvelope::Response { id, result, error } => {
            // Numeric id round-tripping: we always send u64 ids, so a
            // well-formed peer always returns a JSON number. Fall through
            // gracefully if it's something else.
            let Some(id_num) = id.as_u64() else {
                log::warn!(
                    target: "ikenga::engines::gemini_acp",
                    "gemini[{thread_id}] response with non-numeric id: {id}",
                );
                return;
            };
            let mut waiters = inner.response_waiters.lock().await;
            if let Some(tx) = waiters.remove(&id_num) {
                let value = if let Some(err) = error {
                    Err(err)
                } else {
                    Ok(result.unwrap_or(Value::Null))
                };
                let _ = tx.send(value);
            }
        }
        InboundEnvelope::Notification { method, params } => {
            handle_notification(app, thread_id, &method, params).await;
        }
        InboundEnvelope::Request { id, method, params } => {
            handle_inbound_request(inner, app, thread_id, id, &method, params).await;
        }
    }
}

/// Route an inbound `session/update` (or other) notification to its
/// matching Tauri event channel. We re-emit the *params* of the
/// notification directly so the FE's existing `AcpSessionNotification`
/// listener handles them with no shape change.
async fn handle_notification(app: &AppHandle, thread_id: &str, method: &str, params: Value) {
    if method == METHOD_SESSION_UPDATE {
        // Per-engine channel suffix (`.../gemini`) so an adapter only
        // receives its own engine's events — without it, two adapters
        // attached to the same thread (e.g. claude-code as the original
        // engine + gemini after a per-turn swap) both render every event
        // and assistant text appears doubled.
        let channel = format!("chat://session/{thread_id}/gemini");
        // Gemini emits a fully-formed SessionNotification — try to parse
        // it through the schema crate to confirm shape, but fall through
        // and emit the raw value if our schema version is behind.
        match serde_json::from_value::<SessionNotification>(params.clone()) {
            Ok(notif) => {
                let _ = app.emit(&channel, &notif);
            }
            Err(e) => {
                log::debug!(
                    target: "ikenga::engines::gemini_acp",
                    "gemini[{thread_id}] session/update did not fit SessionNotification schema ({e}); emitting raw",
                );
                let _ = app.emit(&channel, &params);
            }
        }
    } else {
        log::debug!(
            target: "ikenga::engines::gemini_acp",
            "gemini[{thread_id}] ignoring notification method={method}",
        );
    }
}

/// Route an inbound request the child made of us. Today the only one
/// we expect is `session/request_permission`; emit it on the
/// `chat://session/{id}/request` channel + park a waiter keyed by the
/// child's id so a later `chat_respond_permission` can write a reply.
async fn handle_inbound_request(
    inner: &Arc<TransportInner>,
    app: &AppHandle,
    thread_id: &str,
    id: Value,
    method: &str,
    params: Value,
) {
    if method != METHOD_SESSION_REQUEST_PERMISSION {
        // Unknown inbound request — reply with method-not-found so the
        // child doesn't dangle.
        let err = JsonRpcError {
            code: -32601,
            message: format!("method not implemented: {method}"),
            data: None,
        };
        let envelope = OutboundResponse {
            jsonrpc: "2.0",
            id: id.clone(),
            result: None,
            error: Some(&err),
        };
        if let Ok(line) = serde_json::to_string(&envelope) {
            let mut stdin = inner.stdin.lock().await;
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
        }
        return;
    }

    // Best-effort schema check (re-emit even on schema drift).
    if let Err(e) = serde_json::from_value::<RequestPermissionRequest>(params.clone()) {
        log::debug!(
            target: "ikenga::engines::gemini_acp",
            "gemini[{thread_id}] permission request did not fit schema ({e}); emitting raw",
        );
    }

    // Key the inbound waiter by the child's id (stringified). The FE
    // sends back an id-as-string in `chat_respond_permission`; we map
    // it back to a JSON id at write time.
    let id_key = match &id {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => {
            log::warn!(
                target: "ikenga::engines::gemini_acp",
                "gemini[{thread_id}] permission request with non-scalar id: {id}",
            );
            return;
        }
    };

    // Park the waiter + spawn a task that writes the response when the
    // FE replies. We don't block this function — the outer reader loop
    // must keep draining stdout.
    let (tx, rx) = oneshot::channel::<Value>();
    inner
        .inbound_waiters
        .lock()
        .await
        .insert(id_key.clone(), tx);

    // Emit on the request channel using the same payload shape Claude
    // uses: `{ requestId, request }`. The FE adapter consumes both.
    // Engine suffix so chatListenRequests' per-engine listener picks it
    // up without colliding with the other engines on the same thread.
    let request_channel = format!("chat://session/{thread_id}/gemini/request");
    let payload = serde_json::json!({
        "requestId": id_key,
        "request": params,
    });
    let _ = app.emit(&request_channel, &payload);

    // Spawn a writer task that awaits the parked oneshot and writes the
    // JSON-RPC response back to stdin.
    let inner_for_task = inner.clone();
    let id_for_task = id;
    let id_key_for_task = id_key;
    let thread_id_for_task = thread_id.to_string();
    tauri::async_runtime::spawn(async move {
        match rx.await {
            Ok(result_value) => {
                let envelope = OutboundResponse {
                    jsonrpc: "2.0",
                    id: id_for_task,
                    result: Some(&result_value),
                    error: None,
                };
                if let Ok(line) = serde_json::to_string(&envelope) {
                    let mut stdin = inner_for_task.stdin.lock().await;
                    if let Err(e) = stdin.write_all(line.as_bytes()).await {
                        log::warn!(
                            target: "ikenga::engines::gemini_acp",
                            "gemini[{thread_id_for_task}] write permission response: {e}",
                        );
                    }
                    let _ = stdin.write_all(b"\n").await;
                    let _ = stdin.flush().await;
                }
            }
            Err(_) => {
                // FE dropped (cancellation, timeout). Reply with a
                // synthetic Cancelled outcome so the child doesn't hang.
                log::debug!(
                    target: "ikenga::engines::gemini_acp",
                    "gemini[{thread_id_for_task}] permission waiter {id_key_for_task} dropped; replying Cancelled",
                );
                let result_value = serde_json::json!({ "outcome": { "outcome": "cancelled" } });
                let envelope = OutboundResponse {
                    jsonrpc: "2.0",
                    id: id_for_task,
                    result: Some(&result_value),
                    error: None,
                };
                if let Ok(line) = serde_json::to_string(&envelope) {
                    let mut stdin = inner_for_task.stdin.lock().await;
                    let _ = stdin.write_all(line.as_bytes()).await;
                    let _ = stdin.write_all(b"\n").await;
                    let _ = stdin.flush().await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure parser test — exercise the InboundEnvelope deserializer on
    /// each of the three shapes Gemini will emit. No child needed.
    #[test]
    fn parse_response_envelope() {
        let line =
            r#"{"jsonrpc":"2.0","id":7,"result":{"sessionId":"abc","modes":null}}"#;
        let env: InboundEnvelope = serde_json::from_str(line).unwrap();
        match env {
            InboundEnvelope::Response { id, result, error } => {
                assert_eq!(id.as_u64(), Some(7));
                assert!(error.is_none());
                let r = result.expect("result present");
                assert_eq!(r["sessionId"].as_str(), Some("abc"));
            }
            _ => panic!("expected Response variant"),
        }
    }

    #[test]
    fn parse_notification_envelope() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"abc","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}"#;
        let env: InboundEnvelope = serde_json::from_str(line).unwrap();
        match env {
            InboundEnvelope::Notification { method, params } => {
                assert_eq!(method, METHOD_SESSION_UPDATE);
                assert_eq!(params["sessionId"], "abc");
            }
            _ => panic!("expected Notification variant"),
        }
    }

    #[test]
    fn parse_inbound_request_envelope() {
        let line = r#"{"jsonrpc":"2.0","id":"req-1","method":"session/request_permission","params":{"sessionId":"abc","toolCall":{"toolCallId":"tc1","title":"Run cmd"},"options":[{"optionId":"allow_once","name":"Allow","kind":"allow_once"}]}}"#;
        let env: InboundEnvelope = serde_json::from_str(line).unwrap();
        match env {
            InboundEnvelope::Request { id, method, .. } => {
                assert_eq!(id.as_str(), Some("req-1"));
                assert_eq!(method, METHOD_SESSION_REQUEST_PERMISSION);
            }
            _ => panic!("expected Request variant"),
        }
    }

    #[test]
    fn parse_response_with_error() {
        let line = r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"method not found"}}"#;
        let env: InboundEnvelope = serde_json::from_str(line).unwrap();
        match env {
            InboundEnvelope::Response { id, result, error } => {
                assert_eq!(id.as_u64(), Some(3));
                assert!(result.is_none());
                let err = error.expect("error present");
                assert_eq!(err.code, -32601);
                assert_eq!(err.message, "method not found");
            }
            _ => panic!("expected Response variant"),
        }
    }

    /// Exercise the response-dispatch logic against a hand-built
    /// waiters map (the same logic dispatch_line runs internally).
    /// We don't construct a full `TransportInner` because `ChildStdin`
    /// can't be synthesized in unit tests — proving the parser + the
    /// waiter-fire semantics is enough to lock the contract.
    #[tokio::test]
    async fn dispatch_response_fires_waiter() {
        let waiters: HashMap<u64, ResponseWaiter> = HashMap::new();
        let waiters = TokioMutex::new(waiters);
        let (tx, rx) = oneshot::channel();
        waiters.lock().await.insert(42, tx);

        // Same logic as dispatch_line's Response arm, inlined here.
        let line = r#"{"jsonrpc":"2.0","id":42,"result":{"ok":true}}"#;
        let env: InboundEnvelope = serde_json::from_str(line).unwrap();
        if let InboundEnvelope::Response { id, result, error } = env {
            let id_num = id.as_u64().unwrap();
            let mut guard = waiters.lock().await;
            let tx = guard.remove(&id_num).unwrap();
            let value = if let Some(err) = error {
                Err(err)
            } else {
                Ok(result.unwrap_or(Value::Null))
            };
            let _ = tx.send(value);
        }

        let received = rx.await.expect("waiter fires");
        let received = received.expect("ok result");
        assert_eq!(received["ok"], true);
    }

    /// Multi-line input: feeding the parser a stream of mixed
    /// envelopes (response + notification + request) should parse each
    /// one in isolation.
    #[test]
    fn parse_mixed_envelopes_stream() {
        let lines = vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}"#,
            r#"{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"tc1","title":"x"},"options":[]}}"#,
        ];
        let mut counts = (0u32, 0u32, 0u32); // (response, notification, request)
        for line in lines {
            let env: InboundEnvelope = serde_json::from_str(line).unwrap();
            match env {
                InboundEnvelope::Response { .. } => counts.0 += 1,
                InboundEnvelope::Notification { .. } => counts.1 += 1,
                InboundEnvelope::Request { .. } => counts.2 += 1,
            }
        }
        assert_eq!(counts, (1, 1, 1));
    }
}
