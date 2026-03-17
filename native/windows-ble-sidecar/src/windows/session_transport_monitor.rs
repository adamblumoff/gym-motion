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
        ApprovedNodeRule, DiscoveredNode, Event, ReconnectStatus, RuntimeStatusPayload,
        TelemetryPayload,
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
    session_types::SessionCommand,
    writer::EventWriter,
};

#[derive(Clone, Copy)]
pub(super) struct MonitorSessionConfig {
    pub(super) connection_health_poll_ms: u64,
    pub(super) session_health_ack_timeout_ms: u64,
    pub(super) session_bootstrap_retry_limit: u32,
    pub(super) session_telemetry_confirm_retry_limit: u32,
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
                        match serde_json::from_value::<RuntimeStatusPayload>(payload) {
                            Ok(status) => {
                                if status.status_type != "app-session-online" {
                                    continue;
                                }

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
                                let mut enriched = node.clone();
                                if let Some(device_id) = status.device_id.clone() {
                                    if let Some(peripheral_id) = node.peripheral_id.clone() {
                                        known_device_ids
                                            .write()
                                            .await
                                            .insert(peripheral_id, device_id.clone());
                                    }
                                    enriched.known_device_id = Some(device_id);
                                }
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
                if is_closed_handle_error_message(&reason)
                    && prepared.peripheral.is_connected().await.unwrap_or(false)
                {
                    match recover_active_session_control_path(
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
