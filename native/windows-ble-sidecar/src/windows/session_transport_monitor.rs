use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use btleplug::api::Peripheral as _;
use futures::StreamExt;
use serde_json::json;
use tokio::{
    sync::{mpsc, watch, RwLock},
    time::sleep,
};

use crate::{
    json_decoder::JsonObjectDecoder,
    protocol::{
        ApprovedNodeRule, DiscoveredNode, Event, HistoryRecordStatusPayload,
        HistorySyncCompletePayload, ReconnectStatus, RuntimeStatusPayload, TelemetryPayload,
    },
};

use super::{
    approval::is_approved,
    config::Config,
    handshake::{send_app_session_bootstrap, send_app_session_lease, write_chunked_json_command},
    session_lease::{is_closed_handle_error_message, spawn_lease_task},
    session_transport_monitor_reporting::report_reconnect_completed,
    session_transport_recovery::{emit_handshake_step, recover_active_session_control_path},
    session_transport_setup::PreparedSession,
    session_types::{ActiveSessionCommand, SessionCommand},
    writer::EventWriter,
};

const ACTIVE_SESSION_RECOVERY_ATTEMPTS: u32 = 2;
const ACTIVE_SESSION_RECOVERY_RETRY_DELAY_MS: u64 = 250;

#[derive(Clone, Copy)]
pub(super) struct MonitorSessionConfig {
    pub(super) connection_health_poll_ms: u64,
    pub(super) session_health_ack_timeout_ms: u64,
    pub(super) session_bootstrap_retry_limit: u32,
    pub(super) session_telemetry_confirm_retry_limit: u32,
}

async fn enrich_node_with_device_id(
    node: &DiscoveredNode,
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    device_id: &str,
) -> DiscoveredNode {
    if let Some(peripheral_id) = node.peripheral_id.clone() {
        known_device_ids
            .write()
            .await
            .insert(peripheral_id, device_id.to_string());
    }

    let mut enriched = node.clone();
    enriched.known_device_id = Some(device_id.to_string());
    enriched
}

async fn send_history_sync_begin(
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

    write_chunked_json_command(peripheral, control_characteristic, &payload)
        .await
        .with_context(|| format!("history-sync-begin failed for {}", node.label))
}

async fn send_history_ack(
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

    write_chunked_json_command(peripheral, control_characteristic, &payload)
        .await
        .with_context(|| format!("history-ack failed for {}", node.label))
}

