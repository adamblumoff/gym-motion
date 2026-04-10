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
    handshake::{send_app_session_begin, write_chunked_json_command},
    session::{ActiveHistoryControl, ActiveLiveControl, ActiveSessionChannels},
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
    pub(super) session_begin_retry_limit: u32,
    pub(super) post_subscribe_ready_settle_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeSessionStatusDisposition {
    Ignore,
    MatchRequested,
    ReclaimExisting {
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

    RuntimeSessionStatusDisposition::ReclaimExisting {
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
    fn spawn_placeholder_lease_task() -> (
        watch::Sender<bool>,
        mpsc::UnboundedReceiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let (lease_shutdown_tx, mut lease_shutdown_rx) = watch::channel(false);
        let (_lease_failure_tx, lease_failure_rx) = mpsc::unbounded_channel::<String>();
        let lease_task = tokio::spawn(async move {
            loop {
                if lease_shutdown_rx.changed().await.is_err() || *lease_shutdown_rx.borrow() {
                    break;
                }
            }
        });

        (lease_shutdown_tx, lease_failure_rx, lease_task)
    }

    async fn remember_active_session_control(
        active_session_controls: &Arc<Mutex<HashMap<String, ActiveSessionChannels>>>,
        device_id: &str,
        history: &ActiveHistoryControl,
    ) {
        active_session_controls.lock().await.insert(
            device_id.to_string(),
            ActiveSessionChannels {
                history: history.clone(),
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
    let mut ack_received = false;
    let mut session_begin_retry_count = 0_u32;
    let mut ack_confirmed_node: Option<DiscoveredNode> = None;
    let mut current_session_device_id: Option<String> = None;
    let mut current_app_session_id = app_session_id;
    let mut current_app_session_nonce = app_session_nonce;
    let mut current_live_control = ActiveLiveControl {
        peripheral: prepared.peripheral.clone(),
        characteristic: prepared.live_control_characteristic,
        write_lock: std::sync::Arc::new(Mutex::new(())),
    };
    let mut current_history_control = ActiveHistoryControl {
        peripheral: prepared.peripheral.clone(),
        characteristic: prepared.history_control_characteristic,
        write_lock: std::sync::Arc::new(Mutex::new(())),
        app_session_id: current_app_session_id.clone(),
    };
    let (mut lease_shutdown_tx, mut lease_failure_rx, mut lease_task) =
        spawn_placeholder_lease_task();
    let mut lease_task_started = false;

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
                        let status_type = payload
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();

                        match status_type.as_str() {
                            "app-session-online" => match serde_json::from_value::<RuntimeStatusPayload>(payload) {
                            Ok(status) => {
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

                                let Some(session_nonce) = status.session_nonce.clone() else {
                                    writer
                                        .send(&Event::Log {
                                            level: "warn".to_string(),
                                            message: "Ignoring app-session-online status without a session nonce.".to_string(),
                                            details: Some(json!({
                                                "peripheralId": node.peripheral_id,
                                                "knownDeviceId": node.known_device_id,
                                                "address": node.address,
                                                "expectedSessionId": current_app_session_id,
                                            })),
                                        })
                                        .await?;
                                    continue;
                                };
                                if session_id != current_app_session_id
                                    || session_nonce != current_app_session_nonce
                                {
                                    continue;
                                }
                                ack_received = true;
                                if !lease_task_started {
                                    let _ = lease_shutdown_tx.send(true);
                                    let _ = lease_task.await;
                                    let (new_shutdown_tx, new_failure_rx, new_lease_task) =
                                        spawn_lease_task(
                                            current_live_control.clone(),
                                            current_app_session_id.clone(),
                                        );
                                    lease_shutdown_tx = new_shutdown_tx;
                                    lease_failure_rx = new_failure_rx;
                                    lease_task = new_lease_task;
                                    lease_task_started = true;
                                }
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
                                let write_guard = current_live_control.write_lock.lock().await;
                                let sync_now_result = write_chunked_json_command(
                                    &current_live_control.peripheral,
                                    &current_live_control.characteristic,
                                    r#"{"type":"sync-now"}"#,
                                )
                                .await;
                                drop(write_guard);
                                if let Err(error) = sync_now_result {
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
                                if let Some(device_id) = status.device_id.as_deref() {
                                    current_session_device_id = Some(device_id.to_string());
                                    remember_active_session_control(
                                        &active_session_controls,
                                        device_id,
                                        &current_history_control,
                                    )
                                    .await;
                                }
                                if !session_healthy_reported {
                                    session_healthy_reported = true;
                                    report_reconnect_completed(
                                        &writer,
                                        &command_sender,
                                        &enriched,
                                        &reconnect,
                                        prepared.transport_ready_at,
                                        prepared.gatt_ready_at,
                                        reconnect_started_at,
                                        false,
                                    )
                                    .await?;
                                    continue;
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
                            },
                            _ => {}
                        }
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

                        match status_type.as_str() {
                            "history-record" => match serde_json::from_value::<HistoryRecordPayload>(payload) {
                                Ok(status) => {
                                    if let Some(peripheral_id) = node.peripheral_id.clone() {
                                        known_device_ids
                                            .write()
                                            .await
                                            .insert(peripheral_id, status.device_id.clone());
                                    }
                                    current_session_device_id = Some(status.device_id.clone());
                                    remember_active_session_control(
                                        &active_session_controls,
                                        &status.device_id,
                                        &current_history_control,
                                    )
                                    .await;
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
                                }
                                Err(error) => {
                                    writer
                                        .error(
                                            format!("Failed to parse history record payload: {error}"),
                                            Some(json!({ "node": node.id })),
                                        )
                                        .await;
                                }
                            },
                            "history-page-complete" => match serde_json::from_value::<HistorySyncCompletePayload>(payload) {
                                Ok(status) => {
                                    if let Some(peripheral_id) = node.peripheral_id.clone() {
                                        known_device_ids
                                            .write()
                                            .await
                                            .insert(peripheral_id, status.device_id.clone());
                                    }
                                    current_session_device_id = Some(status.device_id.clone());
                                    remember_active_session_control(
                                        &active_session_controls,
                                        &status.device_id,
                                        &current_history_control,
                                    )
                                    .await;
                                    let mut enriched = node.clone();
                                    enriched.known_device_id = Some(status.device_id.clone());
                                    writer
                                        .send(&Event::HistorySyncComplete {
                                            node: enriched,
                                            payload: status,
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
                            },
                            "history-error" => match serde_json::from_value::<HistoryErrorPayload>(payload) {
                                Ok(status) => {
                                    writer
                                        .send(&Event::HistoryError {
                                            node: node.clone(),
                                            payload: status,
                                        })
                                        .await?;
                                }
                                Err(error) => {
                                    writer
                                        .error(
                                            format!("Failed to parse history error payload: {error}"),
                                            Some(json!({ "node": node.id })),
                                        )
                                        .await;
                                }
                            },
                            _ => {}
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
                                &current_history_control,
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
                if ack_received {
                    let completed_node = ack_confirmed_node.clone().unwrap_or_else(|| node.clone());
                    session_healthy_reported = true;
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
                    continue;
                }

                if session_begin_retry_count < monitor_config.session_begin_retry_limit
                    && prepared.peripheral.is_connected().await.unwrap_or(false)
                {
                    session_begin_retry_count = session_begin_retry_count.saturating_add(1);
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: "Session health ack did not arrive yet; retrying app-session begin on the same connection.".to_string(),
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
                    .read(&prepared.status_characteristic)
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
                                level: "info".to_string(),
                                message: "Session health ack notification was missed, but the runtime status characteristic already reflects the requested app session.".to_string(),
                                details: Some(json!({
                                    "peripheralId": node.peripheral_id,
                                    "knownDeviceId": node.known_device_id,
                                    "address": node.address,
                                    "sessionId": current_app_session_id,
                                })),
                            })
                            .await?;
                        ack_received = true;
                        if !lease_task_started {
                            let _ = lease_shutdown_tx.send(true);
                            let _ = lease_task.await;
                            let (new_shutdown_tx, new_failure_rx, new_lease_task) =
                                spawn_lease_task(
                                    current_live_control.clone(),
                                    current_app_session_id.clone(),
                                );
                            lease_shutdown_tx = new_shutdown_tx;
                            lease_failure_rx = new_failure_rx;
                            lease_task = new_lease_task;
                            lease_task_started = true;
                        }
                        if let Some(device_id) = status.device_id.as_deref() {
                            current_session_device_id = Some(device_id.to_string());
                            remember_active_session_control(
                                &active_session_controls,
                                device_id,
                                &current_history_control,
                            )
                            .await;
                        }
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
                        ack_confirmed_node = Some(enriched);
                        session_health_sleep.as_mut().reset(
                            (Instant::now()
                                + Duration::from_millis(
                                    monitor_config.session_health_ack_timeout_ms,
                                ))
                            .into(),
                        );
                        continue;
                    }
                    RuntimeSessionStatusDisposition::ReclaimExisting {
                        session_id: observed_session_id,
                        session_nonce: observed_session_nonce,
                    } => {
                        writer
                            .send(&Event::Log {
                                level: "info".to_string(),
                                message: "Reclaiming the node's existing runtime app session during reconnect bootstrap.".to_string(),
                                details: Some(json!({
                                    "peripheralId": node.peripheral_id,
                                    "knownDeviceId": node.known_device_id,
                                    "address": node.address,
                                    "expectedSessionId": current_app_session_id,
                                    "observedSessionId": observed_session_id,
                                })),
                            })
                            .await?;
                        current_app_session_id = observed_session_id;
                        current_app_session_nonce = observed_session_nonce;
                        current_history_control.app_session_id = current_app_session_id.clone();
                        ack_received = true;
                        if !lease_task_started {
                            let _ = lease_shutdown_tx.send(true);
                            let _ = lease_task.await;
                            let (new_shutdown_tx, new_failure_rx, new_lease_task) =
                                spawn_lease_task(
                                    current_live_control.clone(),
                                    current_app_session_id.clone(),
                                );
                            lease_shutdown_tx = new_shutdown_tx;
                            lease_failure_rx = new_failure_rx;
                            lease_task = new_lease_task;
                            lease_task_started = true;
                        }
                        if let Some(device_id) = status.device_id.as_deref() {
                            current_session_device_id = Some(device_id.to_string());
                            remember_active_session_control(
                                &active_session_controls,
                                device_id,
                                &current_history_control,
                            )
                            .await;
                        }
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
                        ack_confirmed_node = Some(enriched);
                        session_health_sleep.as_mut().reset(
                            (Instant::now()
                                + Duration::from_millis(
                                    monitor_config.session_health_ack_timeout_ms,
                                ))
                            .into(),
                        );
                        continue;
                    }
                    RuntimeSessionStatusDisposition::Ignore => {}
                    }
                }

                writer
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: "Session health ack still missing after retry; runtime status readback before failing.".to_string(),
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
                    "session health ack did not arrive for {} after {} retry attempt(s)",
                    node.label,
                    session_begin_retry_count
                ));
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
                        &current_app_session_id,
                        &current_app_session_nonce,
                    )
                    .await
                {
                        Ok(recovered_control_characteristic) => {
                            current_live_control = ActiveLiveControl {
                                peripheral: prepared.peripheral.clone(),
                                characteristic: recovered_control_characteristic,
                                write_lock: current_live_control.write_lock.clone(),
                            };
                            if let Some(device_id) = current_session_device_id.as_deref() {
                                remember_active_session_control(
                                    &active_session_controls,
                                    device_id,
                                    &current_history_control,
                                )
                                .await;
                            }
                            let (new_shutdown_tx, new_failure_rx, new_lease_task) = spawn_lease_task(
                                current_live_control.clone(),
                                current_app_session_id.clone(),
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
    ) -> RuntimeStatusPayload {
        RuntimeStatusPayload {
            status_type: "app-session-online".to_string(),
            device_id: Some("node-1".to_string()),
            boot_id: None,
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
        let status = app_session_online_status(Some("session-a"), Some("nonce-a"));

        assert_eq!(
            classify_runtime_session_status(&status, "session-a", "nonce-a"),
            RuntimeSessionStatusDisposition::MatchRequested
        );
    }

    #[test]
    fn reclaims_existing_runtime_session_status_when_node_reports_a_different_live_session() {
        let status = app_session_online_status(Some("session-live"), Some("nonce-live"));

        assert_eq!(
            classify_runtime_session_status(&status, "session-new", "nonce-new"),
            RuntimeSessionStatusDisposition::ReclaimExisting {
                session_id: "session-live".to_string(),
                session_nonce: "nonce-live".to_string(),
            }
        );
    }

    #[test]
    fn ignores_incomplete_runtime_session_status_payloads() {
        let missing_nonce = app_session_online_status(Some("session-live"), None);
        let ready_status = RuntimeStatusPayload {
            status_type: "ready".to_string(),
            device_id: Some("node-1".to_string()),
            boot_id: None,
            boot_uptime_ms: Some(123),
            session_id: None,
            session_nonce: None,
            firmware_version: None,
            hardware_id: None,
            phase: None,
            message: None,
            version: None,
        };

        assert_eq!(
            classify_runtime_session_status(&missing_nonce, "session-new", "nonce-new"),
            RuntimeSessionStatusDisposition::Ignore
        );
        assert_eq!(
            classify_runtime_session_status(&ready_status, "session-new", "nonce-new"),
            RuntimeSessionStatusDisposition::Ignore
        );
    }
}
