use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use btleplug::api::Peripheral as _;
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::{
    sync::{mpsc, watch, Mutex, RwLock},
    time::sleep,
};

use crate::{
    json_decoder::JsonObjectDecoder,
    protocol::{
        ApprovedNodeRule, DiscoveredNode, Event, HistoryErrorPayload, HistoryRecordPayload,
        HistorySyncCompletePayload, ReconnectStatus, RuntimeStatusPayload, TelemetryPayload,
    },
};

use super::{
    approval::is_approved,
    config::Config,
    handshake::{
        control_write_mode, send_app_session_begin, write_chunked_json_command,
    },
    session::{ActiveLiveControl, ActiveSessionChannels},
    session_lease::is_recoverable_write_handle_error_message,
    session_transport::APP_SESSION_HEARTBEAT_MS,
    session_transport_monitor_reporting::report_reconnect_completed,
    session_transport_recovery::{emit_handshake_step, recover_active_session_control_path},
    session_transport_setup::PreparedSession,
    session_types::{ActiveSessionCommand, SessionCommand},
    writer::EventWriter,
};

#[derive(Clone, Copy)]
pub(super) struct MonitorSessionConfig {
    pub(super) connection_health_poll_ms: u64,
    pub(super) session_health_ack_timeout_ms: u64,
    pub(super) session_begin_retry_limit: u32,
    pub(super) post_subscribe_ready_settle_ms: u64,
}

async fn handle_history_status_payload(
    writer: &EventWriter,
    node: &DiscoveredNode,
    payload: Value,
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
    current_session_device_id: &mut Option<String>,
    active_session_command_sender: &mpsc::UnboundedSender<ActiveSessionCommand>,
) -> Result<bool> {
    let status_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    match status_type.as_str() {
        "history-record" => match serde_json::from_value::<HistoryRecordPayload>(payload) {
            Ok(status) => {
                if let Some(peripheral_id) = node.peripheral_id.clone() {
                    known_device_ids
                        .write()
                        .await
                        .insert(peripheral_id, status.device_id.clone());
                }
                *current_session_device_id = Some(status.device_id.clone());
                active_session_controls.lock().await.insert(
                    status.device_id.clone(),
                    ActiveSessionChannels {
                        command_sender: active_session_command_sender.clone(),
                    },
                );
                let mut enriched = node.clone();
                enriched.known_device_id = Some(status.device_id.clone());
                writer
                    .send(&Event::HistoryRecord {
                        node: enriched,
                        device_id: status.device_id,
                        request_id: status.request_id,
                        record: status.record,
                    })
                    .await?;
                Ok(true)
            }
            Err(error) => {
                writer
                    .error(
                        format!("Failed to parse history record payload: {error}"),
                        Some(json!({ "node": node.id })),
                    )
                    .await;
                Ok(true)
            }
        },
        "history-page-complete" => {
            match serde_json::from_value::<HistorySyncCompletePayload>(payload) {
                Ok(status) => {
                    if let Some(peripheral_id) = node.peripheral_id.clone() {
                        known_device_ids
                            .write()
                            .await
                            .insert(peripheral_id, status.device_id.clone());
                    }
                    *current_session_device_id = Some(status.device_id.clone());
                    active_session_controls.lock().await.insert(
                        status.device_id.clone(),
                        ActiveSessionChannels {
                            command_sender: active_session_command_sender.clone(),
                        },
                    );
                    let mut enriched = node.clone();
                    enriched.known_device_id = Some(status.device_id.clone());
                    writer
                        .send(&Event::HistorySyncComplete {
                            node: enriched,
                            payload: status,
                        })
                        .await?;
                    Ok(true)
                }
                Err(error) => {
                    writer
                        .error(
                            format!("Failed to parse history sync completion payload: {error}"),
                            Some(json!({ "node": node.id })),
                        )
                        .await;
                    Ok(true)
                }
            }
        }
        "history-error" => match serde_json::from_value::<HistoryErrorPayload>(payload) {
            Ok(status) => {
                writer
                    .send(&Event::HistoryError {
                        node: node.clone(),
                        payload: status,
                    })
                    .await?;
                Ok(true)
            }
            Err(error) => {
                writer
                    .error(
                        format!("Failed to parse history error payload: {error}"),
                        Some(json!({ "node": node.id })),
                    )
                    .await;
                Ok(true)
            }
        },
        _ => Ok(false),
    }
}

