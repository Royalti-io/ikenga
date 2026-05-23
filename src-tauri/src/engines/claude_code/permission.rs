//! Phase 4: tool-approval round-trip.
//!
//! Claude (when spawned with `--permission-prompt-tool stdio`) emits an
//! `sdk_control_request` envelope on stdout whenever a tool needs approval.
//! The stream parser turns that into a `ChatEvent::ControlRequest`. Inside
//! `engines::claude_code::server::handle_prompt`, we:
//!
//!   1. Build a `RequestPermissionRequest` (ACP spec shape) with one
//!      `PermissionOption` per choice the client should be able to make.
//!      For `AskUserQuestion` we synthesize one option per answer choice
//!      across all questions (encoded into the option_id so we can map
//!      back). For any other tool we emit the canonical four:
//!      allow_once / allow_always / reject_once / reject_always.
//!   2. Emit a Tauri event on `acp://session/{threadId}/request` carrying
//!      the request_id + the ACP payload; park a oneshot keyed by
//!      `request_id`.
//!   3. The frontend (or smoke test) calls `acp_respond_permission` with
//!      the chosen outcome. That command resolves the oneshot.
//!   4. We translate the outcome back into a `sdk_control_response`
//!      envelope and write it to stdin. For `AskUserQuestion`,
//!      `updatedInput.answers` carries the actual answers in
//!      `{question: value}` form.
//!
//! This module is the pure-function half — building options, decoding
//! option ids back into answers, building the envelope body. The I/O sits
//! in `engines::claude_code::server`.

use std::collections::HashMap;

use agent_client_protocol::schema::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome,
};
use serde_json::{Map, Value};

/// Encoded option_id for an `AskUserQuestion` choice. We pack the
/// question index + the option label into the id so we can decode the
/// user's selection without any extra state on the client side.
///
/// Wire format: `ask:{q_idx}:{label}`. Labels with `:` are rare; we
/// take everything after the second `:` as the label so colons within
/// labels are preserved.
const ASK_PREFIX: &str = "ask:";

/// Canonical option ids for generic tools (Bash, Read, Write, ...).
pub const OPT_ALLOW_ONCE: &str = "allow_once";
pub const OPT_ALLOW_ALWAYS: &str = "allow_always";
pub const OPT_REJECT_ONCE: &str = "reject_once";
pub const OPT_REJECT_ALWAYS: &str = "reject_always";

/// Build the option list to surface to the ACP client. `AskUserQuestion`
/// gets one option per (question, label) pair so the client can render the
/// real form; everything else gets the four canonical allow/reject options.
pub fn build_permission_options(
    tool_name: &str,
    tool_input: Option<&Value>,
) -> Vec<PermissionOption> {
    if tool_name == "AskUserQuestion" {
        if let Some(input) = tool_input {
            return ask_user_question_options(input);
        }
    }
    generic_options()
}

fn generic_options() -> Vec<PermissionOption> {
    vec![
        PermissionOption::new(
            OPT_ALLOW_ONCE,
            "Allow once",
            PermissionOptionKind::AllowOnce,
        ),
        PermissionOption::new(
            OPT_ALLOW_ALWAYS,
            "Allow always",
            PermissionOptionKind::AllowAlways,
        ),
        PermissionOption::new(
            OPT_REJECT_ONCE,
            "Reject once",
            PermissionOptionKind::RejectOnce,
        ),
        PermissionOption::new(
            OPT_REJECT_ALWAYS,
            "Reject always",
            PermissionOptionKind::RejectAlways,
        ),
    ]
}

fn ask_user_question_options(input: &Value) -> Vec<PermissionOption> {
    let mut out = Vec::new();
    let questions = match input.get("questions").and_then(Value::as_array) {
        Some(qs) => qs,
        None => return generic_options(),
    };
    for (q_idx, q) in questions.iter().enumerate() {
        let q_header = q.get("header").and_then(Value::as_str).unwrap_or("");
        let options = q.get("options").and_then(Value::as_array);
        let opts = match options {
            Some(o) => o,
            None => continue,
        };
        for opt in opts {
            if let Some(label) = opt.get("label").and_then(Value::as_str) {
                let id = format!("{ASK_PREFIX}{q_idx}:{label}");
                let name = if q_header.is_empty() {
                    label.to_string()
                } else {
                    format!("{q_header}: {label}")
                };
                out.push(PermissionOption::new(
                    id,
                    name,
                    PermissionOptionKind::AllowOnce,
                ));
            }
        }
    }
    // Always provide a Cancel-style option so the client can decline
    // outright even when no real choice fits. Marked as reject_once.
    out.push(PermissionOption::new(
        OPT_REJECT_ONCE,
        "Cancel",
        PermissionOptionKind::RejectOnce,
    ));
    if out.is_empty() {
        generic_options()
    } else {
        out
    }
}

