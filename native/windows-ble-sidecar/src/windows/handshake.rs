use anyhow::{Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _, WriteType},
    platform::Peripheral,
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
const CONTROL_CHUNK_SIZE: usize = 120;
const COMMAND_WRITE_ATTEMPTS: u32 = 3;
const COMMAND_WRITE_RETRY_DELAY_MS: u64 = 200;

pub(crate) type ControlWriteLock = Arc<Mutex<()>>;

pub(crate) fn new_control_write_lock() -> ControlWriteLock {
    Arc::new(Mutex::new(()))
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

pub(crate) async fn send_app_session_bootstrap(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    session_nonce: &str,
) -> Result<()> {
    let payload = json!({
        "type": "app-session-bootstrap",
        "sessionNonce": session_nonce,
    })
    .to_string();
    write_chunked_json_command(peripheral, characteristic, &payload).await
}

pub(crate) async fn send_app_session_lease_locked(
    control_write_lock: &ControlWriteLock,
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
    write_chunked_json_command_locked(control_write_lock, peripheral, characteristic, &payload)
        .await
}

pub(crate) async fn send_app_session_bootstrap_locked(
    control_write_lock: &ControlWriteLock,
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    session_nonce: &str,
) -> Result<()> {
    let payload = json!({
        "type": "app-session-bootstrap",
        "sessionNonce": session_nonce,
    })
    .to_string();
    write_chunked_json_command_locked(control_write_lock, peripheral, characteristic, &payload)
        .await
}

pub(crate) async fn write_chunked_json_command(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    let frames = control_command_frames(payload);
    for attempt in 1..=COMMAND_WRITE_ATTEMPTS {
        let mut last_error = None;
        for chunk in &frames {
            if let Err(error) = peripheral
                .write(characteristic, chunk, WriteType::WithResponse)
                .await
            {
                last_error = Some(error);
                break;
            }
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

pub(crate) async fn write_chunked_json_command_locked(
    control_write_lock: &ControlWriteLock,
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    let _write_guard = control_write_lock.lock().await;
    write_chunked_json_command(peripheral, characteristic, payload).await
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