async fn emit_aux_status_payload(
    writer: &EventWriter,
    source: &str,
    node: &DiscoveredNode,
    payload: Value,
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
    current_session_device_id: &mut Option<String>,
    active_session_command_sender: &mpsc::UnboundedSender<ActiveSessionCommand>,
) -> Result<bool> {
    let status_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    match status_type.as_str() {
        "history-debug" => {
            writer
                .send(&Event::Log {
                    level: "info".to_string(),
                    message: "Received firmware history debug status.".to_string(),
                    details: Some(json!({
                        "source": source,
                        "peripheralId": node.peripheral_id,
                        "knownDeviceId": node.known_device_id,
                        "address": node.address,
                        "payload": payload,
                    })),
                })
                .await?;
            Ok(true)
        }
        "board-log" => {
            let level = payload
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_string();
            let tag = payload
                .get("tag")
                .and_then(Value::as_str)
                .unwrap_or("runtime");
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .map(|value| format!("[board:{tag}] {value}"))
                .unwrap_or_else(|| format!("[board:{tag}] firmware log"));
            writer
                .send(&Event::Log {
                    level,
                    message,
                    details: Some(json!({
                        "source": source,
                        "peripheralId": node.peripheral_id,
                        "knownDeviceId": node.known_device_id,
                        "address": node.address,
                        "payload": payload,
                    })),
                })
                .await?;
            Ok(true)
        }
        _ => {
            handle_history_status_payload(
                writer,
                node,
                payload,
                known_device_ids,
                active_session_controls,
                current_session_device_id,
                active_session_command_sender,
            )
            .await
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeSessionStatusDisposition {
    Ignore,
    MatchRequested,
    ObservedDifferent {
        session_id: String,
        session_nonce: String,
    },
}

fn classify_runtime_session_status(
    status: &RuntimeStatusPayload,
    requested_session_id: &str,
    requested_session_nonce: &str,
) -> RuntimeSessionStatusDisposition {
    if status.status_type != "app-session-online" {
        return RuntimeSessionStatusDisposition::Ignore;
    }

    let Some(session_id) = status.session_id.clone() else {
        return RuntimeSessionStatusDisposition::Ignore;
    };
    let Some(session_nonce) = status.session_nonce.clone() else {
        return RuntimeSessionStatusDisposition::Ignore;
    };

    if session_id == requested_session_id && session_nonce == requested_session_nonce {
        return RuntimeSessionStatusDisposition::MatchRequested;
    }

    RuntimeSessionStatusDisposition::ObservedDifferent {
        session_id,
        session_nonce,
    }
}

pub(super) async fn monitor_active_session(
    mut prepared: PreparedSession,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    active_session_controls: Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    reconnect: Option<ReconnectStatus>,
    mut session_shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
    app_session_id: String,
    app_session_nonce: String,
    reconnect_started_at: Instant,
    monitor_config: MonitorSessionConfig,
) -> Result<Option<String>> {
    async fn remember_active_session_control(
        active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
        device_id: &str,
        active_session_command_sender: &mpsc::UnboundedSender<ActiveSessionCommand>,
    ) {
        active_session_controls.lock().await.insert(
            device_id.to_string(),
            ActiveSessionChannels {
                command_sender: active_session_command_sender.clone(),
            },
        );
    }

    async fn remove_active_session_control(
        active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
        device_id: Option<&str>,
    ) {
        if let Some(device_id) = device_id {
            active_session_controls.lock().await.remove(device_id);
        }
    }

    async fn send_history_control_command(
        writer: &EventWriter,
        _node: &DiscoveredNode,
        live_control: &mut ActiveLiveControl,
        session_id: &str,
        command: &ActiveSessionCommand,
    ) -> Result<()> {
        let (payload, request_id) = match command {
            ActiveSessionCommand::BeginHistorySync {
                device_id: _,
                after_sequence,
                max_records,
                request_id,
            } => (
                json!({
                    "type": "history-page-request",
                    "sessionId": session_id,
                    "requestId": request_id,
                    "afterSequence": after_sequence,
                    "maxRecords": max_records,
                }),
                request_id.as_str(),
            ),
            ActiveSessionCommand::AcknowledgeHistorySync {
                device_id: _,
                sequence,
                request_id,
            } => (
                json!({
                    "type": "history-page-ack",
                    "sessionId": session_id,
                    "requestId": request_id,
                    "sequence": sequence,
                }),
                request_id.as_str(),
            ),
        };

        let payload_text = payload.to_string();
        let target_characteristic = &live_control.history_control_characteristic;
        let write_guard = live_control.write_lock.lock().await;
        let write_mode = control_write_mode(&payload_text);
        write_chunked_json_command(
            &live_control.peripheral,
            target_characteristic,
            &payload_text,
        )
        .await?;
        drop(write_guard);

        writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: "Sent history control command to firmware over dedicated history control."
                    .to_string(),
                details: Some(json!({
                    "deviceId": match command {
                        ActiveSessionCommand::BeginHistorySync { device_id, .. } => device_id,
                        ActiveSessionCommand::AcknowledgeHistorySync { device_id, .. } => device_id,
                    },
                    "commandType": payload.get("type").and_then(|value| value.as_str()),
                    "requestId": request_id,
                    "sessionId": session_id,
                    "writeMode": write_mode,
                    "controlUuid": target_characteristic.uuid.to_string(),
                })),
            })
            .await?;

        sleep(Duration::from_millis(400)).await;
        let runtime_status_readback = live_control
            .peripheral
            .read(&live_control.status_characteristic)
            .await
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        let history_status_readback = live_control
            .peripheral
            .read(&live_control.history_status_characteristic)
            .await
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: "Read back status characteristics after history control command."
                    .to_string(),
                details: Some(json!({
                    "deviceId": match command {
                        ActiveSessionCommand::BeginHistorySync { device_id, .. } => device_id,
                        ActiveSessionCommand::AcknowledgeHistorySync { device_id, .. } => device_id,
                    },
                    "requestId": request_id,
                    "sessionId": session_id,
                    "runtimeStatusValue": runtime_status_readback,
                    "historyStatusValue": history_status_readback,
                })),
            })
            .await?;

        Ok(())
    }

    async fn promote_active_session_control_path(
        writer: &EventWriter,
        node: &DiscoveredNode,
        reconnect: &Option<ReconnectStatus>,
        config: &Config,
        peripheral: &btleplug::platform::Peripheral,
        current_live_control: &mut ActiveLiveControl,
        current_app_session_id: &str,
        current_app_session_nonce: &str,
        active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
        current_session_device_id: &Option<String>,
        active_session_command_sender: &mpsc::UnboundedSender<ActiveSessionCommand>,
    ) -> Result<()> {
        let (
            recovered_control_characteristic,
            recovered_status_characteristic,
            recovered_history_control_characteristic,
            recovered_history_status_characteristic,
        ) = recover_active_session_control_path(
            peripheral,
            writer,
            node,
            reconnect,
            config.telemetry_uuid,
            config.control_uuid,
            config.status_uuid,
            config.history_control_uuid,
            config.history_status_uuid,
            current_app_session_id,
            current_app_session_nonce,
        )
        .await?;

        *current_live_control = ActiveLiveControl {
            peripheral: peripheral.clone(),
            characteristic: recovered_control_characteristic,
            history_control_characteristic: recovered_history_control_characteristic,
            status_characteristic: recovered_status_characteristic,
            history_status_characteristic: recovered_history_status_characteristic,
            write_lock: current_live_control.write_lock.clone(),
        };

        if let Some(device_id) = current_session_device_id.as_deref() {
            remember_active_session_control(
                active_session_controls,
                device_id,
                active_session_command_sender,
            )
            .await;
        }

        Ok(())
    }

    emit_handshake_step(
        &writer,
        config.verbose_logging,
        &node,
        &reconnect,
        "starting app-session begin handshake",
    )
    .await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));
    let mut status_decoder = JsonObjectDecoder::new(format!("status:{}", node.label));
    let mut history_decoder = JsonObjectDecoder::new(format!("history:{}", node.label));
    let mut session_healthy_reported = false;
    let session_health_deadline =
        Instant::now() + Duration::from_millis(monitor_config.session_health_ack_timeout_ms);
    let session_health_sleep = tokio::time::sleep_until(session_health_deadline.into());
    tokio::pin!(session_health_sleep);
    let mut session_begin_retry_count = 0_u32;
    let mut handshake_control_path_recovered = false;
    let mut current_session_device_id: Option<String> = None;
    let current_app_session_id = app_session_id;
    let current_app_session_nonce = app_session_nonce;
    let mut active_app_session_id = current_app_session_id.to_string();
    let (active_session_command_sender, mut active_session_commands) =
        mpsc::unbounded_channel::<ActiveSessionCommand>();
    let mut current_live_control = ActiveLiveControl {
        peripheral: prepared.peripheral.clone(),
        characteristic: prepared.live_control_characteristic.clone(),
        history_control_characteristic: prepared.history_control_characteristic.clone(),
        status_characteristic: prepared.status_characteristic.clone(),
        history_status_characteristic: prepared.history_status_characteristic.clone(),
        write_lock: std::sync::Arc::new(Mutex::new(())),
    };
    let mut lease_heartbeat =
        tokio::time::interval(Duration::from_millis(APP_SESSION_HEARTBEAT_MS));
    lease_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    lease_heartbeat.tick().await;
    let mut lease_heartbeat_enabled = false;
    let mut first_lease_logged = false;
    let mut telemetry_subscribed = false;
    let mut status_poll = tokio::time::interval(Duration::from_millis(500));
    status_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    status_poll.tick().await;
    let mut last_polled_runtime_status: Option<String> = None;
    let mut last_polled_history_status: Option<String> = None;

    if monitor_config.post_subscribe_ready_settle_ms > 0 {
        sleep(Duration::from_millis(
            monitor_config.post_subscribe_ready_settle_ms,
        ))
        .await;
    }

    emit_handshake_step(
        &writer,
        config.verbose_logging,
        &node,
        &reconnect,
        "sending app-session begin",
    )
    .await?;
    let write_guard = current_live_control.write_lock.lock().await;
    let begin_result = send_app_session_begin(
        &current_live_control.peripheral,
        &current_live_control.characteristic,
        &current_app_session_nonce,
        &current_app_session_id,
    )
    .await;
    drop(write_guard);
    begin_result.with_context(|| format!("initial app-session begin failed for {}", node.label))?;

    loop {
        tokio::select! {
            changed = session_shutdown.changed() => {
                if changed.is_ok() && *session_shutdown.borrow() {
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
            Some(active_command) = active_session_commands.recv() => {
                send_history_control_command(
                    &writer,
                    &node,
                    &mut current_live_control,
                    &active_app_session_id,
                    &active_command,
                )
                .await?;
            }
            _ = status_poll.tick() => {
                let runtime_status_readback = current_live_control
                    .peripheral
                    .read(&current_live_control.status_characteristic)
                    .await
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                if runtime_status_readback != last_polled_runtime_status {
                    last_polled_runtime_status = runtime_status_readback.clone();
                    if let Some(raw) = runtime_status_readback {
                        if let Ok(payload) = serde_json::from_str::<Value>(&raw) {
                            let polled_runtime_status =
                                serde_json::from_value::<RuntimeStatusPayload>(payload.clone()).ok();
                            if !session_healthy_reported {
                                if let Some(status) = polled_runtime_status.as_ref() {
                                    match classify_runtime_session_status(
                                        status,
                                        &current_app_session_id,
                                        &current_app_session_nonce,
                                    ) {
                                        RuntimeSessionStatusDisposition::Ignore => {}
                                        RuntimeSessionStatusDisposition::MatchRequested => {
                                            writer
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: "Verified the requested app session from the polled runtime status.".to_string(),
                                                    details: Some(json!({
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                        "expectedSessionId": current_app_session_id,
                                                        "expectedSessionNonce": current_app_session_nonce,
                                                        "rawStatusValue": raw,
                                                        "bootId": status.boot_id,
                                                    })),
                                                })
                                                .await?;
                                            let mut enriched = node.clone();
                                            if let Some(device_id) = status.device_id.clone() {
                                                if let Some(peripheral_id) = node.peripheral_id.clone() {
                                                    known_device_ids
                                                        .write()
                                                        .await
                                                        .insert(peripheral_id, device_id.clone());
                                                }
                                                current_session_device_id = Some(device_id.clone());
                                                enriched.known_device_id = Some(device_id.clone());
                                                remember_active_session_control(
                                                    &active_session_controls,
                                                    &device_id,
                                                    &active_session_command_sender,
                                                )
                                                .await;
                                            }
                                            promote_active_session_control_path(
                                                &writer,
                                                &node,
                                                &reconnect,
                                                &config,
                                                &prepared.peripheral,
                                                &mut current_live_control,
                                                &current_app_session_id,
                                                &current_app_session_nonce,
                                                &active_session_controls,
                                                &current_session_device_id,
                                                &active_session_command_sender,
                                            )
                                            .await?;
                                            if !telemetry_subscribed {
                                                emit_handshake_step(
                                                    &writer,
                                                    config.verbose_logging,
                                                    &node,
                                                    &reconnect,
                                                    "subscribing to telemetry after status poll verification",
                                                )
                                                .await?;
                                                prepared
                                                    .peripheral
                                                    .subscribe(&prepared.telemetry_characteristic)
                                                    .await
                                                    .with_context(|| {
                                                        format!(
                                                            "telemetry subscribe after status poll verification failed for {}",
                                                            node.label
                                                        )
                                                    })?;
                                                telemetry_subscribed = true;
                                            }
                                            session_healthy_reported = true;
                                            lease_heartbeat_enabled = true;
                                            report_reconnect_completed(
                                                &writer,
                                                &command_sender,
                                                &enriched,
                                                &reconnect,
                                                status.boot_id.clone(),
                                                prepared.transport_ready_at,
                                                prepared.gatt_ready_at,
                                                reconnect_started_at,
                                                "status-poll",
                                            )
                                            .await?;
                                            continue;
                                        }
                                        RuntimeSessionStatusDisposition::ObservedDifferent {
                                            session_id,
                                            session_nonce,
                                        } => {
                                            writer
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: "Ignoring a non-matching runtime status poll during reconnect until the exact requested session appears.".to_string(),
                                                    details: Some(json!({
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                        "expectedSessionId": current_app_session_id,
                                                        "expectedSessionNonce": current_app_session_nonce,
                                                        "observedSessionId": session_id,
                                                        "observedSessionNonce": session_nonce,
                                                        "rawStatusValue": raw,
                                                        "bootId": status.boot_id,
                                                    })),
                                                })
                                                .await?;
                                        }
                                    }
                                }
                            }
                            let handled = emit_aux_status_payload(
                                &writer,
                                "runtime-status-poll",
                                &node,
                                payload,
                                &known_device_ids,
                                &active_session_controls,
                                &mut current_session_device_id,
                                &active_session_command_sender,
                            )
                            .await?;
                            if !handled {
                                writer
                                    .send(&Event::Log {
                                        level: "info".to_string(),
                                        message: "Polled runtime status characteristic changed.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": node.known_device_id,
                                            "address": node.address,
                                            "rawValue": raw,
                                        })),
                                    })
                                    .await?;
                            }
                        }
                    }
                }

                let history_status_readback = current_live_control
                    .peripheral
                    .read(&current_live_control.history_status_characteristic)
                    .await
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                if history_status_readback != last_polled_history_status {
                    last_polled_history_status = history_status_readback.clone();
                    if let Some(raw) = history_status_readback {
                        if let Ok(payload) = serde_json::from_str::<Value>(&raw) {
                            let handled = emit_aux_status_payload(
                                &writer,
                                "history-status-poll",
                                &node,
                                payload,
                                &known_device_ids,
                                &active_session_controls,
                                &mut current_session_device_id,
                                &active_session_command_sender,
                            )
                            .await?;
                            if !handled {
                                writer
                                    .send(&Event::Log {
                                        level: "info".to_string(),
                                        message: "Polled history status characteristic changed.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": node.known_device_id,
                                            "address": node.address,
                                            "rawValue": raw,
                                        })),
                                    })
                                    .await?;
                            }
                        }
                    }
                }
            }
            notification = prepared.notifications.next() => {
                let Some(notification) = notification else {
                    break;
                };

                if notification.uuid == config.status_uuid {
                    for payload in status_decoder.push_bytes(&notification.value)? {
                        let handled = emit_aux_status_payload(
                            &writer,
                            "runtime-status-notify",
                            &node,
                            payload.clone(),
                            &known_device_ids,
                            &active_session_controls,
                            &mut current_session_device_id,
                            &active_session_command_sender,
                        )
                        .await?;
                        if handled {
                            continue;
                        }
                        writer
                            .send(&Event::Log {
                                level: "info".to_string(),
                                message: "Received runtime status notification.".to_string(),
                                details: Some(json!({
                                    "peripheralId": node.peripheral_id,
                                    "knownDeviceId": node.known_device_id,
                                    "address": node.address,
                                    "payload": payload,
                                })),
                            })
                            .await?;
                    }
                    continue;
                }

                if notification.uuid == config.history_status_uuid {
                    for payload in history_decoder.push_bytes(&notification.value)? {
                        let status_type = payload
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if status_type == "history-debug" {
                            writer
                                .send(&Event::Log {
                                    level: "info".to_string(),
                                    message: "Received firmware history debug status.".to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": node.known_device_id,
                                        "address": node.address,
                                        "payload": payload,
                                    })),
                                })
                                .await?;
                            continue;
                        }
                        if handle_history_status_payload(
                            &writer,
                            &node,
                            payload,
                            &known_device_ids,
                            &active_session_controls,
                            &mut current_session_device_id,
                            &active_session_command_sender,
                        )
                        .await?
                        {
                            continue;
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
                            current_session_device_id = Some(payload.device_id.clone());
                            remember_active_session_control(
                                &active_session_controls,
                                &payload.device_id,
                                &active_session_command_sender,
                            )
                            .await;
                            let mut enriched = node.clone();
                            enriched.known_device_id = Some(payload.device_id.clone());
                            writer
                                .send(&Event::Telemetry {
                                    node: enriched,
                                    payload,
                                })
                                .await?;
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
                if session_begin_retry_count < monitor_config.session_begin_retry_limit
                    && prepared.peripheral.is_connected().await.unwrap_or(false)
                {
                    session_begin_retry_count = session_begin_retry_count.saturating_add(1);
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: "The requested app session is not visible in runtime status yet; retrying app-session begin on the same connection.".to_string(),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "expectedSessionId": current_app_session_id,
                                "retryCount": session_begin_retry_count,
                                "retryLimit": monitor_config.session_begin_retry_limit,
                                "timeoutMs": monitor_config.session_health_ack_timeout_ms,
                            })),
                        })
                        .await?;
                    let write_guard = current_live_control.write_lock.lock().await;
                    let begin_result = send_app_session_begin(
                        &current_live_control.peripheral,
                        &current_live_control.characteristic,
                        &current_app_session_nonce,
                        &current_app_session_id,
                    )
                    .await;
                    drop(write_guard);
                    begin_result.with_context(|| {
                        format!("app-session begin retry failed for {}", node.label)
                    })?;
                    session_health_sleep.as_mut().reset(
                        (Instant::now()
                            + Duration::from_millis(monitor_config.session_health_ack_timeout_ms))
                        .into(),
                    );
                    continue;
                }

                let raw_status_value = prepared
                    .peripheral
                    .read(&current_live_control.status_characteristic)
                    .await
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                let raw_status_payload = raw_status_value
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<RuntimeStatusPayload>(raw).ok());

                if let Some(status) = raw_status_payload.as_ref() {
                    match classify_runtime_session_status(
                        status,
                        &current_app_session_id,
                        &current_app_session_nonce,
                    ) {
                        RuntimeSessionStatusDisposition::MatchRequested => {
                            writer
                                .send(&Event::Log {
                                    level: "warn".to_string(),
                                    message: "Verified the requested app session from a direct runtime status readback.".to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": node.known_device_id,
                                        "address": node.address,
                                        "expectedSessionId": current_app_session_id,
                                        "expectedSessionNonce": current_app_session_nonce,
                                        "rawStatusValue": raw_status_value,
                                        "bootId": status.boot_id,
                                    })),
                                })
                                .await?;
                            let mut enriched = node.clone();
                            if let Some(device_id) = status.device_id.clone() {
                                if let Some(peripheral_id) = node.peripheral_id.clone() {
                                    known_device_ids
                                        .write()
                                        .await
                                        .insert(peripheral_id, device_id.clone());
                                }
                                current_session_device_id = Some(device_id.clone());
                                enriched.known_device_id = Some(device_id.clone());
                                remember_active_session_control(
                                    &active_session_controls,
                                    &device_id,
                                    &active_session_command_sender,
                                )
                                .await;
                            }
                            promote_active_session_control_path(
                                &writer,
                                &node,
                                &reconnect,
                                &config,
                                &prepared.peripheral,
                                &mut current_live_control,
                                &current_app_session_id,
                                &current_app_session_nonce,
                                &active_session_controls,
                                &current_session_device_id,
                                &active_session_command_sender,
                            )
                            .await?;
                            if !telemetry_subscribed {
                                emit_handshake_step(
                                    &writer,
                                    config.verbose_logging,
                                    &node,
                                    &reconnect,
                                    "subscribing to telemetry after direct runtime status verification",
                                )
                                .await?;
                                prepared
                                    .peripheral
                                    .subscribe(&prepared.telemetry_characteristic)
                                    .await
                                    .with_context(|| {
                                        format!(
                                            "telemetry subscribe after direct runtime status verification failed for {}",
                                            node.label
                                        )
                                    })?;
                                telemetry_subscribed = true;
                            }
                            session_healthy_reported = true;
                            lease_heartbeat_enabled = true;
                            report_reconnect_completed(
                                &writer,
                                &command_sender,
                                &enriched,
                                &reconnect,
                                status.boot_id.clone(),
                                prepared.transport_ready_at,
                                prepared.gatt_ready_at,
                                reconnect_started_at,
                                "status-readback",
                            )
                            .await?;
                            continue;
                        }
                        RuntimeSessionStatusDisposition::ObservedDifferent {
                            session_id,
                            session_nonce,
                        } => {
                            writer
                                .send(&Event::Log {
                                    level: "warn".to_string(),
                                    message: "Fresh reconnect session did not take, but the board is still advertising a live app session; adopting that session instead of failing reconnect.".to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": node.known_device_id,
                                        "address": node.address,
                                        "expectedSessionId": current_app_session_id,
                                        "expectedSessionNonce": current_app_session_nonce,
                                        "observedSessionId": session_id,
                                        "observedSessionNonce": session_nonce,
                                        "rawStatusValue": raw_status_value,
                                        "bootId": status.boot_id,
                                    })),
                                })
                                .await?;
                            let mut enriched = node.clone();
                            if let Some(device_id) = status.device_id.clone() {
                                if let Some(peripheral_id) = node.peripheral_id.clone() {
                                    known_device_ids
                                        .write()
                                        .await
                                        .insert(peripheral_id, device_id.clone());
                                }
                                current_session_device_id = Some(device_id.clone());
                                enriched.known_device_id = Some(device_id.clone());
                                remember_active_session_control(
                                    &active_session_controls,
                                    &device_id,
                                    &active_session_command_sender,
                                )
                                .await;
                            }
                            promote_active_session_control_path(
                                &writer,
                                &node,
                                &reconnect,
                                &config,
                                &prepared.peripheral,
                                &mut current_live_control,
                                &current_app_session_id,
                                &current_app_session_nonce,
                                &active_session_controls,
                                &current_session_device_id,
                                &active_session_command_sender,
                            )
                            .await?;
                            if !telemetry_subscribed {
                                emit_handshake_step(
                                    &writer,
                                    config.verbose_logging,
                                    &node,
                                    &reconnect,
                                    "subscribing to telemetry after adopting the existing board session",
                                )
                                .await?;
                                prepared
                                    .peripheral
                                    .subscribe(&prepared.telemetry_characteristic)
                                    .await
                                    .with_context(|| {
                                        format!(
                                            "telemetry subscribe after adopting the existing board session failed for {}",
                                            node.label
                                        )
                                    })?;
                                telemetry_subscribed = true;
                            }
                            active_app_session_id = session_id;
                            let _ = session_nonce;
                            session_healthy_reported = true;
                            lease_heartbeat_enabled = true;
                            report_reconnect_completed(
                                &writer,
                                &command_sender,
                                &enriched,
                                &reconnect,
                                status.boot_id.clone(),
                                prepared.transport_ready_at,
                                prepared.gatt_ready_at,
                                reconnect_started_at,
                                "observed-live-session",
                            )
                            .await?;
                            continue;
                        }
                        RuntimeSessionStatusDisposition::Ignore => {}
                    }
                }

                if !handshake_control_path_recovered
                    && prepared.peripheral.is_connected().await.unwrap_or(false)
                {
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: "The requested app session is still not visible after retry; refreshing the active control path and replaying app-session begin once before failing.".to_string(),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "expectedSessionId": current_app_session_id,
                                "rawStatusValue": raw_status_value,
                            })),
                        })
                        .await?;
                    promote_active_session_control_path(
                        &writer,
                        &node,
                        &reconnect,
                        &config,
                        &prepared.peripheral,
                        &mut current_live_control,
                        &current_app_session_id,
                        &current_app_session_nonce,
                        &active_session_controls,
                        &current_session_device_id,
                        &active_session_command_sender,
                    )
                    .await?;
                    let write_guard = current_live_control.write_lock.lock().await;
                    let replay_begin_result = send_app_session_begin(
                        &current_live_control.peripheral,
                        &current_live_control.characteristic,
                        &current_app_session_nonce,
                        &current_app_session_id,
                    )
                    .await;
                    drop(write_guard);
                    replay_begin_result.with_context(|| {
                        format!(
                            "app-session begin replay after active control-path refresh failed for {}",
                            node.label
                        )
                    })?;
                    handshake_control_path_recovered = true;
                    session_begin_retry_count = 0;
                    last_polled_runtime_status = None;
                    session_health_sleep.as_mut().reset(
                        (Instant::now()
                            + Duration::from_millis(monitor_config.session_health_ack_timeout_ms))
                        .into(),
                    );
                    continue;
                }

                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: "The requested app session never became visible in runtime status; readback before failing.".to_string(),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "expectedSessionId": current_app_session_id,
                            "rawStatusValue": raw_status_value,
                        })),
                    })
                    .await?;
                return Err(anyhow!(
                    "requested app session did not become visible for {} after {} retry attempt(s)",
                    node.label,
                    session_begin_retry_count
                ));
            }
            _ = lease_heartbeat.tick(), if lease_heartbeat_enabled => {
                let write_guard = current_live_control.write_lock.lock().await;
                let lease_result = super::handshake::send_app_session_lease(
                    &current_live_control.peripheral,
                    &current_live_control.characteristic,
                    &active_app_session_id,
                )
                .await;
                drop(write_guard);

                if let Err(error) = lease_result {
                    let reason = format!("{:#}", error);
                    if is_recoverable_write_handle_error_message(&reason)
                        && prepared.peripheral.is_connected().await.unwrap_or(false)
                    {
                        match promote_active_session_control_path(
                            &writer,
                            &node,
                            &reconnect,
                            &config,
                            &prepared.peripheral,
                            &mut current_live_control,
                            &current_app_session_id,
                            &current_app_session_nonce,
                            &active_session_controls,
                            &current_session_device_id,
                            &active_session_command_sender,
                        )
                        .await
                        {
                            Ok(()) => {
                                continue;
                            }
                            Err(recovery_error) => {
                                writer
                                    .send(&Event::Log {
                                        level: "warn".to_string(),
                                        message: "Active session control-path recovery failed during lease heartbeat; falling back to reconnect scan.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": node.known_device_id,
                                            "address": node.address,
                                            "reconnect": reconnect,
                                            "error": format!("{:#}", recovery_error),
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

                if !first_lease_logged {
                    first_lease_logged = true;
                    sleep(Duration::from_millis(1200)).await;
                    let runtime_status_readback = current_live_control
                        .peripheral
                        .read(&current_live_control.status_characteristic)
                        .await
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok());
                    let history_status_readback = current_live_control
                        .peripheral
                        .read(&current_live_control.history_status_characteristic)
                        .await
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok());
                    writer
                        .send(&Event::Log {
                            level: "info".to_string(),
                            message: "Sent first app-session lease after reconnect.".to_string(),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": current_session_device_id,
                                "address": node.address,
                                "sessionId": active_app_session_id,
                                "runtimeStatusValue": runtime_status_readback,
                                "historyStatusValue": history_status_readback,
                            })),
                        })
                        .await?;
                    let delayed_writer = writer.clone();
                    let delayed_peripheral = current_live_control.peripheral.clone();
                    let delayed_status_characteristic =
                        current_live_control.status_characteristic.clone();
                    let delayed_history_status_characteristic =
                        current_live_control.history_status_characteristic.clone();
                    let delayed_node = node.clone();
                    let delayed_known_device_id = current_session_device_id.clone();
                    tokio::spawn(async move {
                        sleep(Duration::from_millis(4000)).await;
                        let runtime_status_readback = delayed_peripheral
                            .read(&delayed_status_characteristic)
                            .await
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok());
                        let history_status_readback = delayed_peripheral
                            .read(&delayed_history_status_characteristic)
                            .await
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok());
                        let _ = delayed_writer
                            .send(&Event::Log {
                                level: "info".to_string(),
                                message:
                                    "Read back status characteristics four seconds after first reconnect lease."
                                        .to_string(),
                                details: Some(json!({
                                    "peripheralId": delayed_node.peripheral_id,
                                    "knownDeviceId": delayed_known_device_id,
                                    "address": delayed_node.address,
                                    "runtimeStatusValue": runtime_status_readback,
                                    "historyStatusValue": history_status_readback,
                                })),
                            })
                            .await;
                    });
                }
            }
            _ = sleep(Duration::from_millis(monitor_config.connection_health_poll_ms)) => {
                if !is_approved(&node, &allowed_nodes.read().await) {
                    if prepared.peripheral.is_connected().await.unwrap_or(false) {
                        let _ = prepared.peripheral.disconnect().await;
                    }
                    return Ok(Some(format!("{} was removed from allowed nodes.", node.label)));
                }
                if !prepared.peripheral.is_connected().await.unwrap_or(false) {
                    return Ok(Some(format!("BLE transport ended for {}.", node.label)));
                }
            }
        }
    }

    remove_active_session_control(
        &active_session_controls,
        current_session_device_id.as_deref(),
    )
    .await;

    if prepared.peripheral.is_connected().await.unwrap_or(false) {
        let _ = prepared.peripheral.disconnect().await;
        sleep(Duration::from_millis(100)).await;
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{classify_runtime_session_status, RuntimeSessionStatusDisposition};
    use crate::protocol::RuntimeStatusPayload;

    fn app_session_online_status(
        session_id: Option<&str>,
        session_nonce: Option<&str>,
        boot_id: Option<&str>,
    ) -> RuntimeStatusPayload {
        RuntimeStatusPayload {
            status_type: "app-session-online".to_string(),
            device_id: Some("node-1".to_string()),
            boot_id: boot_id.map(str::to_string),
            boot_uptime_ms: None,
            session_id: session_id.map(str::to_string),
            session_nonce: session_nonce.map(str::to_string),
            firmware_version: None,
            hardware_id: None,
            phase: None,
            message: None,
            version: None,
        }
    }

    #[test]
    fn matches_requested_runtime_session_status() {
        let status = app_session_online_status(Some("session-a"), Some("nonce-a"), Some("boot-a"));

        assert_eq!(
            classify_runtime_session_status(&status, "session-a", "nonce-a"),
            RuntimeSessionStatusDisposition::MatchRequested
        );
    }

    #[test]
    fn ignores_mismatched_runtime_session_status_when_node_reports_a_different_live_session() {
        let status =
            app_session_online_status(Some("session-live"), Some("nonce-live"), Some("boot-live"));

        assert_eq!(
            classify_runtime_session_status(&status, "session-new", "nonce-new"),
            RuntimeSessionStatusDisposition::ObservedDifferent {
                session_id: "session-live".to_string(),
                session_nonce: "nonce-live".to_string(),
            }
        );
    }
}
