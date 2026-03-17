use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use btleplug::api::Peripheral as _;
use btleplug::platform::Peripheral;
use serde_json::json;
use tokio::{
    sync::{mpsc, watch, RwLock},
    time::sleep,
};
use uuid::Uuid;

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
    session_types::SessionCommand,
    session_util::{emit_verbose_log, format_error_chain, is_retryable_pre_session_setup_error},
    writer::EventWriter,
};

const CONNECTION_HEALTH_POLL_MS: u64 = 2_000;
pub(super) const APP_SESSION_HEARTBEAT_MS: u64 = 5_000;
const SESSION_HEALTH_ACK_TIMEOUT_MS: u64 = 1_000;
const GATT_SETUP_RETRY_ATTEMPTS: u32 = 2;
const GATT_SETUP_RETRY_DELAY_MS: u64 = 300;
const SERVICE_DISCOVERY_RETRY_ATTEMPTS: u32 = 2;
const PRE_SESSION_SETUP_RETRY_DELAY_MS: u64 = 750;
const PRE_SESSION_SETUP_ATTEMPTS: u32 = 3;
const SESSION_BOOTSTRAP_RETRY_LIMIT: u32 = 1;
const SESSION_TELEMETRY_CONFIRM_RETRY_LIMIT: u32 = 1;
const POST_GATT_READY_SETTLE_MS: u64 = 250;
const COLD_BOOT_READY_UPTIME_MS: u64 = 8_000;
const COLD_BOOT_READY_MAX_WAIT_MS: u64 = 5_000;

async fn wait_for_cold_boot_ready_window(
    peripheral: &Peripheral,
    status_characteristic: &btleplug::api::Characteristic,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
) -> Result<()> {
    let Ok(raw_status) = peripheral.read(status_characteristic).await else {
        return Ok(());
    };
    let Ok(raw_text) = String::from_utf8(raw_status) else {
        return Ok(());
    };
    let Ok(status) = serde_json::from_str::<RuntimeStatusPayload>(&raw_text) else {
        return Ok(());
    };

    if status.status_type != "ready" {
        return Ok(());
    }

    let Some(boot_uptime_ms) = status.boot_uptime_ms else {
        return Ok(());
    };
    if boot_uptime_ms >= COLD_BOOT_READY_UPTIME_MS {
        return Ok(());
    }

    let wait_ms = (COLD_BOOT_READY_UPTIME_MS - boot_uptime_ms).min(COLD_BOOT_READY_MAX_WAIT_MS);
    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: format!(
                "Fresh node boot detected for {}; waiting briefly before runtime bootstrap.",
                node.label
            ),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
                "bootId": status.boot_id,
                "bootUptimeMs": boot_uptime_ms,
                "waitMs": wait_ms,
            })),
        })
        .await?;
    sleep(Duration::from_millis(wait_ms)).await;
    Ok(())
}

async fn recover_active_session_control_path(
    peripheral: &Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    control_uuid: uuid::Uuid,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<btleplug::api::Characteristic> {
    writer
        .send(&Event::Log {
            level: "warn".to_string(),
            message: "WinRT closed the runtime control handle after connect; refreshing services and replaying the app-session handshake on the same connection.".to_string(),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
            })),
        })
        .await?;

    peripheral.discover_services().await.with_context(|| {
        format!(
            "refresh services for active session recovery failed for {}",
            node.label
        )
    })?;

    let control_characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|candidate| candidate.uuid == control_uuid)
        .ok_or_else(|| {
            anyhow!("runtime control characteristic not found during active session recovery")
        })?;

    send_app_session_bootstrap(peripheral, &control_characteristic, app_session_nonce)
        .await
        .with_context(|| {
            format!(
                "active session bootstrap recovery failed for {}",
                node.label
            )
        })?;
    send_app_session_lease(peripheral, &control_characteristic, app_session_id)
        .await
        .with_context(|| format!("active session lease recovery failed for {}", node.label))?;
    let _ = write_chunked_json_command(
        peripheral,
        &control_characteristic,
        r#"{"type":"sync-now"}"#,
    )
    .await;

    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: format!(
                "Recovered runtime control path for {} without restarting reconnect scan.",
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

    Ok(control_characteristic)
}