/// Decode an `ask:` option_id into `(question_index, label)`. Returns None
/// for any non-`ask:` id.
fn decode_ask_option(option_id: &str) -> Option<(usize, &str)> {
    let rest = option_id.strip_prefix(ASK_PREFIX)?;
    let mut split = rest.splitn(2, ':');
    let idx: usize = split.next()?.parse().ok()?;
    let label = split.next()?;
    Some((idx, label))
}

/// Translate an ACP `RequestPermissionResponse` into the JSON body of a
/// `sdk_control_response`. The wrapping `{"type":"sdk_control_response",
/// "response":{...}}` envelope is added by
/// `session::control_response_envelope`.
///
/// `tool_name` + `tool_input` are needed so we can map an AskUserQuestion
/// answer back to `updatedInput.answers`. For other tools we just emit
/// `{"behavior":"allow"}` / `{"behavior":"deny"}` with no rewritten input.
pub fn outcome_to_response_body(
    _tool_name: &str,
    tool_input: Option<&Value>,
    response: &RequestPermissionResponse,
) -> Value {
    match &response.outcome {
        RequestPermissionOutcome::Cancelled => deny_body("User cancelled"),
        RequestPermissionOutcome::Selected(sel) => {
            // AskUserQuestion fast-path via `_meta.answers`: the FE can
            // build a structured `{questionText: string | string[]}` map
            // and we forward it directly into `updatedInput.answers`. This
            // supports multiSelect (join with `, `) and the "Other" free-
            // text fallback without abusing the singular ACP `optionId`.
            if let Some(answers) = response
                .meta
                .as_ref()
                .and_then(|m| m.get("answers"))
                .and_then(Value::as_object)
            {
                return ask_user_question_allow_body_from_meta(tool_input, answers);
            }
            let id = sel.option_id.0.as_ref();
            match id {
                OPT_REJECT_ONCE | OPT_REJECT_ALWAYS => deny_body("User declined"),
                OPT_ALLOW_ONCE | OPT_ALLOW_ALWAYS => allow_body(tool_input.cloned()),
                other if other.starts_with(ASK_PREFIX) => {
                    ask_user_question_allow_body(tool_input, sel)
                }
                other => {
                    // Unknown id — be conservative and deny, but include
                    // the id in the message so a developer can trace it.
                    deny_body(&format!("Unknown permission option: {other}"))
                }
            }
        }
        // The enum is `#[non_exhaustive]`; default to deny for safety.
        _ => deny_body("Unknown permission outcome"),
    }
}

/// Forward a pre-keyed `{questionText: string | [string,...]}` map into the
/// AskUserQuestion allow body. The FE's PermissionDialog builds this when it
/// has full access to the rawInput (multiSelect arrays, "Other" free text).
/// Arrays are flattened to a comma-joined string per the AskUserQuestion
/// contract Claude expects.
fn ask_user_question_allow_body_from_meta(
    tool_input: Option<&Value>,
    answers_in: &Map<String, Value>,
) -> Value {
    let mut answers = Map::new();
    for (question, value) in answers_in {
        let answer = match value {
            Value::String(s) => Value::String(s.clone()),
            Value::Array(items) => {
                let joined = items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                Value::String(joined)
            }
            other => other.clone(),
        };
        answers.insert(question.clone(), answer);
    }
    ask_user_question_allow_body_with_answers(tool_input, answers)
}

/// Build the AskUserQuestion allow body. claude's contract requires
/// `updatedInput` to round-trip the ORIGINAL `questions` array alongside the
/// `answers` map (question text → selected label) — `updatedInput` *replaces*
/// the tool input, so omitting `questions` makes claude run the tool with no
/// questions, report "no recorded selection", and re-ask. Verified against
/// claude 2.1.150 (see Agent SDK docs: agent-sdk/user-input "Response format").
fn ask_user_question_allow_body_with_answers(
    tool_input: Option<&Value>,
    answers: Map<String, Value>,
) -> Value {
    let mut updated = Map::new();
    if let Some(questions) = tool_input.and_then(|i| i.get("questions")).cloned() {
        updated.insert("questions".into(), questions);
    }
    updated.insert("answers".into(), Value::Object(answers));
    let mut body = Map::new();
    body.insert("behavior".into(), Value::String("allow".into()));
    body.insert("updatedInput".into(), Value::Object(updated));
    Value::Object(body)
}

