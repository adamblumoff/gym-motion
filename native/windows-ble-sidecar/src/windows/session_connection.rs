use std::time::Instant;

use anyhow::Result;
use btleplug::{
    api::{Central, Peripheral as _},
    platform::{Adapter, Peripheral},
};
use serde_json::json;
use tokio::sync::watch;

use crate::protocol::{ApprovedNodeRule, DiscoveredNode, Event, ReconnectStatus};

use super::{
    approval::{
        allow_approved_identity_fallback, approved_rule_id_for_node, next_reconnect_attempt,
        reconnect_candidate_ready, ApprovedReconnectState, DiscoveryClassification,
        RECONNECT_ATTEMPT_LIMIT,
    },
    discovery::{discovery_candidate_from_peripheral, DiscoveryCandidate},
    session::{SessionContext, SessionState},
    session_scan::emit_gateway_state,
    session_transport::connect_and_stream,
    session_types::SessionCommand,
};

pub(super) fn explicit_connect_candidate_ready(
    classification: &DiscoveryClassification,
    local_name_present: bool,
    allow_name_prefix_connect: bool,
) -> bool {
    reconnect_candidate_ready(classification, local_name_present, None)
        || (allow_name_prefix_connect && classification.name_prefix_matched)
}

pub(super) async fn peripheral_for_event(
    context: &SessionContext,
    event_name: &str,
    id: &btleplug::platform::PeripheralId,
) -> Option<Peripheral> {
    match context.adapter.peripheral(id).await {
        Ok(peripheral) => Some(peripheral),
        Err(error) => {
            context
                .writer
                .send(&Event::Log {
                    level: "warn".to_string(),
                    message: format!(
                        "Skipping {event_name} event because the BLE device is no longer available: {error}"
                    ),
                    details: Some(json!({
                        "event": event_name,
                        "peripheralId": id.to_string(),
                    })),
                })
                .await
                .ok();
            None
        }
    }
}

pub(super) async fn peripheral_for_node(
    adapter: &Adapter,
    node: &DiscoveredNode,
) -> Option<Peripheral> {
    let target_id = node.peripheral_id.as_deref()?;
    let peripherals = adapter.peripherals().await.ok()?;

    peripherals
        .into_iter()
        .find(|peripheral| peripheral.id().to_string() == target_id)
}

