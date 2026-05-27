//! Phase 5: session permission modes. ACP advertises four canonical
//! mode ids — `plan` / `default` / `auto` / `bypassPermissions` — and the
//! client switches between them via `session/set_mode`. This module maps
//! to/from claude's CLI flag values and builds the stdin envelope used to
//! switch at runtime.
//!
//! Mapping:
//!   - `plan`              → claude `plan`              (read-only planning, no edits)
//!   - `default`           → claude `default`           (asks per tool, our usual flow)
//!   - `auto`              → claude `acceptEdits`       (skips edit/write prompts, still asks for bash)
//!   - `bypassPermissions` → claude `bypassPermissions` (full auto — formerly --dangerously-skip-permissions)
//!
//! Why two names for the "auto" case: ACP standardizes on `auto` across
//! agents (Codex, Gemini, etc.) but claude's CLI flag is `acceptEdits`. The
//! two never appear together on the wire — we translate at the boundary.
//!
//! Like `permission.rs`, this module is pure-function only. The I/O for
//! writing the runtime-switch envelope to claude's stdin lives in
//! `claude::session::send_set_mode`.

use agent_client_protocol::schema::{SessionMode, SessionModeId, SessionModeState};
use serde::{Deserialize, Serialize};

use crate::claude::session::ControlWire;

pub const MODE_PLAN: &str = "plan";
pub const MODE_DEFAULT: &str = "default";
pub const MODE_AUTO: &str = "auto";
pub const MODE_BYPASS: &str = "bypassPermissions";

/// The four canonical ACP session modes we expose. `Default` is the
/// safest starting state — every tool invocation goes through the
/// permission round-trip (Phase 4). Sessions opt in to more permissive
/// modes explicitly via `session/set_mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcpSessionMode {
    Plan,
    #[default]
    Default,
    Auto,
    BypassPermissions,
}

impl AcpSessionMode {
    /// The canonical ACP id used on the wire (`session/new` response,
    /// `session/set_mode` request). Stable across agents.
    pub fn as_acp_id(&self) -> &'static str {
        match self {
            Self::Plan => MODE_PLAN,
            Self::Default => MODE_DEFAULT,
            Self::Auto => MODE_AUTO,
            Self::BypassPermissions => MODE_BYPASS,
        }
    }

    /// The string we pass to claude's `--permission-mode` CLI flag and to
    /// the runtime `set_permission_mode` control_request. Note `Auto` maps
    /// to `acceptEdits` — that's claude's name for the same concept.
    pub fn as_claude_flag(&self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Default => "default",
            Self::Auto => "acceptEdits",
            Self::BypassPermissions => "bypassPermissions",
        }
    }

    /// Inverse of `as_acp_id`. Returns `None` for any unknown id so callers
    /// can decide whether to surface an error or fall back to default.
    pub fn from_acp_id(id: &str) -> Option<Self> {
        match id {
            MODE_PLAN => Some(Self::Plan),
            MODE_DEFAULT => Some(Self::Default),
            MODE_AUTO => Some(Self::Auto),
            MODE_BYPASS => Some(Self::BypassPermissions),
            _ => None,
        }
    }
}

/// Build the list of `SessionMode` entries we advertise in the
/// `session/new` response. Names + descriptions live here so they're easy
/// to localize later.
///
/// Schema types are `#[non_exhaustive]` — we use the fluent builder
/// (`SessionMode::new(...).description(...)`) so we stay forward-compatible
/// with future field additions.
pub fn available_modes() -> Vec<SessionMode> {
    vec![
        SessionMode::new(MODE_PLAN, "Plan").description(
            "Read-only planning. Claude can browse and reason but won't edit anything.",
        ),
        SessionMode::new(MODE_DEFAULT, "Default")
            .description("Ask before every tool use. Safest day-to-day mode."),
        SessionMode::new(MODE_AUTO, "Auto").description(
            "Auto-approve file edits. Still asks for shell and other sensitive tools.",
        ),
        SessionMode::new(MODE_BYPASS, "Bypass")
            .description("Run everything without prompting. Use sparingly."),
    ]
}

/// Build the `SessionModeState` we return from `session/new`. The
/// `current_mode_id` matches the session's spawn-time mode; `available_modes`
/// is always the full canonical four.
pub fn mode_state(current: AcpSessionMode) -> SessionModeState {
    SessionModeState::new(SessionModeId::new(current.as_acp_id()), available_modes())
}

