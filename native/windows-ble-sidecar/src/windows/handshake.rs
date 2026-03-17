use anyhow::{Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _, WriteType},
    platform::Peripheral,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, Duration};

const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
const CONTROL_CHUNK_SIZE: usize = 120;
const COMMAND_WRITE_ATTEMPTS: u32 = 3;
const COMMAND_WRITE_RETRY_DELAY_MS: u64 = 200;

#[derive(Clone)]
pub(crate) struct ControlWriteLock {
    lock: Arc<Mutex<()>>,
    high_priority_waiters: Arc<AtomicUsize>,
    high_priority_notify: Arc<Notify>,
}

#[derive(Clone, Copy)]
enum ControlWritePriority {
    High,
    Normal,
}

#[derive(Clone, Copy)]
enum ControlWriteRetryMode {
    Standard,
    SingleAttempt,
}

pub(crate) fn new_control_write_lock() -> ControlWriteLock {
    ControlWriteLock {
        lock: Arc::new(Mutex::new(())),
        high_priority_waiters: Arc::new(AtomicUsize::new(0)),
        high_priority_notify: Arc::new(Notify::new()),
    }
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
    write_chunked_json_command_locked_with_priority(
        control_write_lock,
        peripheral,
        characteristic,
        &payload,
        ControlWritePriority::High,
        ControlWriteRetryMode::Standard,
    )
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
    write_chunked_json_command_locked_with_priority(
        control_write_lock,
        peripheral,
        characteristic,
        &payload,
        ControlWritePriority::High,
        ControlWriteRetryMode::Standard,
    )
    .await
}

pub(crate) async fn write_chunked_json_command(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    write_chunked_json_command_with_retry_mode(
        peripheral,
        characteristic,
        payload,
        ControlWriteRetryMode::Standard,
    )
    .await
}

async fn write_chunked_json_command_with_retry_mode(
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
    retry_mode: ControlWriteRetryMode,
) -> Result<()> {
    let frames = control_command_frames(payload);
    let attempt_limit = match retry_mode {
        ControlWriteRetryMode::Standard => COMMAND_WRITE_ATTEMPTS,
        ControlWriteRetryMode::SingleAttempt => 1,
    };

    for attempt in 1..=attempt_limit {
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
            if attempt == attempt_limit {
                let message = if attempt_limit == 1 {
                    "chunked control write failed without retry".to_string()
                } else {
                    format!("chunked control write failed after {attempt_limit} attempts")
                };
                return Err(error).with_context(|| message);
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
    write_chunked_json_command_locked_with_priority(
        control_write_lock,
        peripheral,
        characteristic,
        payload,
        ControlWritePriority::Normal,
        ControlWriteRetryMode::Standard,
    )
    .await
}

pub(crate) async fn write_chunked_json_command_once_locked(
    control_write_lock: &ControlWriteLock,
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
) -> Result<()> {
    write_chunked_json_command_locked_with_priority(
        control_write_lock,
        peripheral,
        characteristic,
        payload,
        ControlWritePriority::Normal,
        ControlWriteRetryMode::SingleAttempt,
    )
    .await
}

async fn write_chunked_json_command_locked_with_priority(
    control_write_lock: &ControlWriteLock,
    peripheral: &Peripheral,
    characteristic: &Characteristic,
    payload: &str,
    priority: ControlWritePriority,
    retry_mode: ControlWriteRetryMode,
) -> Result<()> {
    let _write_guard = acquire_control_write_guard(control_write_lock, priority).await;
    write_chunked_json_command_with_retry_mode(peripheral, characteristic, payload, retry_mode)
        .await
}

async fn acquire_control_write_guard<'a>(
    control_write_lock: &'a ControlWriteLock,
    priority: ControlWritePriority,
) -> tokio::sync::MutexGuard<'a, ()> {
    match priority {
        ControlWritePriority::High => {
            control_write_lock
                .high_priority_waiters
                .fetch_add(1, Ordering::SeqCst);
            let guard = control_write_lock.lock.lock().await;
            control_write_lock
                .high_priority_waiters
                .fetch_sub(1, Ordering::SeqCst);
            if control_write_lock
                .high_priority_waiters
                .load(Ordering::SeqCst)
                == 0
            {
                control_write_lock.high_priority_notify.notify_waiters();
            }
            guard
        }
        ControlWritePriority::Normal => loop {
            if control_write_lock
                .high_priority_waiters
                .load(Ordering::SeqCst)
                == 0
            {
                let guard = control_write_lock.lock.lock().await;
                if control_write_lock
                    .high_priority_waiters
                    .load(Ordering::SeqCst)
                    == 0
                {
                    break guard;
                }
                drop(guard);
            }
            control_write_lock.high_priority_notify.notified().await;
        },
    }
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