pub(super) async fn disconnect_nodes_for_shutdown(
    context: &SessionContext,
    nodes: &[DiscoveredNode],
) {
    for node in nodes {
        let Some(peripheral) = peripheral_for_node(&context.adapter, node).await else {
            continue;
        };

        if !peripheral.is_connected().await.unwrap_or(false) {
            continue;
        }

        let _ = context
            .writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: format!(
                    "Disconnecting {} during Windows BLE runtime shutdown.",
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
    }
}

pub(super) async fn discovery_candidate_for_event(
    context: &SessionContext,
    event_name: &str,
    peripheral: &Peripheral,
    allowed: &[ApprovedNodeRule],
    allow_approved_identity_fallback: bool,
) -> Option<DiscoveryCandidate> {
    match discovery_candidate_from_peripheral(
        peripheral,
        &context.config,
        allowed,
        &context.known_device_ids,
        allow_approved_identity_fallback,
    )
    .await
    {
        Ok(node) => node,
        Err(error) => {
            context
                .writer
                .send(&Event::Log {
                    level: "warn".to_string(),
                    message: format!(
                        "Skipping {event_name} event because discovery data could not be refreshed: {error}"
                    ),
                    details: Some(json!({
                        "event": event_name,
                        "peripheralId": peripheral.id().to_string(),
                    })),
                })
                .await
                .ok();
            None
        }
    }
}

pub(super) async fn spawn_reconnect_for_discovered_node(
    context: &SessionContext,
    state: &mut SessionState,
    shutdown: &watch::Receiver<bool>,
    peripheral: Peripheral,
    node: DiscoveredNode,
    advertised_session_id: Option<String>,
    rule_id: String,
    next_attempt: u32,
    reconnect_log_message: String,
    reconnect_log_details: serde_json::Value,
    manual_recovery: bool,
) -> Result<bool> {
    let key = node
        .peripheral_id
        .clone()
        .unwrap_or_else(|| node.id.clone());
    let mut active = context.active_connections.lock().await;

    if active.contains_key(&key) {
        return Ok(false);
    }

    context
        .writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: reconnect_log_message,
            details: Some(reconnect_log_details),
        })
        .await?;

    state.reconnect_states.insert(
        rule_id,
        ApprovedReconnectState {
            attempt: next_attempt,
            retry_exhausted: false,
            awaiting_user_decision: false,
        },
    );

    if state.scanning {
        let _ = context.adapter.stop_scan().await;
        state.scanning = false;
        state.current_scan_reason = None;
        context
            .writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: "Pausing BLE scan while reconnect handshake is in flight.".to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnectAttempt": next_attempt,
                })),
            })
            .await?;
        emit_gateway_state(context, state, "stopped", None).await?;
        state.last_scan_progress_at = None;
        state.startup_burst_deadline = None;
    }

    active.insert(key.clone(), node.clone());
    drop(active);

    let writer_clone = context.writer.clone();
    let config_clone = context.config.clone();
    let allowed_nodes_clone = context.allowed_nodes.clone();
    let active_connections_clone = context.active_connections.clone();
    let active_session_controls_clone = context.active_session_controls.clone();
    let known_device_ids_clone = context.known_device_ids.clone();
    let command_tx_clone = context.command_sender.clone();
    let shutdown_clone = shutdown.clone();
    let node_for_task = node.clone();

    tokio::spawn(async move {
        let result = connect_and_stream(
            peripheral,
            node_for_task.clone(),
            advertised_session_id,
            writer_clone.clone(),
            config_clone,
            allowed_nodes_clone,
            active_session_controls_clone,
            known_device_ids_clone,
            Some(ReconnectStatus {
                attempt: next_attempt,
                attempt_limit: RECONNECT_ATTEMPT_LIMIT,
                retry_exhausted: false,
                awaiting_user_decision: false,
            }),
            shutdown_clone,
            command_tx_clone.clone(),
        )
        .await;

        match result {
            Ok(Some(reason)) => {
                let _ = writer_clone
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: reason.clone(),
                        details: Some(json!({
                            "peripheralId": node_for_task.peripheral_id,
                            "knownDeviceId": node_for_task.known_device_id,
                            "address": node_for_task.address,
                        })),
                    })
                    .await;
                let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                    node: node_for_task,
                    reason: if manual_recovery {
                        format!("manual recovery failed: {reason}")
                    } else {
                        reason
                    },
                });
            }
            Ok(None) => {
                let _ = command_tx_clone.send(SessionCommand::ConnectionHealthy {
                    node: node_for_task,
                });
            }
            Err(error) => {
                let message = format!("BLE connect failed: {error}");
                let _ = writer_clone
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: message.clone(),
                        details: Some(json!({
                            "peripheralId": node_for_task.peripheral_id,
                            "knownDeviceId": node_for_task.known_device_id,
                            "address": node_for_task.address,
                        })),
                    })
                    .await;
                let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                    node: node_for_task,
                    reason: if manual_recovery {
                        format!("manual recovery failed: {}", error)
                    } else {
                        error.to_string()
                    },
                });
            }
        }

        active_connections_clone.lock().await.remove(&key);
    });

    Ok(true)
}

pub(super) async fn spawn_manual_pair_for_candidate(
    context: &SessionContext,
    state: &mut SessionState,
    shutdown: &watch::Receiver<bool>,
    peripheral: Peripheral,
    node: DiscoveredNode,
) -> Result<bool> {
    let key = node
        .peripheral_id
        .clone()
        .unwrap_or_else(|| node.id.clone());
    let mut active = context.active_connections.lock().await;

    if active.contains_key(&key) {
        return Ok(false);
    }

    context
        .writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: format!("Starting manual pair-and-connect for {}.", node.label),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "manualPair": true,
            })),
        })
        .await?;

    if state.scanning {
        let _ = context.adapter.stop_scan().await;
        state.scanning = false;
        state.current_scan_reason = None;
        context
            .writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: "Pausing BLE scan while manual pairing is in flight.".to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "manualPair": true,
                })),
            })
            .await?;
        emit_gateway_state(context, state, "stopped", None).await?;
        state.last_scan_progress_at = None;
        state.startup_burst_deadline = None;
    }

    active.insert(key.clone(), node.clone());
    drop(active);

    let writer_clone = context.writer.clone();
    let config_clone = context.config.clone();
    let allowed_nodes_clone = context.allowed_nodes.clone();
    let active_connections_clone = context.active_connections.clone();
    let active_session_controls_clone = context.active_session_controls.clone();
    let known_device_ids_clone = context.known_device_ids.clone();
    let command_tx_clone = context.command_sender.clone();
    let shutdown_clone = shutdown.clone();
    let node_for_task = node.clone();

    tokio::spawn(async move {
        let result = connect_and_stream(
            peripheral,
            node_for_task.clone(),
            None,
            writer_clone.clone(),
            config_clone,
            allowed_nodes_clone,
            active_session_controls_clone,
            known_device_ids_clone,
            None,
            shutdown_clone,
            command_tx_clone.clone(),
        )
        .await;

        match result {
            Ok(Some(reason)) => {
                let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                    node: node_for_task,
                    reason,
                });
            }
            Ok(None) => {}
            Err(error) => {
                let _ = writer_clone
                    .send(&Event::Log {
                        level: "warn".to_string(),
                        message: format!("Manual pair connect failed: {error}"),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "manualPair": true,
                        })),
                    })
                    .await;
                let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                    node: node_for_task,
                    reason: error.to_string(),
                });
            }
        }

        active_connections_clone.lock().await.remove(&key);
    });

    Ok(true)
}

