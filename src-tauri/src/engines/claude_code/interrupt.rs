//! Phase 6: clean interrupt. ACP `session/cancel` translates into an
//! `sdk_control_request { subtype: "interrupt" }` written to claude's
//! stdin. Claude stops mid-turn and emits its normal `Done` envelope, so
//! the prompt loop in `engines::claude_code::server::handle_prompt` exits naturally without
//! killing the child. Transcript stays intact and the next turn re-uses
//! the same streaming process.
//!
//! Claude does NOT reply with a `sdk_control_response` for interrupts —
//! the response is implicit (the `Done` event). So unlike the permission
//! round-trip, this is a fire-and-forget stdin write.
//!
//! Like `mode.rs` and `permission.rs`, this module is pure-function only.
//! The I/O for writing the interrupt envelope to claude's stdin lives in
//! `claude::session::send_interrupt`.

/// Build the line-delimited `sdk_control_request` envelope claude expects
/// to interrupt the current turn. Trailing `\n` is part of the contract —
/// claude reads stdin line-by-line.
///
/// Shape:
///
/// ```json
/// {"type":"sdk_control_request","request":{"subtype":"interrupt","request_id":"..."}}
/// ```
///
/// We include `request_id` so claude's internal correlator doesn't choke
/// on a missing field; claude doesn't reply to this kind of
/// control_request (the `Done` event is the implicit response), so we
/// never park a waiter for it.
pub fn interrupt_envelope(request_id: &str) -> String {
    let value = serde_json::json!({
        "type": "sdk_control_request",
        "request": {
            "subtype": "interrupt",
            "request_id": request_id,
        },
    });
    let mut s = serde_json::to_string(&value).unwrap_or_else(|_| String::from("{}"));
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupt_envelope_has_correct_shape() {
        // Sanity-check the exact wire shape claude expects to interrupt
        // the current turn. Trailing newline is part of the contract.
        let env = interrupt_envelope("req_int_42");
        assert!(env.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(env.trim_end()).expect("envelope is JSON");
        assert_eq!(parsed["type"], serde_json::json!("sdk_control_request"));
        assert_eq!(parsed["request"]["subtype"], serde_json::json!("interrupt"),);
        assert_eq!(
            parsed["request"]["request_id"],
            serde_json::json!("req_int_42"),
        );
    }

    #[test]
    fn interrupt_envelope_serializes_as_one_line() {
        // Claude reads stdin line-by-line — there must be exactly one
        // newline (the trailing one), no embedded newlines from a
        // pretty-printed serializer.
        let env = interrupt_envelope("req_x");
        let newline_count = env.matches('\n').count();
        assert_eq!(
            newline_count, 1,
            "expected exactly one trailing newline, got {newline_count}",
        );
        assert!(env.ends_with('\n'));
        // The body itself (everything before the trailing \n) must not
        // contain any newlines.
        let body = env.trim_end_matches('\n');
        assert!(!body.contains('\n'));
    }
}
