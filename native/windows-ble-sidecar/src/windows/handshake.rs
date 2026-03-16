use anyhow::Result;
use btleplug::{
    api::{Characteristic, Peripheral as _, WriteType},
    platform::Peripheral,
};
use serde_json::json;

const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
const CONTROL_CHUNK_SIZE: usize = 120;

pub(crate) async fn send_app_session_lease(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    session_id: &str,
) -> Result<()> {
    let payload = json!({
        "type": "app-session-lease",
        "sessionId": session_id,
        "expiresInMs": APP_SESSION_LEASE_TIMEOUT_MS,
    })
    .to_string();
    write_chunked_json_command(peripheral, characteristic, &payload).await
}

pub(crate) async fn send_app_session_bootstrap(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
) -> Result<()> {
    write_chunked_json_command(
        peripheral,
        characteristic,
        r#"{"type":"app-session-bootstrap"}"#,
    )
    .await
}

pub(crate) async fn write_chunked_json_command(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    for chunk in control_command_frames(payload) {
        peripheral
            .write(characteristic, &chunk, WriteType::WithResponse)
            .await?;
    }

    Ok(())
}

pub(crate) fn control_command_frames(payload: &str) -> Vec<Vec<u8>> {
    let mut frames = Vec::with_capacity((payload.len() / CONTROL_CHUNK_SIZE) + 2);
    frames.push(format!("BEGIN:{}", payload.len()).into_bytes());

    for chunk in payload.as_bytes().chunks(CONTROL_CHUNK_SIZE) {
        frames.push(chunk.to_vec());
    }

    frames.push(b"END".to_vec());
    frames
}