pub(super) async fn connect_and_stream(
    peripheral: Peripheral,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    reconnect: Option<ReconnectStatus>,
    mut session_shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
) -> Result<Option<String>> {
    let app_session_id = Uuid::new_v4().to_string();
    let app_session_nonce = Uuid::new_v4().to_string();
    let reconnect_started_at = Instant::now();
    let mut transport_ready_at: Option<Instant> = None;
    let mut gatt_ready_at: Option<Instant> = None;
    let handshake_details = || {
        json!({
            "peripheralId": node.peripheral_id,
            "knownDeviceId": node.known_device_id,
            "address": node.address,
            "reconnect": reconnect,
        })
    };
    let log_handshake_step = |step: &str| {
        (
            format!("Reconnect handshake step: {step}"),
            Some(handshake_details()),
        )
    };

    if !is_approved(&node, &allowed_nodes.read().await) {
        return Ok(None);
    }

    writer
        .send(&Event::NodeConnectionState {
            node: node.clone(),
            gateway_connection_state: "connecting".to_string(),
            reason: None,
            reconnect: reconnect.clone(),
        })
        .await?;

    let mut gatt_ready = false;
    let mut last_gatt_error = None;
    let active_peripheral = peripheral;

    for attempt in 1..=GATT_SETUP_RETRY_ATTEMPTS {
        emit_verbose_log(
            &writer,
            config.verbose_logging,
            format!("Reconnect handshake GATT setup attempt {attempt}/{GATT_SETUP_RETRY_ATTEMPTS}"),
            Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
            })),
        )
        .await?;

        let (message, details) = log_handshake_step("checking transport connection");
        emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
        let was_connected = active_peripheral.is_connected().await.unwrap_or(false);
        if !was_connected {
            let (message, details) = log_handshake_step("calling peripheral.connect()");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            if let Err(error) = active_peripheral.connect().await {
                let formatted_error = error.to_string();
                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message:
                            "WinRT connect() returned an error; re-checking transport before giving up."
                                .to_string(),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "reconnect": reconnect,
                            "attempt": attempt,
                            "error": formatted_error,
                        })),
                    })
                    .await?;
                let connect_error =
                    anyhow!(error).context(format!("connect step failed for {}", node.label));
                if active_peripheral.is_connected().await.unwrap_or(false) {
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: "WinRT reported a transient BLE transport after connect() failed; disconnecting before retry.".to_string(),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "reconnect": reconnect,
                                "attempt": attempt,
                            })),
                        })
                        .await?;
                    let _ = active_peripheral.disconnect().await;
                    sleep(Duration::from_millis(100)).await;
                }
                last_gatt_error = Some(connect_error);
                if attempt == GATT_SETUP_RETRY_ATTEMPTS {
                    return Err(last_gatt_error
                        .take()
                        .unwrap_or_else(|| anyhow!("connect step failed for {}", node.label)));
                }
                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: format!(
                            "Reconnect handshake GATT setup attempt {attempt} failed before transport became connected; retrying."
                        ),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "reconnect": reconnect,
                            "error": last_gatt_error
                                .as_ref()
                                .map(format_error_chain),
                        })),
                    })
                    .await?;
                sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
                continue;
            }
            sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
        }

        let connected_after_attempt = active_peripheral.is_connected().await.unwrap_or(false);
        if !connected_after_attempt {
            let Some(error) = last_gatt_error.take() else {
                last_gatt_error = Some(anyhow!(
                    "transport still disconnected for {} after connect attempt",
                    node.label
                ));
                continue;
            };

            if attempt == GATT_SETUP_RETRY_ATTEMPTS {
                return Err(error);
            }

            writer
                .send(&Event::Log {
                    level: "warn".to_string(),
                    message: format!(
                        "Reconnect handshake GATT setup attempt {attempt} failed before transport became connected; retrying."
                    ),
                    details: Some(json!({
                        "peripheralId": node.peripheral_id,
                        "knownDeviceId": node.known_device_id,
                        "address": node.address,
                        "reconnect": reconnect,
                        "error": format_error_chain(&error),
                    })),
                })
                .await?;
            sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
            continue;
        }
        transport_ready_at.get_or_insert_with(Instant::now);

        for discovery_attempt in 1..=SERVICE_DISCOVERY_RETRY_ATTEMPTS {
            let (message, details) = log_handshake_step("discovering services");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            match active_peripheral.discover_services().await {
                Ok(()) => {
                    gatt_ready = true;
                    gatt_ready_at.get_or_insert_with(Instant::now);
                    last_gatt_error = None;
                    break;
                }
                Err(error) => {
                    let formatted_error = format!("{:#}", error);
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: format!(
                                "discover_services attempt {discovery_attempt}/{SERVICE_DISCOVERY_RETRY_ATTEMPTS} failed; waiting before retry."
                            ),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "reconnect": reconnect,
                                "error": formatted_error,
                            })),
                        })
                        .await?;
                    last_gatt_error = Some(
                        anyhow!(error)
                            .context(format!("discover_services step failed for {}", node.label)),
                    );
                    if discovery_attempt < SERVICE_DISCOVERY_RETRY_ATTEMPTS {
                        sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
                    }
                }
            }
        }

        if gatt_ready {
            break;
        }

        let Some(error) = last_gatt_error.take() else {
            continue;
        };
        if attempt == GATT_SETUP_RETRY_ATTEMPTS {
            return Err(error);
        }

        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: format!(
                    "Reconnect handshake GATT setup attempt {attempt} failed after transport connect; retrying."
                ),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                    "error": format_error_chain(&error),
                })),
            })
            .await?;

        if active_peripheral.is_connected().await.unwrap_or(false) {
            let _ = active_peripheral.disconnect().await;
            sleep(Duration::from_millis(100)).await;
        }
        sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
    }

    if !gatt_ready {
        return Err(anyhow!("gatt setup never became ready for {}", node.label));
    }

    let peripheral = active_peripheral;
    sleep(Duration::from_millis(POST_GATT_READY_SETTLE_MS)).await;
    let mut setup_result = Err(anyhow!("pre-session setup did not run"));
    for setup_attempt in 1..=PRE_SESSION_SETUP_ATTEMPTS {
        setup_result = async {
            let (message, details) = log_handshake_step("resolving telemetry characteristic");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            let characteristic = peripheral
                .characteristics()
                .into_iter()
                .find(|candidate| candidate.uuid == config.telemetry_uuid)
                .ok_or_else(|| anyhow!("telemetry characteristic not found"))?;
            let (message, details) = log_handshake_step("resolving control characteristic");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            let control_characteristic = peripheral
                .characteristics()
                .into_iter()
                .find(|candidate| candidate.uuid == config.control_uuid)
                .ok_or_else(|| anyhow!("runtime control characteristic not found"))?;
            let (message, details) = log_handshake_step("resolving runtime status characteristic");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            let status_characteristic = peripheral
                .characteristics()
                .into_iter()
                .find(|candidate| candidate.uuid == config.status_uuid)
                .ok_or_else(|| anyhow!("runtime status characteristic not found"))?;
            wait_for_cold_boot_ready_window(
                &peripheral,
                &status_characteristic,
                &writer,
                &node,
                &reconnect,
            )
            .await?;

            let (message, details) = log_handshake_step("opening notifications stream");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            let notifications = peripheral
                .notifications()
                .await
                .with_context(|| format!("notifications step failed for {}", node.label))?;
            let (message, details) = log_handshake_step("subscribing to runtime status");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            peripheral
                .subscribe(&status_characteristic)
                .await
                .with_context(|| format!("status subscribe step failed for {}", node.label))?;
            let (message, details) = log_handshake_step("subscribing to telemetry");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            peripheral
                .subscribe(&characteristic)
                .await
                .with_context(|| format!("subscribe step failed for {}", node.label))?;
            let (message, details) = log_handshake_step("sending app-session bootstrap");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            send_app_session_bootstrap(&peripheral, &control_characteristic, &app_session_nonce)
                .await
                .with_context(|| format!("app-session-bootstrap step failed for {}", node.label))?;
            let (message, details) = log_handshake_step("sending app-session lease");
            emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
            send_app_session_lease(&peripheral, &control_characteristic, &app_session_id)
                .await
                .with_context(|| format!("app-session-lease step failed for {}", node.label))?;

            Ok::<_, anyhow::Error>((notifications, control_characteristic))
        }
        .await;

        let Err(error) = &setup_result else {
            break;
        };

        if setup_attempt == PRE_SESSION_SETUP_ATTEMPTS
            || !is_retryable_pre_session_setup_error(error)
            || !peripheral.is_connected().await.unwrap_or(false)
        {
            break;
        }

        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: "Runtime pre-session setup hit a transient WinRT handle failure; refreshing services and retrying on the same connection.".to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                    "setupAttempt": setup_attempt,
                    "setupAttemptLimit": PRE_SESSION_SETUP_ATTEMPTS,
                    "error": format_error_chain(error),
                })),
            })
            .await?;
        sleep(Duration::from_millis(PRE_SESSION_SETUP_RETRY_DELAY_MS)).await;
        peripheral
            .discover_services()
            .await
            .with_context(|| format!("refresh services before retry failed for {}", node.label))?;
    }

    let (mut notifications, control_characteristic) = match setup_result {
        Ok(result) => result,
        Err(error) => {
            if peripheral.is_connected().await.unwrap_or(false) {
                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: "Reconnect handshake failed before session health; disconnecting stale BLE client.".to_string(),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "reconnect": reconnect,
                            "error": format_error_chain(&error),
                        })),
                    })
                    .await?;
                let _ = peripheral.disconnect().await;
                sleep(Duration::from_millis(100)).await;
            }
            return Err(error);
        }
    };

    let (message, details) = log_handshake_step("waiting for session health ack");
    emit_verbose_log(&writer, config.verbose_logging, message, details).await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));
    let mut status_decoder = JsonObjectDecoder::new(format!("status:{}", node.label));
    let mut session_healthy_reported = false;
    let session_health_deadline =
        Instant::now() + Duration::from_millis(SESSION_HEALTH_ACK_TIMEOUT_MS);
    let session_health_sleep = tokio::time::sleep_until(session_health_deadline.into());
    tokio::pin!(session_health_sleep);
    let mut telemetry_fallback_node: Option<DiscoveredNode> = None;
    let mut ack_session_id: Option<String> = None;
    let mut ack_received = false;
    let mut session_bootstrap_retry_count = 0_u32;
    let mut session_telemetry_confirm_retry_count = 0_u32;
    let mut ack_confirmed_node: Option<DiscoveredNode> = None;
    let mut current_control_characteristic = control_characteristic;
    let (mut lease_shutdown_tx, mut lease_failure_rx, mut lease_task) = spawn_lease_task(
        peripheral.clone(),
        current_control_characteristic.clone(),
        app_session_id.clone(),
    );

    loop {
        tokio::select! {
            changed = session_shutdown.changed() => {
                if changed.is_ok() && *session_shutdown.borrow() {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    if peripheral.is_connected().await.unwrap_or(false) {
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
                        let _ = peripheral.disconnect().await;
                        sleep(Duration::from_millis(100)).await;
                    }
                    return Ok(None);
                }
            }
            notification = notifications.next() => {
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
                                let (message, details) = log_handshake_step("sending sync-now");
                                emit_verbose_log(&writer, config.verbose_logging, message, details)
                                    .await?;
                                if let Err(error) = write_chunked_json_command(
                                    &peripheral,
                                    &current_control_characteristic,
                                    r#"{"type":"sync-now"}"#,
                                )
                                .await
                                {
                                    writer
                                        .send(&Event::Log {
                                            level: "warn".to_string(),
                                            message: format!(
                                                "sync-now step failed for {}",
                                                node.label
                                            ),
                                            details: Some(json!({
                                                "peripheralId": enriched.peripheral_id,
                                                "knownDeviceId": enriched.known_device_id,
                                                "address": enriched.address,
                                                "error": format!("{:#}", error),
                                            })),
                                        })
                                        .await?;
                                }
                                session_health_sleep
                                    .as_mut()
                                    .reset((Instant::now()
                                        + Duration::from_millis(SESSION_HEALTH_ACK_TIMEOUT_MS))
                                        .into());
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
                                let _ = command_sender.send(SessionCommand::ConnectionHealthy {
                                    node: completed_node.clone(),
                                });
                                writer
                                    .send(&Event::NodeConnectionState {
                                        node: completed_node.clone(),
                                        gateway_connection_state: "connected".to_string(),
                                        reason: None,
                                        reconnect: reconnect.clone(),
                                    })
                                    .await?;
                                writer
                                    .send(&Event::Log {
                                        level: "info".to_string(),
                                        message: format!(
                                            "Reconnect completed for {}.",
                                            completed_node.label
                                        ),
                                        details: Some(json!({
                                            "peripheralId": completed_node.peripheral_id,
                                            "knownDeviceId": completed_node.known_device_id,
                                            "address": completed_node.address,
                                            "reconnect": reconnect,
                                            "transportMs": transport_ready_at
                                                .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                                            "gattMs": gatt_ready_at
                                                .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                                            "sessionMs": Instant::now()
                                                .duration_since(reconnect_started_at)
                                                .as_millis() as u64,
                                            "usedTelemetryFallback": false,
                                        })),
                                    })
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
                    if session_telemetry_confirm_retry_count < SESSION_TELEMETRY_CONFIRM_RETRY_LIMIT
                        && peripheral.is_connected().await.unwrap_or(false)
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
                                    "retryLimit": SESSION_TELEMETRY_CONFIRM_RETRY_LIMIT,
                                    "timeoutMs": SESSION_HEALTH_ACK_TIMEOUT_MS,
                                })),
                            })
                            .await?;
                        write_chunked_json_command(
                            &peripheral,
                            &current_control_characteristic,
                            r#"{"type":"sync-now"}"#,
                        )
                        .await
                        .with_context(|| format!("sync-now retry failed for {}", node.label))?;
                        session_health_sleep
                            .as_mut()
                            .reset((Instant::now() + Duration::from_millis(SESSION_HEALTH_ACK_TIMEOUT_MS)).into());
                        continue;
                    }

                    return Err(anyhow!(
                        "session confirmation telemetry did not arrive for {}",
                        node.label
                    ));
                }

                if session_bootstrap_retry_count < SESSION_BOOTSTRAP_RETRY_LIMIT
                    && peripheral.is_connected().await.unwrap_or(false)
                {
                    session_bootstrap_retry_count = session_bootstrap_retry_count.saturating_add(1);
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
                                "retryLimit": SESSION_BOOTSTRAP_RETRY_LIMIT,
                                "timeoutMs": SESSION_HEALTH_ACK_TIMEOUT_MS,
                            })),
                        })
                        .await?;
                    send_app_session_bootstrap(
                        &peripheral,
                        &current_control_characteristic,
                        &app_session_nonce,
                    )
                        .await
                        .with_context(|| format!("app-session-bootstrap retry failed for {}", node.label))?;
                    send_app_session_lease(&peripheral, &current_control_characteristic, &app_session_id)
                        .await
                        .with_context(|| format!("app-session-lease retry failed for {}", node.label))?;
                    session_health_sleep
                        .as_mut()
                        .reset((Instant::now() + Duration::from_millis(SESSION_HEALTH_ACK_TIMEOUT_MS)).into());
                    continue;
                }

                let Some(enriched) = telemetry_fallback_node.clone() else {
                    continue;
                };

                session_healthy_reported = true;
                let _ = command_sender.send(SessionCommand::ConnectionHealthy {
                    node: enriched.clone(),
                });
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
                            "timeoutMs": SESSION_HEALTH_ACK_TIMEOUT_MS,
                        })),
                    })
                    .await?;
                writer
                    .send(&Event::NodeConnectionState {
                        node: enriched.clone(),
                        gateway_connection_state: "connected".to_string(),
                        reason: None,
                        reconnect: reconnect.clone(),
                    })
                    .await?;
                writer
                    .send(&Event::Log {
                        level: "info".to_string(),
                        message: format!("Reconnect completed for {}.", enriched.label),
                        details: Some(json!({
                            "peripheralId": enriched.peripheral_id,
                            "knownDeviceId": enriched.known_device_id,
                            "address": enriched.address,
                            "reconnect": reconnect,
                            "transportMs": transport_ready_at
                                .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                            "gattMs": gatt_ready_at
                                .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                            "sessionMs": Instant::now()
                                .duration_since(reconnect_started_at)
                                .as_millis() as u64,
                            "usedTelemetryFallback": true,
                        })),
                    })
                    .await?;
            }
            _ = sleep(Duration::from_millis(CONNECTION_HEALTH_POLL_MS)) => {
                if !is_approved(&node, &allowed_nodes.read().await) {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    if peripheral.is_connected().await.unwrap_or(false) {
                        let _ = peripheral.disconnect().await;
                    }
                    return Ok(Some(format!(
                        "{} was removed from allowed nodes.",
                        node.label,
                    )));
                }
                if !peripheral.is_connected().await.unwrap_or(false) {
                    let _ = lease_shutdown_tx.send(true);
                    let _ = lease_task.await;
                    return Ok(Some(format!("BLE transport ended for {}.", node.label)));
                }
            }
            Some(reason) = lease_failure_rx.recv() => {
                let _ = lease_shutdown_tx.send(true);
                let _ = lease_task.await;
                if is_closed_handle_error_message(&reason)
                    && peripheral.is_connected().await.unwrap_or(false)
                {
                    match recover_active_session_control_path(
                        &peripheral,
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
                                peripheral.clone(),
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
                                        "error": format_error_chain(&error),
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

    if peripheral.is_connected().await.unwrap_or(false) {
        let _ = peripheral.disconnect().await;
    }

    sleep(Duration::from_millis(100)).await;
    Ok(Some(format!("Telemetry stream ended for {}.", node.label)))
}