/// Build the stdin envelope claude expects for a runtime mode switch:
///
/// Modern (claude 2.1.x):
/// ```json
/// {"type":"control_request","request_id":"...","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
/// ```
/// Legacy (pre-2.1):
/// ```json
/// {"type":"sdk_control_request","request":{"subtype":"set_permission_mode","mode":"acceptEdits","request_id":"..."}}
/// ```
///
/// `wire` is pinned from the session-init `claude_code_version` (see
/// `ControlWire::from_version`). claude 2.1.150 **silently ignores** the legacy
/// shape for this subtype — sending the wrong one makes mid-session mode
/// switches no-op (verified empirically). Trailing `\n` is part of the
/// contract — claude reads stdin line-by-line. claude doesn't reply to this
/// kind of control_request, so we never park a waiter for it.
pub fn set_mode_envelope(mode: AcpSessionMode, request_id: &str, wire: ControlWire) -> String {
    let value = match wire {
        ControlWire::Modern => serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "set_permission_mode",
                "mode": mode.as_claude_flag(),
            },
        }),
        ControlWire::Legacy => serde_json::json!({
            "type": "sdk_control_request",
            "request": {
                "subtype": "set_permission_mode",
                "mode": mode.as_claude_flag(),
                "request_id": request_id,
            },
        }),
    };
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_round_trips_acp_id() {
        for m in [
            AcpSessionMode::Plan,
            AcpSessionMode::Default,
            AcpSessionMode::Auto,
            AcpSessionMode::BypassPermissions,
        ] {
            let id = m.as_acp_id();
            assert_eq!(AcpSessionMode::from_acp_id(id), Some(m));
        }
    }

    #[test]
    fn mode_maps_to_correct_claude_flag() {
        // The translation table from the Phase 5 contract. `Auto` is the
        // one that differs by name — ACP says `auto`, claude says
        // `acceptEdits`. Everything else passes through unchanged.
        assert_eq!(AcpSessionMode::Plan.as_claude_flag(), "plan");
        assert_eq!(AcpSessionMode::Default.as_claude_flag(), "default");
        assert_eq!(AcpSessionMode::Auto.as_claude_flag(), "acceptEdits");
        assert_eq!(
            AcpSessionMode::BypassPermissions.as_claude_flag(),
            "bypassPermissions"
        );
    }

    #[test]
    fn set_mode_envelope_modern_shape() {
        // claude 2.1.x: control_request, request_id top-level, no nested id.
        // Verified to actually switch the mode on 2.1.150.
        let env = set_mode_envelope(AcpSessionMode::Auto, "req_42", ControlWire::Modern);
        assert!(env.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["type"], serde_json::json!("control_request"));
        assert_eq!(parsed["request_id"], serde_json::json!("req_42"));
        assert_eq!(
            parsed["request"]["subtype"],
            serde_json::json!("set_permission_mode"),
        );
        // Auto translates to claude's `acceptEdits` on the wire.
        assert_eq!(parsed["request"]["mode"], serde_json::json!("acceptEdits"));
    }

    #[test]
    fn set_mode_envelope_legacy_shape() {
        let env = set_mode_envelope(AcpSessionMode::Auto, "req_42", ControlWire::Legacy);
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["type"], serde_json::json!("sdk_control_request"));
        assert_eq!(parsed["request"]["mode"], serde_json::json!("acceptEdits"));
        assert_eq!(parsed["request"]["request_id"], serde_json::json!("req_42"));
    }

    #[test]
    fn set_mode_envelope_passes_mode_flags_through() {
        // `plan` and `bypassPermissions` pass through verbatim (both wires).
        let env = set_mode_envelope(AcpSessionMode::Plan, "req_plan", ControlWire::Modern);
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["request"]["mode"], serde_json::json!("plan"));

        let env = set_mode_envelope(
            AcpSessionMode::BypassPermissions,
            "req_bypass",
            ControlWire::Modern,
        );
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(
            parsed["request"]["mode"],
            serde_json::json!("bypassPermissions"),
        );
    }

    #[test]
    fn from_acp_id_handles_unknown() {
        // Stale frontends / typos must not panic — caller decides whether
        // to error or default.
        assert_eq!(AcpSessionMode::from_acp_id("acceptEdits"), None);
        assert_eq!(AcpSessionMode::from_acp_id(""), None);
        assert_eq!(AcpSessionMode::from_acp_id("BYPASSPERMISSIONS"), None);
    }

    #[test]
    fn available_modes_returns_four() {
        let modes = available_modes();
        assert_eq!(modes.len(), 4);
        let ids: Vec<&str> = modes.iter().map(|m| m.id.0.as_ref()).collect();
        assert_eq!(ids, vec![MODE_PLAN, MODE_DEFAULT, MODE_AUTO, MODE_BYPASS]);
        // Names + descriptions populated so the UI can render without
        // falling back to the id.
        for m in &modes {
            assert!(!m.name.is_empty());
            assert!(m.description.as_ref().is_some_and(|d| !d.is_empty()));
        }
    }

    #[test]
    fn mode_state_uses_current_and_full_available_list() {
        // `session/new` always advertises the same four; the only thing
        // that varies per session is `current_mode_id`.
        let state = mode_state(AcpSessionMode::Auto);
        assert_eq!(state.current_mode_id.0.as_ref(), MODE_AUTO);
        assert_eq!(state.available_modes.len(), 4);
    }
}
