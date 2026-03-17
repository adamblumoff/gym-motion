use std::time::Duration;

use anyhow::{Context, Result};
use btleplug::api::Peripheral as _;
use serde_json::json;
use tokio::time::sleep;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{
    config::Config,
    handshake::{write_chunked_json_command_locked, ControlWriteLock},
    session_transport_recovery::recover_active_session_io,
    writer::EventWriter,
};

const ACTIVE_SESSION_RECOVERY_ATTEMPTS: u32 = 2;
const ACTIVE_SESSION_RECOVERY_RETRY_DELAY_MS: u64 = 250;

pub(super) async fn send_history_sync_begin(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    control_characteristic: &btleplug::api::Characteristic,
    node: &DiscoveredNode,
    after_sequence: u64,
    max_records: usize,
) -> Result<()> {
    let payload = json!({
        "type": "history-sync-begin",
        "afterSequence": after_sequence,
        "maxRecords": max_records,
    })
    .to_string();

    write_chunked_json_command_locked(
        control_write_lock,
        peripheral,
        control_characteristic,
        &payload,
    )
    .await
    .with_context(|| format!("history-sync-begin failed for {}", node.label))
}

pub(super) async fn send_history_ack(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    control_characteristic: &btleplug::api::Characteristic,
    node: &DiscoveredNode,
    sequence: u64,
) -> Result<()> {
    let payload = json!({
        "type": "history-ack",
        "sequence": sequence,
    })
    .to_string();

    write_chunked_json_command_locked(
        control_write_lock,
        peripheral,
        control_characteristic,
        &payload,
    )
    .await
    .with_context(|| format!("history-ack failed for {}", node.label))
}

pub(super) async fn recover_control_path_with_retry(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    config: &Config,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<btleplug::api::Characteristic> {
    let mut last_error = None;

    for attempt in 1..=ACTIVE_SESSION_RECOVERY_ATTEMPTS {
        match recover_active_session_io(
            control_write_lock,
            peripheral,
            writer,
            node,
            reconnect,
            config,
            app_session_id,
            app_session_nonce,
        )
        .await
        {
            Ok(recovered_io) => return Ok(recovered_io.control_characteristic),
            Err(error) => {
                last_error = Some(error);

                if attempt < ACTIVE_SESSION_RECOVERY_ATTEMPTS {
                    sleep(Duration::from_millis(
                        ACTIVE_SESSION_RECOVERY_RETRY_DELAY_MS,
                    ))
                    .await;
                }
            }
        }
    }

    Err(last_error.expect("active session recovery should retain the last error"))
}

pub(super) async fn force_reconnect_after_recovery_failure(
    peripheral: &btleplug::platform::Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    reason: &str,
) -> Result<String> {
    if peripheral.is_connected().await.unwrap_or(false) {
        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: format!(
                    "Disconnecting {} so the next reconnect attempt can rebuild the WinRT GATT session cleanly.",
                    node.label
                ),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                })),
            })
            .await?;
        let _ = peripheral.disconnect().await;
        sleep(Duration::from_millis(100)).await;
    }

    Ok(reason.to_string())
}
