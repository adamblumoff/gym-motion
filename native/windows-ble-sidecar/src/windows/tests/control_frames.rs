use super::*;

#[test]
fn frames_runtime_control_commands_for_firmware_parser() {
    let frames = control_command_frames(r#"{"type":"sync-now"}"#);

    assert_eq!(frames.first().map(Vec::as_slice), Some(&b"BEGIN:19"[..]));
    assert_eq!(
        frames.get(1).map(Vec::as_slice),
        Some(&br#"{"type":"sync-now"}"#[..])
    );
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

#[test]
fn frames_combined_app_session_begin_commands_for_firmware_parser() {
    let payload = format!(
        r#"{{"type":"app-session-begin","sessionId":"session-1","sessionNonce":"nonce-1","expiresInMs":{}}}"#,
        15_000
    );
    let frames = control_command_frames(&payload);

    assert_eq!(
        frames.first().map(Vec::as_slice),
        Some(format!("BEGIN:{}", payload.len()).as_bytes())
    );

    let body = frames[1..frames.len() - 1]
        .iter()
        .flat_map(|frame| frame.iter().copied())
        .collect::<Vec<_>>();
    let decoded: Value =
        serde_json::from_slice(&body).expect("combined payload should decode as JSON");

    assert_eq!(decoded["type"], "app-session-begin");
    assert_eq!(decoded["sessionId"], "session-1");
    assert_eq!(decoded["sessionNonce"], "nonce-1");
    assert_eq!(decoded["expiresInMs"], 15_000);
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

#[test]
fn frames_app_session_lease_commands_for_firmware_parser() {
    let payload = format!(
        r#"{{"type":"app-session-lease","sessionId":"session-1","expiresInMs":{}}}"#,
        15_000
    );
    let frames = control_command_frames(&payload);

    assert_eq!(
        frames.first().map(Vec::as_slice),
        Some(format!("BEGIN:{}", payload.len()).as_bytes())
    );

    let body = frames[1..frames.len() - 1]
        .iter()
        .flat_map(|frame| frame.iter().copied())
        .collect::<Vec<_>>();
    let decoded: Value =
        serde_json::from_slice(&body).expect("lease payload should decode as JSON");

    assert_eq!(decoded["type"], "app-session-lease");
    assert_eq!(decoded["sessionId"], "session-1");
    assert_eq!(decoded["expiresInMs"], 15_000);
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

#[test]
fn frames_history_page_request_commands_for_firmware_parser() {
    let payload = r#"{"type":"history-page-request","sessionId":"session-1","requestId":"device-1:boot-1:731:123","afterSequence":731,"maxRecords":256}"#;
    let frames = control_command_frames(payload);

    assert_eq!(
        frames.first().map(Vec::as_slice),
        Some(format!("BEGIN:{}", payload.len()).as_bytes())
    );

    let body = frames[1..frames.len() - 1]
        .iter()
        .flat_map(|frame| frame.iter().copied())
        .collect::<Vec<_>>();
    let decoded: Value =
        serde_json::from_slice(&body).expect("history request payload should decode as JSON");

    assert_eq!(decoded["type"], "history-page-request");
    assert_eq!(decoded["sessionId"], "session-1");
    assert_eq!(decoded["requestId"], "device-1:boot-1:731:123");
    assert_eq!(decoded["afterSequence"], 731);
    assert_eq!(decoded["maxRecords"], 256);
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}
