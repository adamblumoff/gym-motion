use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use tokio::{
    sync::{mpsc, watch, RwLock},
    task::JoinHandle,
};

use crate::protocol::{DiscoveredNode, HistorySyncCompletePayload, ReconnectStatus};

use super::{
    config::Config, handshake::ControlWriteLock, session_lease::spawn_lease_task,
    session_transport_history::recover_control_path_with_retry,
    session_transport_monitor_reporting::report_history_sync_ready, writer::EventWriter,
};

#[derive(Clone, Copy)]
pub(super) struct MonitorSessionConfig {
    pub(super) connection_health_poll_ms: u64,
    pub(super) session_health_ack_timeout_ms: u64,
    pub(super) history_sync_start_confirm_timeout_ms: u64,
    pub(super) session_bootstrap_retry_limit: u32,
    pub(super) session_telemetry_confirm_retry_limit: u32,
}

#[derive(Clone, Copy)]
pub(super) enum HistorySyncAttemptKind {
    Start,
    Continuation,
}

impl HistorySyncAttemptKind {
    pub(super) fn recovered_message(self) -> &'static str {
        match self {
            Self::Start => {
                "History replay start failed, but the runtime control path recovered; leaving the session online and pausing replay until a manual retry."
            }
            Self::Continuation => {
                "History replay start failed after ack, but the runtime control path recovered; leaving the session online and pausing replay until a manual retry."
            }
        }
    }

    pub(super) fn forced_reconnect_message(self) -> &'static str {
        match self {
            Self::Start => {
                "History replay start failed and control-path recovery did not succeed; forcing a clean reconnect."
            }
            Self::Continuation => {
                "History replay start failed after ack and control-path recovery did not succeed; forcing a clean reconnect."
            }
        }
    }

    pub(super) fn deferred_message(self) -> &'static str {
        match self {
            Self::Start => {
                "History replay start failed; leaving the session online and deferring replay."
            }
            Self::Continuation => {
                "History replay start failed after ack; leaving the session online and pausing replay until a manual retry."
            }
        }
    }

    pub(super) fn forced_reconnect_reason(self, node_label: &str) -> String {
        match self {
            Self::Start => format!(
                "History replay start failed during active-session recovery for {}; forcing reconnect.",
                node_label
            ),
            Self::Continuation => format!(
                "History replay continuation failed during active-session recovery for {}; forcing reconnect.",
                node_label
            ),
        }
    }
}

pub(super) struct PendingHistorySyncStart {
    pub(super) request_id: String,
    pub(super) after_sequence: u64,
    pub(super) max_records: usize,
    pub(super) error_message: String,
    pub(super) attempt_kind: HistorySyncAttemptKind,
}