fn allow_body(updated_input: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("behavior".into(), Value::String("allow".into()));
    // claude expects `updatedInput` to round-trip the original tool_input
    // when we have no rewrites to apply. Omit when there's nothing.
    if let Some(input) = updated_input {
        m.insert("updatedInput".into(), input);
    } else {
        m.insert("updatedInput".into(), Value::Object(Map::new()));
    }
    Value::Object(m)
}

fn deny_body(message: &str) -> Value {
    let mut m = Map::new();
    m.insert("behavior".into(), Value::String("deny".into()));
    m.insert("message".into(), Value::String(message.to_string()));
    Value::Object(m)
}

/// Build `{"behavior":"allow","updatedInput":{"answers":{<question>:<value>}}}`
/// from an `AskUserQuestion` selection. Today we ship a *single* answer per
/// round-trip — claude calls back through `request_permission` for each
/// question. If a future protocol version batches answers, extend this
/// function to merge multiple selected options.
fn ask_user_question_allow_body(
    tool_input: Option<&Value>,
    sel: &SelectedPermissionOutcome,
) -> Value {
    let (q_idx, label) = match decode_ask_option(sel.option_id.0.as_ref()) {
        Some(t) => t,
        None => return allow_body(tool_input.cloned()),
    };
    // Look up the question text by index so the answers map is keyed
    // the way claude's AskUserQuestion spec expects.
    let question_text: String = tool_input
        .and_then(|i| i.get("questions"))
        .and_then(Value::as_array)
        .and_then(|qs| qs.get(q_idx))
        .and_then(|q| q.get("question"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut answers = Map::new();
    answers.insert(question_text, Value::String(label.to_string()));
    ask_user_question_allow_body_with_answers(tool_input, answers)
}

/// Cheap lookup helper used by the server's HashMap-of-oneshots in tests.
#[cfg(test)]
pub fn label_for_question(tool_input: &Value, q_idx: usize) -> Option<String> {
    tool_input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|qs| qs.get(q_idx))
        .and_then(|q| q.get("question"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[allow(dead_code)]
pub type PermissionWaiters =
    HashMap<String, tokio::sync::oneshot::Sender<RequestPermissionResponse>>;

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::PermissionOptionKind;
    use serde_json::json;

    #[test]
    fn generic_tool_emits_four_canonical_options() {
        let opts = build_permission_options("Bash", Some(&json!({"command": "ls"})));
        assert_eq!(opts.len(), 4);
        let ids: Vec<&str> = opts.iter().map(|o| o.option_id.0.as_ref()).collect();
        assert_eq!(
            ids,
            vec![
                OPT_ALLOW_ONCE,
                OPT_ALLOW_ALWAYS,
                OPT_REJECT_ONCE,
                OPT_REJECT_ALWAYS
            ],
        );
        assert_eq!(opts[0].kind, PermissionOptionKind::AllowOnce);
        assert_eq!(opts[3].kind, PermissionOptionKind::RejectAlways);
    }

    #[test]
    fn ask_user_question_emits_one_option_per_label_plus_cancel() {
        let input = json!({
            "questions": [
                {
                    "question": "Which color?",
                    "header": "Color",
                    "options": [
                        {"label": "Red"},
                        {"label": "Blue"},
                    ],
                }
            ]
        });
        let opts = build_permission_options("AskUserQuestion", Some(&input));
        // 2 real options + Cancel.
        assert_eq!(opts.len(), 3);
        assert_eq!(opts[0].option_id.0.as_ref(), "ask:0:Red");
        assert_eq!(opts[1].option_id.0.as_ref(), "ask:0:Blue");
        assert_eq!(opts[2].option_id.0.as_ref(), OPT_REJECT_ONCE);
        // Display name includes the header for context.
        assert_eq!(opts[0].name, "Color: Red");
    }

    #[test]
    fn permission_response_round_trip_allow_once() {
        // Selecting allow_once for a generic tool produces an `allow`
        // envelope body that echoes the original tool_input.
        let tool_input = json!({"command": "ls"});
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(OPT_ALLOW_ONCE),
        ));
        let body = outcome_to_response_body("Bash", Some(&tool_input), &resp);
        assert_eq!(body["behavior"], json!("allow"));
        assert_eq!(body["updatedInput"], tool_input);
    }

    #[test]
    fn permission_response_cancelled_builds_deny_envelope() {
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        let body = outcome_to_response_body("Bash", Some(&json!({"command": "ls"})), &resp);
        assert_eq!(body["behavior"], json!("deny"));
        assert!(body["message"].as_str().unwrap().contains("cancel"));
    }

    #[test]
    fn permission_response_reject_builds_deny_envelope() {
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(OPT_REJECT_ONCE),
        ));
        let body = outcome_to_response_body("Bash", None, &resp);
        assert_eq!(body["behavior"], json!("deny"));
    }

    #[test]
    fn ask_user_question_answer_maps_to_updated_input_answers() {
        let tool_input = json!({
            "questions": [
                {
                    "question": "Which color?",
                    "options": [{"label": "Red"}, {"label": "Blue"}],
                }
            ]
        });
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new("ask:0:Red"),
        ));
        let body = outcome_to_response_body("AskUserQuestion", Some(&tool_input), &resp);

        assert_eq!(body["behavior"], json!("allow"));
        let updated = &body["updatedInput"];
        let answers = &updated["answers"];
        assert_eq!(answers["Which color?"], json!("Red"));
        // Regression guard: `updatedInput` must round-trip the original
        // `questions` array. Dropping it makes claude report "no recorded
        // selection" and re-ask (verified against claude 2.1.150).
        assert_eq!(updated["questions"], tool_input["questions"]);
    }

    #[test]
    fn ask_user_question_unknown_option_falls_back_to_allow() {
        // An id with the `ask:` prefix but bogus index — still allow,
        // but no answers populated (claude's tool will error and we'll
        // see it on the next turn rather than blocking forever).
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new("ask:99:Phantom"),
        ));
        let body = outcome_to_response_body("AskUserQuestion", Some(&json!({})), &resp);
        assert_eq!(body["behavior"], json!("allow"));
        // The answers map is keyed by empty-string when the index doesn't
        // resolve. That's acceptable — claude will surface an error.
        assert!(body["updatedInput"]["answers"].is_object());
    }

    #[test]
    fn meta_answers_short_circuits_optionid_path() {
        // FE-built `_meta.answers` is the canonical multi-question + multi-
        // select + Other-text route. The legacy single-optionId decode is
        // bypassed entirely when meta carries an `answers` object.
        let mut meta = serde_json::Map::new();
        meta.insert(
            "answers".into(),
            json!({
                "Pick one": "Red",
                "Pick any": ["Blue", "Green"],
                "Free form": "user typed text",
            }),
        );
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            // optionId is a no-op tag — Rust ignores it when meta.answers exists.
            SelectedPermissionOutcome::new("ask:submitted"),
        ))
        .meta(meta);

        let body = outcome_to_response_body("AskUserQuestion", None, &resp);
        assert_eq!(body["behavior"], json!("allow"));
        let answers = &body["updatedInput"]["answers"];
        assert_eq!(answers["Pick one"], json!("Red"));
        // Multi-select arrays get joined with `, ` per Claude's expected shape.
        assert_eq!(answers["Pick any"], json!("Blue, Green"));
        assert_eq!(answers["Free form"], json!("user typed text"));
    }

    #[test]
    fn meta_answers_with_empty_array_yields_empty_string() {
        let mut meta = serde_json::Map::new();
        meta.insert("answers".into(), json!({ "Q": [] }));
        let resp = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new("ask:submitted"),
        ))
        .meta(meta);
        let body = outcome_to_response_body("AskUserQuestion", None, &resp);
        assert_eq!(body["updatedInput"]["answers"]["Q"], json!(""));
    }

    #[test]
    fn decode_ask_option_round_trips_label_with_colons() {
        let (idx, label) = decode_ask_option("ask:2:weird:label:with:colons").unwrap();
        assert_eq!(idx, 2);
        assert_eq!(label, "weird:label:with:colons");
    }

    #[test]
    fn label_for_question_lookup() {
        let input = json!({
            "questions": [
                {"question": "Q1"},
                {"question": "Q2"},
            ]
        });
        assert_eq!(label_for_question(&input, 0).as_deref(), Some("Q1"));
        assert_eq!(label_for_question(&input, 1).as_deref(), Some("Q2"));
        assert_eq!(label_for_question(&input, 5), None);
    }
}