pub(super) async fn recover_visible_approved_node(
    context: &SessionContext,
    state: &mut SessionState,
    shutdown: &watch::Receiver<bool>,
    rule_id: &str,
    manual_recovery: bool,
    allow_name_prefix_connect: bool,
) -> Result<bool> {
    let allowed = context.allowed_nodes.read().await.clone();
    let allow_identity_fallback = allow_approved_identity_fallback(
        &allowed,
        &state.connected_nodes,
        &state.reconnect_states,
        state.manual_scan_deadline,
        Instant::now(),
    );

    let peripherals = context.adapter.peripherals().await.unwrap_or_default();

    for peripheral in peripherals {
        let Some(candidate) = discovery_candidate_for_event(
            context,
            "manual_recover",
            &peripheral,
            &allowed,
            allow_identity_fallback,
        )
        .await
        else {
            continue;
        };

        if approved_rule_id_for_node(&candidate.node, &allowed).as_deref() != Some(rule_id) {
            continue;
        }

        if !explicit_connect_candidate_ready(
            &candidate.classification,
            candidate.node.local_name.is_some(),
            allow_name_prefix_connect,
        ) {
            continue;
        }

        let reconnect_state = state
            .reconnect_states
            .get(rule_id)
            .cloned()
            .unwrap_or_default();
        let key = candidate
            .node
            .peripheral_id
            .clone()
            .unwrap_or_else(|| candidate.node.id.clone());
        let active = context.active_connections.lock().await;
        let Some(next_attempt) =
            next_reconnect_attempt(&reconnect_state, active.contains_key(&key))
        else {
            continue;
        };
        drop(active);

        return spawn_reconnect_for_discovered_node(
            context,
            state,
            shutdown,
            peripheral,
            candidate.node.clone(),
            candidate.advertised_session_id.clone(),
            rule_id.to_string(),
            next_attempt,
            format!(
                "Approved node is already visible; starting immediate reconnect for {}.",
                candidate.node.label
            ),
            json!({
                "peripheralId": candidate.node.peripheral_id,
                "knownDeviceId": candidate.node.known_device_id,
                "address": candidate.node.address,
                "reconnectAttempt": next_attempt,
                "runtimeServiceMatched": candidate.classification.runtime_service_matched,
                "approvedIdentityMatched": candidate.classification.approved_identity_matched,
                "namePrefixMatched": candidate.classification.name_prefix_matched,
                "advertisedSessionId": candidate.advertised_session_id,
                "manualRecovery": manual_recovery,
                "operatorVisibleDirectConnect": allow_name_prefix_connect,
                "immediateVisibleMatch": true,
            }),
            manual_recovery,
        )
        .await;
    }

    Ok(false)
}

pub(super) async fn emit_visible_manual_candidates(
    context: &SessionContext,
    state: &mut SessionState,
) -> Result<()> {
    let allowed = context.allowed_nodes.read().await.clone();
    let allow_identity_fallback = allow_approved_identity_fallback(
        &allowed,
        &state.connected_nodes,
        &state.reconnect_states,
        state.manual_scan_deadline,
        Instant::now(),
    );
    let peripherals = context.adapter.peripherals().await.unwrap_or_default();

    for peripheral in peripherals {
        let Some(candidate) = discovery_candidate_for_event(
            context,
            "manual_scan_visible",
            &peripheral,
            &allowed,
            allow_identity_fallback,
        )
        .await
        else {
            continue;
        };

        let node = candidate.node;
        if state.manual_candidates.contains_key(&node.id) {
            continue;
        }

        state.classified_candidates_this_burst =
            state.classified_candidates_this_burst.saturating_add(1);
        state.last_scan_progress_at = Some(Instant::now());
        state.last_advertisement_at = node.last_seen_at.clone();
        state
            .manual_candidates
            .insert(node.id.clone(), node.clone());
        context
            .writer
            .send(&Event::NodeDiscovered {
                node,
                scan_reason: Some("manual".to_string()),
            })
            .await?;
    }

    Ok(())
}