pub(super) async fn enrich_node_with_device_id(
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

pub(super) fn known_device_id_for_node(
    ack_confirmed_node: &Option<DiscoveredNode>,
    node: &DiscoveredNode,
) -> Option<String> {
    ack_confirmed_node
        .as_ref()
        .and_then(|current| current.known_device_id.clone())
        .or_else(|| node.known_device_id.clone())
}

pub(super) async fn report_history_sync_ready_if_needed(
    writer: &EventWriter,
    node: &DiscoveredNode,
    session_healthy_reported: bool,
    steady_state_lease_confirmed: bool,
    history_sync_ready_reported: &mut bool,
) -> Result<()> {
    if !session_healthy_reported || !steady_state_lease_confirmed || *history_sync_ready_reported {
        return Ok(());
    }

    report_history_sync_ready(writer, node).await?;
    *history_sync_ready_reported = true;
    Ok(())
}

pub(super) fn spawn_active_lease_task(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    control_characteristic: &btleplug::api::Characteristic,
    app_session_id: &str,
) -> (
    watch::Sender<bool>,
    mpsc::UnboundedReceiver<()>,
    mpsc::UnboundedReceiver<String>,
    JoinHandle<()>,
) {
    spawn_lease_task(
        control_write_lock.clone(),
        peripheral.clone(),
        control_characteristic.clone(),
        app_session_id.to_string(),
    )
}

pub(super) fn replace_active_lease_task(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    control_characteristic: &btleplug::api::Characteristic,
    app_session_id: &str,
    lease_shutdown_tx: &mut watch::Sender<bool>,
    lease_success_rx: &mut mpsc::UnboundedReceiver<()>,
    lease_failure_rx: &mut mpsc::UnboundedReceiver<String>,
    lease_task: &mut Option<JoinHandle<()>>,
) {
    let (new_shutdown_tx, new_success_rx, new_failure_rx, new_lease_task) = spawn_active_lease_task(
        control_write_lock,
        peripheral,
        control_characteristic,
        app_session_id,
    );
    *lease_shutdown_tx = new_shutdown_tx;
    *lease_success_rx = new_success_rx;
    *lease_failure_rx = new_failure_rx;
    *lease_task = Some(new_lease_task);
}

pub(super) enum PendingHistorySyncTimeoutOutcome {
    Recovered(btleplug::api::Characteristic),
    ReconnectRequired(String),
}

pub(super) async fn handle_pending_history_sync_timeout(
    control_write_lock: &ControlWriteLock,
    peripheral: &btleplug::platform::Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    config: &Config,
    app_session_id: &str,
    app_session_nonce: &str,
    pending: PendingHistorySyncStart,
    ack_confirmed_node: &Option<DiscoveredNode>,
) -> Result<PendingHistorySyncTimeoutOutcome> {
    let known_device_id = known_device_id_for_node(ack_confirmed_node, node);

    match recover_control_path_with_retry(
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
        Ok(recovered_control_characteristic) => {
            writer
                .send(&crate::protocol::Event::Log {
                    level: "warn".to_string(),
                    message: pending.attempt_kind.recovered_message().to_string(),
                    details: Some(serde_json::json!({
                        "peripheralId": node.peripheral_id,
                        "knownDeviceId": known_device_id,
                        "address": node.address,
                        "requestId": pending.request_id,
                        "afterSequence": pending.after_sequence,
                        "maxRecords": pending.max_records,
                        "error": pending.error_message,
                    })),
                })
                .await?;
            Ok(PendingHistorySyncTimeoutOutcome::Recovered(
                recovered_control_characteristic,
            ))
        }
        Err(recovery_error) => {
            writer
                .send(&crate::protocol::Event::Log {
                    level: "warn".to_string(),
                    message: pending.attempt_kind.forced_reconnect_message().to_string(),
                    details: Some(serde_json::json!({
                        "peripheralId": node.peripheral_id,
                        "knownDeviceId": known_device_id,
                        "address": node.address,
                        "requestId": pending.request_id,
                        "afterSequence": pending.after_sequence,
                        "maxRecords": pending.max_records,
                        "error": pending.error_message,
                        "recoveryError": format!("{:#}", recovery_error),
                    })),
                })
                .await?;
            Ok(PendingHistorySyncTimeoutOutcome::ReconnectRequired(
                pending.attempt_kind.forced_reconnect_reason(&node.label),
            ))
        }
    }
}

pub(super) fn pending_history_sync_matches_ready(
    pending_history_sync_start: &Option<PendingHistorySyncStart>,
    request_id: &str,
) -> bool {
    pending_history_sync_start
        .as_ref()
        .map(|pending| pending.request_id == request_id)
        .unwrap_or(false)
}

pub(super) fn pending_history_sync_matches_complete(
    pending_history_sync_start: &Option<PendingHistorySyncStart>,
    history_complete: &HistorySyncCompletePayload,
) -> bool {
    pending_history_sync_start
        .as_ref()
        .map(|pending| {
            history_complete
                .request_id
                .as_deref()
                .map(|request_id| request_id == pending.request_id)
                .unwrap_or(true)
        })
        .unwrap_or(false)
}

pub(super) async fn accept_pending_history_sync_start(
    writer: &EventWriter,
    node: &DiscoveredNode,
    ack_confirmed_node: &Option<DiscoveredNode>,
    pending_history_sync_start: &mut Option<PendingHistorySyncStart>,
    accepted_via: &str,
    message: &str,
) -> Result<()> {
    let Some(pending) = pending_history_sync_start.take() else {
        return Ok(());
    };

    writer
        .send(&crate::protocol::Event::Log {
            level: "info".to_string(),
            message: message.to_string(),
            details: Some(serde_json::json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": known_device_id_for_node(ack_confirmed_node, node),
                "address": node.address,
                "requestId": pending.request_id,
                "afterSequence": pending.after_sequence,
                "maxRecords": pending.max_records,
                "acceptedVia": accepted_via,
                "error": pending.error_message,
            })),
        })
        .await?;

    Ok(())
}

pub(super) async fn log_ignored_history_sync_request(
    writer: &EventWriter,
    node: &DiscoveredNode,
    ack_confirmed_node: &Option<DiscoveredNode>,
    message: &str,
    after_sequence: u64,
    max_records: usize,
) -> Result<()> {
    writer
        .send(&crate::protocol::Event::Log {
            level: "warn".to_string(),
            message: message.to_string(),
            details: Some(serde_json::json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": known_device_id_for_node(ack_confirmed_node, node),
                "address": node.address,
                "afterSequence": after_sequence,
                "maxRecords": max_records,
            })),
        })
        .await?;

    Ok(())
}

pub(super) fn should_wait_for_history_sync_confirmation(error_message: &str) -> bool {
    error_message.contains("chunked control write failed")
        || error_message.contains("Windows UWP threw error on write")
}

#[cfg(test)]
mod tests {
    use super::should_wait_for_history_sync_confirmation;

    #[test]
    fn waits_for_confirmation_on_closed_handle_start_errors() {
        assert!(should_wait_for_history_sync_confirmation(
            r#"history-sync-begin failed for GymMotion-f4e9d4: chunked control write failed without retry: Error { code: HRESULT(0x80000013), message: "The object has been closed." }"#
        ));
    }

    #[test]
    fn waits_for_confirmation_on_unreachable_start_errors() {
        assert!(should_wait_for_history_sync_confirmation(
            "history-sync-begin failed for GymMotion-f4e9d4: chunked control write failed without retry: Windows UWP threw error on write: status=Unreachable"
        ));
    }

    #[test]
    fn does_not_wait_for_unrelated_errors() {
        assert!(!should_wait_for_history_sync_confirmation(
            "history-sync-begin failed for GymMotion-f4e9d4: malformed payload"
        ));
    }
}
