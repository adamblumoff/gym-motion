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
use uuid::Uuid;

use crate::{
    json_decoder::JsonObjectDecoder,
    protocol::{
        ApprovedNodeRule, DiscoveredNode, Event, HistoryRecordStatusPayload,
        HistorySyncCompletePayload, HistorySyncReadyPayload, ReconnectStatus, RuntimeStatusPayload,
        TelemetryPayload,
    },
};

use super::{
    approval::is_approved,
    config::Config,
    handshake::{
        new_control_write_lock, send_app_session_bootstrap_locked, send_app_session_lease_locked,
        write_chunked_json_command_locked,
    },
    session_lease::is_closed_handle_error_message,
    session_transport_history::{
        force_reconnect_after_recovery_failure, recover_control_path_with_retry, send_history_ack,
        send_history_sync_begin,
    },
    session_transport_monitor_helpers::{
        accept_pending_history_sync_start, enrich_node_with_device_id,
        handle_pending_history_sync_timeout, known_device_id_for_node,
        log_ignored_history_sync_request, pending_history_sync_matches_complete,
        pending_history_sync_matches_ready, replace_active_lease_task,
        report_history_sync_ready_if_needed, spawn_active_lease_task, HistorySyncAttemptKind,
        MonitorSessionConfig, PendingHistorySyncStart, PendingHistorySyncTimeoutOutcome,
    },
    session_transport_monitor_reporting::report_reconnect_completed,
    session_transport_recovery::emit_handshake_step,
    session_transport_setup::PreparedSession,
    session_types::{ActiveSessionCommand, SessionCommand},
    writer::EventWriter,
};

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
    let mut steady_state_lease_confirmed = false;
    let mut history_sync_ready_reported = false;
    let mut pending_history_sync_start: Option<PendingHistorySyncStart> = None;
    let mut current_control_characteristic = prepared.control_characteristic;
    let control_write_lock = new_control_write_lock();
    let pending_history_sync_sleep = sleep(Duration::from_secs(24 * 60 * 60));
    tokio::pin!(pending_history_sync_sleep);
    let (mut lease_shutdown_tx, mut lease_success_rx, mut lease_failure_rx, lease_task) =
        spawn_active_lease_task(
            &control_write_lock,
            &prepared.peripheral,
            &current_control_characteristic,
            &app_session_id,
        );
    let mut lease_task = Some(lease_task);

    loop {
        tokio::select! {
            changed = session_shutdown.changed() => {
                if changed.is_ok() && *session_shutdown.borrow() {
                    let _ = lease_shutdown_tx.send(true);
                    if let Some(task) = lease_task.take() {
                        let _ = task.await;
                    }
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
                                        if let Err(error) = write_chunked_json_command_locked(
                                            &control_write_lock,
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
                                    "history-sync-ready" => {
                                        match serde_json::from_value::<HistorySyncReadyPayload>(
                                            payload_clone,
                                        ) {
                                            Ok(history_ready) => {
                                                if pending_history_sync_matches_ready(
                                                    &pending_history_sync_start,
                                                    &history_ready.request_id,
                                                ) {
                                                    accept_pending_history_sync_start(
                                                        &writer,
                                                        &node,
                                                        &ack_confirmed_node,
                                                        &mut pending_history_sync_start,
                                                        "history-sync-ready",
                                                        "History replay start write hit a transient WinRT handle failure, but the device acknowledged the request; continuing replay on the current session.",
                                                    )
                                                    .await?;
                                                }
                                            }
                                            Err(error) => {
                                                writer
                                                    .error(
                                                        format!("Failed to parse history sync ready payload: {error}"),
                                                        Some(json!({ "node": node.id })),
                                                    )
                                                    .await;
                                            }
                                        }
                                    }
                                    "history-record" => {
                                        match serde_json::from_value::<HistoryRecordStatusPayload>(payload_clone) {
                                            Ok(history_record) => {
                                                accept_pending_history_sync_start(
                                                    &writer,
                                                    &node,
                                                    &ack_confirmed_node,
                                                    &mut pending_history_sync_start,
                                                    "history-record",
                                                    "History replay start write hit a transient WinRT handle failure, but the device began streaming records; continuing replay on the current session.",
                                                )
                                                .await?;
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
                                                if pending_history_sync_matches_complete(
                                                    &pending_history_sync_start,
                                                    &history_complete,
                                                ) {
                                                    accept_pending_history_sync_start(
                                                        &writer,
                                                        &node,
                                                        &ack_confirmed_node,
                                                        &mut pending_history_sync_start,
                                                        "history-sync-complete",
                                                        "History replay start write hit a transient WinRT handle failure, but the device completed the page; continuing replay on the current session.",
                                                    )
                                                    .await?;
                                                }
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
                                report_history_sync_ready_if_needed(
                                    &writer,
                                    &completed_node,
                                    session_healthy_reported,
                                    steady_state_lease_confirmed,
                                    &mut history_sync_ready_reported,
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
                            log_ignored_history_sync_request(
                                &writer,
                                &node,
                                &ack_confirmed_node,
                                "Ignoring history sync request until the active session is healthy.",
                                after_sequence,
                                max_records,
                            )
                            .await?;
                            continue;
                        }

                        if !steady_state_lease_confirmed {
                            log_ignored_history_sync_request(
                                &writer,
                                &node,
                                &ack_confirmed_node,
                                "Ignoring history sync request until the active session confirms a steady-state lease heartbeat.",
                                after_sequence,
                                max_records,
                            )
                            .await?;
                            continue;
                        }

                        if pending_history_sync_start.is_some() {
                            log_ignored_history_sync_request(
                                &writer,
                                &node,
                                &ack_confirmed_node,
                                "Ignoring history sync request while a previous replay start is still waiting for device-side confirmation.",
                                after_sequence,
                                max_records,
                            )
                            .await?;
                            continue;
                        }

                        let request_id = Uuid::new_v4().to_string();

                        if let Err(error) = send_history_sync_begin(
                            &control_write_lock,
                            &prepared.peripheral,
                            &current_control_characteristic,
                            &node,
                            &request_id,
                            after_sequence,
                            max_records,
                        )
                        .await
                        {
                            let error_message = format!("{:#}", error);

                            if is_closed_handle_error_message(&error_message) {
                                pending_history_sync_start = Some(PendingHistorySyncStart {
                                    request_id,
                                    after_sequence,
                                    max_records,
                                    error_message: error_message.clone(),
                                    attempt_kind: HistorySyncAttemptKind::Start,
                                });
                                pending_history_sync_sleep.as_mut().reset(
                                    (Instant::now()
                                        + Duration::from_millis(
                                            monitor_config.history_sync_start_confirm_timeout_ms,
                                        ))
                                    .into(),
                                );
                                writer
                                    .send(&Event::Log {
                                        level: "warn".to_string(),
                                        message: "History replay start write hit a transient WinRT handle failure; waiting briefly for device-side confirmation before forcing recovery.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": known_device_id_for_node(&ack_confirmed_node, &node),
                                            "address": node.address,
                                            "requestId": pending_history_sync_start.as_ref().map(|pending| pending.request_id.clone()),
                                            "afterSequence": after_sequence,
                                            "maxRecords": max_records,
                                            "confirmTimeoutMs": monitor_config.history_sync_start_confirm_timeout_ms,
                                            "error": error_message,
                                        })),
                                    })
                                    .await?;
                                continue;
                            }

                            writer
                                .send(&Event::Log {
                                    level: "warn".to_string(),
                                    message: HistorySyncAttemptKind::Start.deferred_message().to_string(),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": known_device_id_for_node(&ack_confirmed_node, &node),
                                        "address": node.address,
                                        "afterSequence": after_sequence,
                                        "maxRecords": max_records,
                                        "error": error_message,
                                    })),
                                })
                                .await?;
                        }
                    }
                    ActiveSessionCommand::AckHistorySync {
                        sequence,
                        continue_after_sequence,
                        max_records,
                    } => {
                        let known_device_id = known_device_id_for_node(&ack_confirmed_node, &node);

                        if let Err(error) = send_history_ack(
                            &control_write_lock,
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
                                let _ = lease_shutdown_tx.send(true);
                                if let Some(task) = lease_task.take() {
                                    let _ = task.await;
                                }
                                match recover_control_path_with_retry(
                                    &control_write_lock,
                                    &prepared.peripheral,
                                    &writer,
                                    &node,
                                    &reconnect,
                                    &config,
                                    &app_session_id,
                                    &app_session_nonce,
                                )
                                .await
                                {
                                    Ok(recovered_control_characteristic) => {
                                        current_control_characteristic = recovered_control_characteristic;
                                        steady_state_lease_confirmed = false;
                                        replace_active_lease_task(
                                            &control_write_lock,
                                            &prepared.peripheral,
                                            &current_control_characteristic,
                                            &app_session_id,
                                            &mut lease_shutdown_tx,
                                            &mut lease_success_rx,
                                            &mut lease_failure_rx,
                                            &mut lease_task,
                                        );

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
                                                message: "History replay ack failed and control-path recovery did not succeed; forcing a clean reconnect.".to_string(),
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
                                        return Ok(Some(
                                            force_reconnect_after_recovery_failure(
                                                &prepared.peripheral,
                                                &writer,
                                                &node,
                                                &reconnect,
                                                &format!(
                                                    "History replay ack failed during active-session recovery for {}; forcing reconnect.",
                                                    node.label
                                                ),
                                            )
                                            .await?,
                                        ));
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

                            continue;
                        }

                        if let Some(next_after_sequence) = continue_after_sequence {
                            let next_max_records = max_records.unwrap_or(250);
                            let request_id = Uuid::new_v4().to_string();

                            if let Err(error) = send_history_sync_begin(
                                &control_write_lock,
                                &prepared.peripheral,
                                &current_control_characteristic,
                                &node,
                                &request_id,
                                next_after_sequence,
                                next_max_records,
                            )
                            .await
                            {
                                let error_message = format!("{:#}", error);

                                if is_closed_handle_error_message(&error_message) {
                                    pending_history_sync_start = Some(PendingHistorySyncStart {
                                        request_id,
                                        after_sequence: next_after_sequence,
                                        max_records: next_max_records,
                                        error_message: error_message.clone(),
                                        attempt_kind: HistorySyncAttemptKind::Continuation,
                                    });
                                    pending_history_sync_sleep.as_mut().reset(
                                        (Instant::now()
                                            + Duration::from_millis(
                                                monitor_config.history_sync_start_confirm_timeout_ms,
                                            ))
                                        .into(),
                                    );
                                    writer
                                        .send(&Event::Log {
                                            level: "warn".to_string(),
                                            message: "History replay continuation write hit a transient WinRT handle failure; waiting briefly for device-side confirmation before forcing recovery.".to_string(),
                                            details: Some(json!({
                                                "peripheralId": node.peripheral_id,
                                                "knownDeviceId": known_device_id,
                                                "address": node.address,
                                                "requestId": pending_history_sync_start.as_ref().map(|pending| pending.request_id.clone()),
                                                "afterSequence": next_after_sequence,
                                                "maxRecords": next_max_records,
                                                "confirmTimeoutMs": monitor_config.history_sync_start_confirm_timeout_ms,
                                                "error": error_message,
                                            })),
                                        })
                                        .await?;
                                    continue;
                                }

                                writer
                                    .send(&Event::Log {
                                        level: "warn".to_string(),
                                        message: HistorySyncAttemptKind::Continuation
                                            .deferred_message()
                                            .to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": known_device_id,
                                            "address": node.address,
                                            "afterSequence": next_after_sequence,
                                            "maxRecords": next_max_records,
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
                        write_chunked_json_command_locked(
                            &control_write_lock,
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
                    send_app_session_bootstrap_locked(
                        &control_write_lock,
                        &prepared.peripheral,
                        &current_control_characteristic,
                        &app_session_nonce,
                    )
                    .await
                    .with_context(|| {
                        format!("app-session-bootstrap retry failed for {}", node.label)
                    })?;
                    send_app_session_lease_locked(
                        &control_write_lock,
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
                report_history_sync_ready_if_needed(
                    &writer,
                    &enriched,
                    session_healthy_reported,
                    steady_state_lease_confirmed,
                    &mut history_sync_ready_reported,
                )
                .await?;
            }
            Some(()) = lease_success_rx.recv() => {
                steady_state_lease_confirmed = true;
                let ready_node = ack_confirmed_node
                    .clone()
                    .or_else(|| telemetry_fallback_node.clone())
                    .unwrap_or_else(|| node.clone());
                report_history_sync_ready_if_needed(
                    &writer,
                    &ready_node,
                    session_healthy_reported,
                    steady_state_lease_confirmed,
                    &mut history_sync_ready_reported,
                )
                .await?;
            }
            _ = &mut pending_history_sync_sleep, if pending_history_sync_start.is_some() => {
                let pending = pending_history_sync_start
                    .take()
                    .expect("pending history sync start should exist");

                let _ = lease_shutdown_tx.send(true);
                if let Some(task) = lease_task.take() {
                    let _ = task.await;
                }
                match handle_pending_history_sync_timeout(
                    &control_write_lock,
                    &prepared.peripheral,
                    &writer,
                    &node,
                    &reconnect,
                    &config,
                    &app_session_id,
                    &app_session_nonce,
                    pending,
                    &ack_confirmed_node,
                )
                .await?
                {
                    PendingHistorySyncTimeoutOutcome::Recovered(recovered_control_characteristic) => {
                        current_control_characteristic = recovered_control_characteristic;
                        steady_state_lease_confirmed = false;
                        replace_active_lease_task(
                            &control_write_lock,
                            &prepared.peripheral,
                            &current_control_characteristic,
                            &app_session_id,
                            &mut lease_shutdown_tx,
                            &mut lease_success_rx,
                            &mut lease_failure_rx,
                            &mut lease_task,
                        );
                    }
                    PendingHistorySyncTimeoutOutcome::ReconnectRequired(reason) => {
                        return Ok(Some(
                            force_reconnect_after_recovery_failure(
                                &prepared.peripheral,
                                &writer,
                                &node,
                                &reconnect,
                                &reason,
                            )
                            .await?,
                        ));
                    }
                }
            }
            _ = sleep(Duration::from_millis(monitor_config.connection_health_poll_ms)) => {
                if !is_approved(&node, &allowed_nodes.read().await) {
                    let _ = lease_shutdown_tx.send(true);
                    if let Some(task) = lease_task.take() {
                        let _ = task.await;
                    }
                    if prepared.peripheral.is_connected().await.unwrap_or(false) {
                        let _ = prepared.peripheral.disconnect().await;
                    }
                    return Ok(Some(format!("{} was removed from allowed nodes.", node.label)));
                }
                if !prepared.peripheral.is_connected().await.unwrap_or(false) {
                    let _ = lease_shutdown_tx.send(true);
                    if let Some(task) = lease_task.take() {
                        let _ = task.await;
                    }
                    return Ok(Some(format!("BLE transport ended for {}.", node.label)));
                }
            }
            Some(reason) = lease_failure_rx.recv() => {
                let _ = lease_shutdown_tx.send(true);
                if let Some(task) = lease_task.take() {
                    let _ = task.await;
                }
                if is_closed_handle_error_message(&reason) {
                    match recover_control_path_with_retry(
                        &control_write_lock,
                        &prepared.peripheral,
                        &writer,
                        &node,
                        &reconnect,
                        &config,
                        &app_session_id,
                        &app_session_nonce,
                    )
                    .await
                    {
                        Ok(recovered_control_characteristic) => {
                            current_control_characteristic = recovered_control_characteristic;
                            steady_state_lease_confirmed = false;
                            replace_active_lease_task(
                                &control_write_lock,
                                &prepared.peripheral,
                                &current_control_characteristic,
                                &app_session_id,
                                &mut lease_shutdown_tx,
                                &mut lease_success_rx,
                                &mut lease_failure_rx,
                                &mut lease_task,
                            );
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
    if let Some(task) = lease_task.take() {
        let _ = task.await;
    }

    if prepared.peripheral.is_connected().await.unwrap_or(false) {
        let _ = prepared.peripheral.disconnect().await;
        sleep(Duration::from_millis(100)).await;
    }

    Ok(None)
}