async fn recover_control_path_with_retry(
    peripheral: &btleplug::platform::Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    control_uuid: uuid::Uuid,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<btleplug::api::Characteristic> {
    let mut last_error = None;

    for attempt in 1..=ACTIVE_SESSION_RECOVERY_ATTEMPTS {
        match recover_active_session_control_path(
            peripheral,
            writer,
            node,
            reconnect,
            control_uuid,
            app_session_id,
            app_session_nonce,
        )
        .await
        {
            Ok(control_characteristic) => return Ok(control_characteristic),
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

pub(super) async fn monitor_active_session(
    mut prepared: PreparedSession,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    reconnect: Option<ReconnectStatus>,
    mut session_shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
    mut session_commands: mpsc::UnboundedReceiver<ActiveSessionCommand>,
    app_session_id: String,
    app_session_nonce: String,
    reconnect_started_at: Instant,
    monitor_config: MonitorSessionConfig,
) -> Result<Option<String>> {
    emit_handshake_step(
        &writer,
        config.verbose_logging,
        &node,
        &reconnect,
        "waiting for session health ack",
    )
    .await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));
    let mut status_decoder = JsonObjectDecoder::new(format!("status:{}", node.label));
    let mut session_healthy_reported = false;
    let session_health_deadline =
        Instant::now() + Duration::from_millis(monitor_config.session_health_ack_timeout_ms);
    let session_health_sleep = tokio::time::sleep_until(session_health_deadline.into());
    tokio::pin!(session_health_sleep);
    let mut telemetry_fallback_node: Option<DiscoveredNode> = None;
    let mut ack_session_id: Option<String> = None;
    let mut ack_received = false;
    let mut session_bootstrap_retry_count = 0_u32;
    let mut session_telemetry_confirm_retry_count = 0_u32;
    let mut ack_confirmed_node: Option<DiscoveredNode> = None;
    let mut current_control_characteristic = prepared.control_characteristic;
    let (mut lease_shutdown_tx, mut lease_failure_rx, mut lease_task) = spawn_lease_task(
        prepared.peripheral.clone(),
        current_control_characteristic.clone(),
        app_session_id.clone(),
    );

    loop {
        tokio::select! {
            changed = session_shutdown.changed() => {
                if changed.is_ok() && *session_shutdown.borrow() {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    if prepared.peripheral.is_connected().await.unwrap_or(false) {
                        let _ = writer
                            .send(&Event::Log {
                                level: "info".to_string(),
                                message: format!(
                                    "Disconnecting {} because the Windows BLE runtime is shutting down.",
                                    node.label
                                ),
                                details: Some(json!({
                                    "peripheralId": node.peripheral_id,
                                    "knownDeviceId": node.known_device_id,
                                    "address": node.address,
                                })),
                            })
                            .await;
                        let _ = prepared.peripheral.disconnect().await;
                        sleep(Duration::from_millis(100)).await;
                    }
                    return Ok(None);
                }
            }
            notification = prepared.notifications.next() => {
                let Some(notification) = notification else {
                    break;
                };

                if notification.uuid == config.status_uuid {
                    for payload in status_decoder.push_bytes(&notification.value)? {
                        let payload_clone = payload.clone();

                        match serde_json::from_value::<RuntimeStatusPayload>(payload) {
                            Ok(status) => {
                                match status.status_type.as_str() {
                                    "app-session-online" => {
                                        let Some(session_id) = status.session_id.clone() else {
                                            writer
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: "Ignoring app-session-online status without a session id.".to_string(),
                                                    details: Some(json!({
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                    })),
                                                })
                                                .await?;
                                            continue;
                                        };

                                        if session_id != app_session_id {
                                            continue;
                                        }
                                        let Some(session_nonce) = status.session_nonce.clone() else {
                                            writer
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: "Ignoring app-session-online status without a session nonce.".to_string(),
                                                    details: Some(json!({
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                        "expectedSessionId": app_session_id,
                                                    })),
                                                })
                                                .await?;
                                            continue;
                                        };
                                        if session_nonce != app_session_nonce {
                                            continue;
                                        }
                                        ack_session_id = Some(session_id);
                                        ack_received = true;
                                        let enriched = if let Some(device_id) = status.device_id.clone() {
                                            enrich_node_with_device_id(&node, &known_device_ids, &device_id).await
                                        } else {
                                            node.clone()
                                        };
                                        ack_confirmed_node = Some(enriched.clone());
                                        emit_handshake_step(
                                            &writer,
                                            config.verbose_logging,
                                            &node,
                                            &reconnect,
                                            "sending sync-now",
                                        )
                                        .await?;
                                        if let Err(error) = write_chunked_json_command(
                                            &prepared.peripheral,
                                            &current_control_characteristic,
                                            r#"{"type":"sync-now"}"#,
                                        )
                                        .await
                                        {
                                            writer
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: format!("sync-now step failed for {}", node.label),
                                                    details: Some(json!({
                                                        "peripheralId": enriched.peripheral_id,
                                                        "knownDeviceId": enriched.known_device_id,
                                                        "address": enriched.address,
                                                        "error": format!("{:#}", error),
                                                    })),
                                                })
                                                .await?;
                                        }
                                        session_health_sleep.as_mut().reset(
                                            (Instant::now()
                                                + Duration::from_millis(monitor_config.session_health_ack_timeout_ms))
                                            .into(),
                                        );
                                    }
                                    "history-record" => {
                                        match serde_json::from_value::<HistoryRecordStatusPayload>(payload_clone) {
                                            Ok(history_record) => {
                                                let enriched = enrich_node_with_device_id(
                                                    &node,
                                                    &known_device_ids,
                                                    &history_record.device_id,
                                                )
                                                .await;
                                                writer
                                                    .send(&Event::HistoryRecord {
                                                        node: enriched,
                                                        device_id: history_record.device_id,
                                                        record: history_record.record,
                                                    })
                                                    .await?;
                                            }
                                            Err(error) => {
                                                writer
                                                    .error(
                                                        format!("Failed to parse history record payload: {error}"),
                                                        Some(json!({ "node": node.id })),
                                                    )
                                                    .await;
                                            }
                                        }
                                    }
                                    "history-sync-complete" => {
                                        match serde_json::from_value::<HistorySyncCompletePayload>(payload_clone) {
                                            Ok(history_complete) => {
                                                let enriched = enrich_node_with_device_id(
                                                    &node,
                                                    &known_device_ids,
                                                    &history_complete.device_id,
                                                )
                                                .await;
                                                writer
                                                    .send(&Event::HistorySyncComplete {
                                                        node: enriched,
                                                        payload: history_complete,
                                                    })
                                                    .await?;
                                            }
                                            Err(error) => {
                                                writer
                                                    .error(
                                                        format!("Failed to parse history sync completion payload: {error}"),
                                                        Some(json!({ "node": node.id })),
                                                    )
                                                    .await;
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            Err(error) => {
                                writer
                                    .error(
                                        format!("Failed to parse runtime status payload: {error}"),
                                        Some(json!({ "node": node.id })),
                                    )
                                    .await;
                            }
                        }
                    }
                    continue;
                }

                if notification.uuid != config.telemetry_uuid {
                    continue;
                }

                for payload in decoder.push_bytes(&notification.value)? {
                    match serde_json::from_value::<TelemetryPayload>(payload) {
                        Ok(payload) => {
                            if let Some(peripheral_id) = node.peripheral_id.clone() {
                                known_device_ids
                                    .write()
                                    .await
                                    .insert(peripheral_id, payload.device_id.clone());
                            }
                            let mut enriched = node.clone();
                            enriched.known_device_id = Some(payload.device_id.clone());
                            if telemetry_fallback_node.is_none() {
                                telemetry_fallback_node = Some(enriched.clone());
                            }
                            writer
                                .send(&Event::Telemetry {
                                    node: enriched,
                                    payload,
                                })
                                .await?;
                            if ack_received && !session_healthy_reported {
                                session_healthy_reported = true;
                                let completed_node = ack_confirmed_node
                                    .clone()
                                    .or_else(|| telemetry_fallback_node.clone())
                                    .unwrap_or_else(|| node.clone());
                                report_reconnect_completed(
                                    &writer,
                                    &command_sender,
                                    &completed_node,
                                    &reconnect,
                                    prepared.transport_ready_at,
                                    prepared.gatt_ready_at,
                                    reconnect_started_at,
                                    false,
                                )
                                .await?;
                            }
                        }
                        Err(error) => {
                            writer
                                .error(
                                    format!("Failed to parse telemetry payload: {error}"),
                                    Some(json!({ "node": node.id })),
                                )
                                .await;
                        }
                    }
                }
            }
            Some(command) = session_commands.recv() => {
                match command {
                    ActiveSessionCommand::StartHistorySync {
                        after_sequence,
                        max_records,
                    } => {
                        if !session_healthy_reported {
                            writer
                                .send(&Event::Log {
                                    level: "warn".to_string(),
                                    message: "Ignoring history sync request until the active session is healthy.".to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": ack_confirmed_node
                                            .as_ref()
                                            .and_then(|current| current.known_device_id.clone())
                                            .or_else(|| node.known_device_id.clone()),
                                        "address": node.address,
                                        "afterSequence": after_sequence,
                                        "maxRecords": max_records,
                                    })),
                                })
                                .await?;
                            continue;
                        }

                        let known_device_id = ack_confirmed_node
                            .as_ref()
                            .and_then(|current| current.known_device_id.clone())
                            .or_else(|| node.known_device_id.clone());

                        if let Err(error) = send_history_sync_begin(
                            &prepared.peripheral,
                            &current_control_characteristic,
                            &node,
                            after_sequence,
                            max_records,
                        )
                        .await
                        {
                            let error_message = format!("{:#}", error);
                            let mut handled = false;

                            if is_closed_handle_error_message(&error_message) {
                                match recover_control_path_with_retry(
                                    &prepared.peripheral,
                                    &writer,
                                    &node,
                                    &reconnect,
                                    config.control_uuid,
                                    &app_session_id,
                                    &app_session_nonce,
                                )
                                .await
                                {
                                    Ok(recovered_control_characteristic) => {
                                        let _ = lease_shutdown_tx.send(true);
                                        let _ = lease_task.await;
                                        current_control_characteristic =
                                            recovered_control_characteristic;
                                        let (new_shutdown_tx, new_failure_rx, new_lease_task) = spawn_lease_task(
                                            prepared.peripheral.clone(),
                                            current_control_characteristic.clone(),
                                            app_session_id.clone(),
                                        );
                                        lease_shutdown_tx = new_shutdown_tx;
                                        lease_failure_rx = new_failure_rx;
                                        lease_task = new_lease_task;

                                        writer
                                            .send(&Event::Log {
                                                level: "warn".to_string(),
                                                message: "History replay start failed, but the runtime control path recovered; leaving the session online and pausing replay until a manual retry.".to_string(),
                                                details: Some(json!({
                                                    "peripheralId": node.peripheral_id,
                                                    "knownDeviceId": known_device_id,
                                                    "address": node.address,
                                                    "afterSequence": after_sequence,
                                                    "maxRecords": max_records,
                                                    "error": error_message,
                                                })),
                                            })
                                            .await?;
                                        handled = true;
                                    }
                                    Err(recovery_error) => {
                                        writer
                                            .send(&Event::Log {
                                                level: "warn".to_string(),
                                                message: "History replay start failed and control-path recovery did not succeed; leaving the session online and deferring replay.".to_string(),
                                                details: Some(json!({
                                                    "peripheralId": node.peripheral_id,
                                                    "knownDeviceId": known_device_id,
                                                    "address": node.address,
                                                    "afterSequence": after_sequence,
                                                    "maxRecords": max_records,
                                                    "error": error_message,
                                                    "recoveryError": format!("{:#}", recovery_error),
                                                })),
                                            })
                                            .await?;
                                        handled = true;
                                    }
                                }
                            }

                            if !handled {
                                writer
                                    .send(&Event::Log {
                                        level: "warn".to_string(),
                                        message: "History replay start failed; leaving the session online and deferring replay.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": known_device_id,
                                            "address": node.address,
                                            "afterSequence": after_sequence,
                                            "maxRecords": max_records,
                                            "error": error_message,
                                        })),
                                    })
                                    .await?;
                            }
                        }
                    }
                    ActiveSessionCommand::AckHistorySync { sequence } => {
                        let known_device_id = ack_confirmed_node
                            .as_ref()
                            .and_then(|current| current.known_device_id.clone())
                            .or_else(|| node.known_device_id.clone());

                        if let Err(error) = send_history_ack(
                            &prepared.peripheral,
                            &current_control_characteristic,
                            &node,
                            sequence,
                        )
                        .await
                        {
                            let error_message = format!("{:#}", error);
                            let mut handled = false;

                            if is_closed_handle_error_message(&error_message) {
                                match recover_control_path_with_retry(
                                    &prepared.peripheral,
                                    &writer,
                                    &node,
                                    &reconnect,
                                    config.control_uuid,
                                    &app_session_id,
                                    &app_session_nonce,
                                )
                                .await
                                {
                                    Ok(recovered_control_characteristic) => {
                                        let _ = lease_shutdown_tx.send(true);
                                        let _ = lease_task.await;
                                        current_control_characteristic =
                                            recovered_control_characteristic;
                                        let (new_shutdown_tx, new_failure_rx, new_lease_task) = spawn_lease_task(
                                            prepared.peripheral.clone(),
                                            current_control_characteristic.clone(),
                                            app_session_id.clone(),
                                        );
                                        lease_shutdown_tx = new_shutdown_tx;
                                        lease_failure_rx = new_failure_rx;
                                        lease_task = new_lease_task;

                                        writer
                                            .send(&Event::Log {
                                                level: "warn".to_string(),
                                                message: "History replay ack failed, but the runtime control path recovered; leaving the session online and pausing replay until a manual retry.".to_string(),
                                                details: Some(json!({
                                                    "peripheralId": node.peripheral_id,
                                                    "knownDeviceId": known_device_id,
                                                    "address": node.address,
                                                    "sequence": sequence,
                                                    "error": error_message,
                                                })),
                                            })
                                            .await?;
                                        handled = true;
                                    }
                                    Err(recovery_error) => {
                                        writer
                                            .send(&Event::Log {
                                                level: "warn".to_string(),
                                                message: "History replay ack failed and control-path recovery did not succeed; leaving the session online and retrying on a later reconnect.".to_string(),
                                                details: Some(json!({
                                                    "peripheralId": node.peripheral_id,
                                                    "knownDeviceId": known_device_id,
                                                    "address": node.address,
                                                    "sequence": sequence,
                                                    "error": error_message,
                                                    "recoveryError": format!("{:#}", recovery_error),
                                                })),
                                            })
                                            .await?;
                                        handled = true;
                                    }
                                }
                            }

                            if !handled {
                                writer
                                    .send(&Event::Log {
                                        level: "warn".to_string(),
                                        message: "History replay ack failed; leaving the session online and retrying on a later reconnect.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": known_device_id,
                                            "address": node.address,
                                            "sequence": sequence,
                                            "error": error_message,
                                        })),
                                    })
                                    .await?;
                            }
                        }
                    }
                }
            }
            _ = &mut session_health_sleep, if !session_healthy_reported => {
                if ack_received {
                    if session_telemetry_confirm_retry_count
                        < monitor_config.session_telemetry_confirm_retry_limit
                        && prepared.peripheral.is_connected().await.unwrap_or(false)
                    {
                        session_telemetry_confirm_retry_count =
                            session_telemetry_confirm_retry_count.saturating_add(1);
                        writer
                            .send(&Event::Log {
                                level: "warn".to_string(),
                                message: "App-session-online arrived but telemetry confirmation did not; retrying sync-now on the same connection.".to_string(),
                                details: Some(json!({
                                    "peripheralId": node.peripheral_id,
                                    "knownDeviceId": node.known_device_id,
                                    "address": node.address,
                                    "expectedSessionId": app_session_id,
                                    "retryCount": session_telemetry_confirm_retry_count,
                                    "retryLimit": monitor_config.session_telemetry_confirm_retry_limit,
                                    "timeoutMs": monitor_config.session_health_ack_timeout_ms,
                                })),
                            })
                            .await?;
                        write_chunked_json_command(
                            &prepared.peripheral,
                            &current_control_characteristic,
                            r#"{"type":"sync-now"}"#,
                        )
                        .await
                        .with_context(|| format!("sync-now retry failed for {}", node.label))?;
                        session_health_sleep.as_mut().reset(
                            (Instant::now()
                                + Duration::from_millis(monitor_config.session_health_ack_timeout_ms))
                            .into(),
                        );
                        continue;
                    }

                    return Err(anyhow!(
                        "session confirmation telemetry did not arrive for {}",
                        node.label
                    ));
                }

                if session_bootstrap_retry_count < monitor_config.session_bootstrap_retry_limit
                    && prepared.peripheral.is_connected().await.unwrap_or(false)
                {
                    session_bootstrap_retry_count =
                        session_bootstrap_retry_count.saturating_add(1);
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: "Session health ack did not arrive yet; retrying app-session bootstrap on the same connection.".to_string(),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "expectedSessionId": app_session_id,
                                "retryCount": session_bootstrap_retry_count,
                                "retryLimit": monitor_config.session_bootstrap_retry_limit,
                                "timeoutMs": monitor_config.session_health_ack_timeout_ms,
                            })),
                        })
                        .await?;
                    send_app_session_bootstrap(
                        &prepared.peripheral,
                        &current_control_characteristic,
                        &app_session_nonce,
                    )
                    .await
                    .with_context(|| {
                        format!("app-session-bootstrap retry failed for {}", node.label)
                    })?;
                    send_app_session_lease(
                        &prepared.peripheral,
                        &current_control_characteristic,
                        &app_session_id,
                    )
                    .await
                    .with_context(|| format!("app-session-lease retry failed for {}", node.label))?;
                    session_health_sleep.as_mut().reset(
                        (Instant::now()
                            + Duration::from_millis(monitor_config.session_health_ack_timeout_ms))
                        .into(),
                    );
                    continue;
                }

                let Some(enriched) = telemetry_fallback_node.clone() else {
                    continue;
                };

                session_healthy_reported = true;
                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: "Session health ack did not arrive before timeout; using telemetry fallback.".to_string(),
                        details: Some(json!({
                            "peripheralId": enriched.peripheral_id,
                            "knownDeviceId": enriched.known_device_id,
                            "address": enriched.address,
                            "expectedSessionId": app_session_id,
                            "ackSessionId": ack_session_id,
                            "timeoutMs": monitor_config.session_health_ack_timeout_ms,
                        })),
                    })
                    .await?;
                report_reconnect_completed(
                    &writer,
                    &command_sender,
                    &enriched,
                    &reconnect,
                    prepared.transport_ready_at,
                    prepared.gatt_ready_at,
                    reconnect_started_at,
                    true,
                )
                .await?;
            }
            _ = sleep(Duration::from_millis(monitor_config.connection_health_poll_ms)) => {
                if !is_approved(&node, &allowed_nodes.read().await) {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    if prepared.peripheral.is_connected().await.unwrap_or(false) {
                        let _ = prepared.peripheral.disconnect().await;
                    }
                    return Ok(Some(format!("{} was removed from allowed nodes.", node.label)));
                }
                if !prepared.peripheral.is_connected().await.unwrap_or(false) {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    return Ok(Some(format!("BLE transport ended for {}.", node.label)));
                }
            }
            Some(reason) = lease_failure_rx.recv() => {
                let _ = lease_shutdown_tx.send(true);
                let _ = lease_task.await;
                if is_closed_handle_error_message(&reason) {
                    match recover_control_path_with_retry(
                        &prepared.peripheral,
                        &writer,
                        &node,
                        &reconnect,
                        config.control_uuid,
                        &app_session_id,
                        &app_session_nonce,
                    )
                    .await
                    {
                        Ok(recovered_control_characteristic) => {
                            current_control_characteristic = recovered_control_characteristic;
                            let (new_shutdown_tx, new_failure_rx, new_lease_task) = spawn_lease_task(
                                prepared.peripheral.clone(),
                                current_control_characteristic.clone(),
                                app_session_id.clone(),
                            );
                            lease_shutdown_tx = new_shutdown_tx;
                            lease_failure_rx = new_failure_rx;
                            lease_task = new_lease_task;
                            continue;
                        }
                        Err(error) => {
                            writer
                                .send(&Event::Log {
                                    level: "warn".to_string(),
                                    message: "Active session control-path recovery failed; falling back to reconnect scan.".to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": node.known_device_id,
                                        "address": node.address,
                                        "reconnect": reconnect,
                                        "error": format!("{:#}", error),
                                    })),
                                })
                                .await?;
                        }
                    }
                }
                return Ok(Some(format!(
                    "App-session lease heartbeat failed for {}: {}",
                    node.label,
                    reason,
                )));
            }
        }
    }

    let _ = lease_shutdown_tx.send(true);
    let _ = lease_task.await;

    if prepared.peripheral.is_connected().await.unwrap_or(false) {
        let _ = prepared.peripheral.disconnect().await;
        sleep(Duration::from_millis(100)).await;
    }

    Ok(None)
}
