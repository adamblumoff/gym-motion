use anyhow::{Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _, WriteType},
    platform::Peripheral,
};
use serde_json::json;
use tokio::time::{sleep, Duration};

const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
// Keep control writes comfortably below common negotiated ATT MTUs so the
// firmware always receives each framed body chunk as a normal write callback.
const CONTROL_CHUNK_SIZE: usize = 96;
const COMMAND_WRITE_ATTEMPTS: u32 = 3;
const COMMAND_WRITE_RETRY_DELAY_MS: u64 = 200;
const CONTROL_FRAME_WRITE_INTERVAL_MS: u64 = 20;

const CONTROL_WRITE_TYPE: WriteType = WriteType::WithResponse;

pub(crate) fn control_write_mode(payload: &str) -> &'static str {
    let _ = payload;
    "framed"
}

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

pub(crate) async fn send_app_session_begin(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    session_nonce: &str,
    session_id: &str,
) -> Result<()> {
    let payload = json!({
        "type": "app-session-begin",
        "sessionId": session_id,
        "sessionNonce": session_nonce,
        "expiresInMs": APP_SESSION_LEASE_TIMEOUT_MS,
    })
    .to_string();
    write_chunked_json_command(peripheral, characteristic, &payload).await
}

pub(crate) async fn write_chunked_json_command(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    write_chunked_json_command_with_type(peripheral, characteristic, payload, CONTROL_WRITE_TYPE).await
}

pub(crate) async fn write_chunked_json_command_with_type(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
    write_type: WriteType,
) -> Result<()> {
    let frames = control_command_frames(payload);
    for attempt in 1..=COMMAND_WRITE_ATTEMPTS {
        let mut last_error = None;
        for chunk in &frames {
            if let Err(error) = peripheral
                .write(characteristic, chunk, write_type)
                .await
            {
                last_error = Some(error);
                break;
            }
            sleep(Duration::from_millis(CONTROL_FRAME_WRITE_INTERVAL_MS)).await;
        }

        if let Some(error) = last_error {
            if attempt == COMMAND_WRITE_ATTEMPTS {
                return Err(error).with_context(|| {
                    format!("chunked control write failed after {COMMAND_WRITE_ATTEMPTS} attempts")
                });
            }
            sleep(Duration::from_millis(COMMAND_WRITE_RETRY_DELAY_MS)).await;
            continue;
        }

        return Ok(());
    }

    unreachable!("command write loop should return before exhausting attempts");
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
