use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::json;
use tokio::sync::watch;

use crate::protocol::{Event, ReconnectStatus};

use super::{
    approval::{
        approved_rule_id_for_node, disconnected_nodes_removed_from_allowed, mark_node_connected,
        prune_reconnect_states, RECONNECT_ATTEMPT_LIMIT,
    },
    session::{sync_current_scan_state, SessionContext, SessionState, SCAN_WINDOW_SECS},
    session_connection::{
        peripheral_for_node, recover_visible_approved_node, spawn_manual_pair_for_candidate,
    },
    session_scan::emit_manual_scan_state,
    session_types::SessionCommand,
};

pub(super) async fn handle_session_command(
    context: &SessionContext,
    state: &mut SessionState,
    shutdown: &watch::Receiver<bool>,
    command: SessionCommand,
) -> Result<()> {
    match command {
        SessionCommand::StartManualScan => {
            state.manual_scan_deadline =
                Some(Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
            state.manual_pair_candidate_id = None;
            state.manual_candidates.clear();
            emit_manual_scan_state(&context.writer, "scanning", None, None).await?;
        }
        SessionCommand::RefreshScanPolicy => {
            let allowed = context.allowed_nodes.read().await.clone();
            prune_reconnect_states(&mut state.reconnect_states, &allowed);
        }
        SessionCommand::PairManualCandidate { candidate_id } => {
            let Some(node) = state.manual_candidates.get(&candidate_id).cloned() else {
                emit_manual_scan_state(
                    &context.writer,
                    "failed",
                    Some(candidate_id),
                    Some(
                        "That scan result is no longer available. Start a new manual scan."
                            .to_string(),
                    ),
                )
                .await?;
                return Ok(());
            };
            let Some(peripheral) = peripheral_for_node(&context.adapter, &node).await else {
                emit_manual_scan_state(
                    &context.writer,
                    "failed",
                    Some(candidate_id),
                    Some(
                        "That BLE device is no longer available. Start a new manual scan."
                            .to_string(),
                    ),
                )
                .await?;
                return Ok(());
            };

            state.manual_pair_candidate_id = Some(candidate_id.clone());
            state.manual_scan_deadline = None;
            emit_manual_scan_state(&context.writer, "pairing", Some(candidate_id), None).await?;

            if spawn_manual_pair_for_candidate(context, state, shutdown, peripheral, node).await? {
                return Ok(());
            }
        }
        SessionCommand::RecoverApprovedNode { rule_id } => {
            let allowed = context.allowed_nodes.read().await.clone();
            let label = allowed
                .iter()
                .find(|rule| rule.id == rule_id)
                .map(|rule| rule.label.clone())
                .unwrap_or_else(|| rule_id.clone());
            state
                .reconnect_states
                .insert(rule_id.clone(), Default::default());
            state.manual_recover_rule_id = Some(rule_id.clone());
            state.manual_scan_deadline =
                Some(Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
            context
                .writer
                .send(&Event::Log {
                    level: "info".to_string(),
                    message: format!(
                        "Manual Windows recovery requested for {label}; resetting retry exhaustion and starting a targeted scan."
                    ),
                    details: Some(json!({
                        "ruleId": rule_id,
                        "manualRecovery": true,
                    })),
                })
                .await?;
            if recover_visible_approved_node(context, state, shutdown, &rule_id, true, true).await?
            {
                return Ok(());
            }
        }
        SessionCommand::ResumeApprovedNodeReconnect { rule_id } => {
            let allowed = context.allowed_nodes.read().await.clone();
            let label = allowed
                .iter()
                .find(|rule| rule.id == rule_id)
                .map(|rule| rule.label.clone())
                .unwrap_or_else(|| rule_id.clone());
            state
                .reconnect_states
                .insert(rule_id.clone(), Default::default());
            context
                .writer
                .send(&Event::Log {
                    level: "info".to_string(),
                    message: format!(
                        "Approved-node reconnect resumed for {label}; waiting for the next rediscovery window."
                    ),
                    details: Some(json!({
                        "ruleId": rule_id,
                        "manualRecovery": false,
                        "resumedAfterDecision": true,
                    })),
                })
                .await?;
            state.reconnect_scan_burst = 0;
        }
        SessionCommand::AllowedNodesUpdated {
            nodes: allowed,
            added_rule_ids,
        } => {
            prune_reconnect_states(&mut state.reconnect_states, &allowed);
            if state
                .manual_recover_rule_id
                .as_ref()
                .map(|rule_id| !allowed.iter().any(|rule| rule.id == *rule_id))
                .unwrap_or(false)
            {
                state.manual_recover_rule_id = None;
            }
            for node in disconnected_nodes_removed_from_allowed(&state.connected_nodes, &allowed) {
                if let Some(peripheral) = peripheral_for_node(&context.adapter, &node).await {
                    context
                        .writer
                        .send(&Event::Log {
                            level: "info".to_string(),
                            message: format!(
                                "Disconnecting {} because it was removed from allowed nodes.",
                                node.label
                            ),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                            })),
                        })
                        .await?;
                    let _ = peripheral.disconnect().await;
                }
            }
            let manual_scan_active = state
                .manual_scan_deadline
                .map(|deadline| deadline > Instant::now())
                .unwrap_or(false);

            if manual_scan_active || state.manual_pair_candidate_id.is_some() {
                return Ok(());
            }

            for rule_id in added_rule_ids {
                if state.connected_nodes.values().any(|node| {
                    approved_rule_id_for_node(node, &allowed).as_deref() == Some(rule_id.as_str())
                }) {
                    continue;
                }

                if recover_visible_approved_node(context, state, shutdown, &rule_id, false, false)
                    .await?
                {
                    break;
                }
            }
        }
        SessionCommand::ConnectionHealthy { node } => {
            let allowed = context.allowed_nodes.read().await.clone();
            if approved_rule_id_for_node(&node, &allowed)
                .as_ref()
                .zip(state.manual_recover_rule_id.as_ref())
                .map(|(left, right)| left == right)
                .unwrap_or(false)
            {
                state.manual_recover_rule_id = None;
            }
            mark_node_connected(
                &mut state.connected_nodes,
                &mut state.reconnect_states,
                &node,
                &allowed,
            );
            if state
                .manual_pair_candidate_id
                .as_ref()
                .map(|candidate_id| candidate_id == &node.id)
                .unwrap_or(false)
            {
                state.manual_pair_candidate_id = None;
                state.manual_scan_deadline = None;
                state.manual_candidates.clear();
                emit_manual_scan_state(&context.writer, "idle", None, None).await?;
            }
            state.reconnect_scan_burst = 0;
            sync_current_scan_state(context, state).await?;
            return Ok(());
        }
        SessionCommand::ConnectionEnded { node, reason } => {
            let key = node_key(&node);
            state.connected_nodes.remove(&key);
            let allowed = context.allowed_nodes.read().await.clone();
            let was_manual_pair = state
                .manual_pair_candidate_id
                .as_ref()
                .map(|candidate_id| candidate_id == &node.id)
                .unwrap_or(false);

            if was_manual_pair {
                state.manual_pair_candidate_id = None;
                emit_manual_scan_state(
                    &context.writer,
                    "failed",
                    Some(node.id.clone()),
                    Some(reason.clone()),
                )
                .await?;
            }

            let reconnect = approved_rule_id_for_node(&node, &allowed).map(|rule_id| {
                let state = state.reconnect_states.entry(rule_id).or_default();
                ReconnectStatus {
                    attempt: state.attempt,
                    attempt_limit: RECONNECT_ATTEMPT_LIMIT,
                    retry_exhausted: state.retry_exhausted,
                    awaiting_user_decision: state.awaiting_user_decision,
                }
            });
            if !was_manual_pair {
                context
                    .writer
                    .send(&Event::Log {
                        level: "info".to_string(),
                        message: format!(
                            "Approved-node disconnect for {}; resuming silent reconnect scan.",
                            node.label
                        ),
                        details: Some(json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "reason": reason,
                            "reconnect": reconnect,
                        })),
                    })
                    .await?;
            }
            context
                .writer
                .send(&Event::NodeConnectionState {
                    node,
                    gateway_connection_state: "disconnected".to_string(),
                    reason: Some(reason),
                    reconnect,
                })
                .await?;
            state.reconnect_scan_burst = 0;
            sync_current_scan_state(context, state).await?;
            return Ok(());
        }
    }

    sync_current_scan_state(context, state).await
}
