use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use anyhow::Result;
use btleplug::api::{Central, CentralState, ScanFilter};
use serde_json::json;

use crate::protocol::{ApprovedNodeRule, DiscoveredNode, Event, GatewayStatePayload};

use super::{
    approval::{
        approved_nodes_pending_connection, rule_matches_node, scan_reason,
        should_clear_reconnect_peripherals, should_scan, ApprovedReconnectState,
    },
    session::{SessionContext, SessionState},
    session_util::{emit_verbose_log, normalize_adapter_state},
    writer::EventWriter,
};

pub(super) const APPROVED_RECONNECT_DIAGNOSTIC_MS: u64 = 10_000;
pub(crate) const APPROVED_RECONNECT_STARTUP_BURST_MS: u64 = 5_000;
const APPROVED_RECONNECT_SCAN_RESTART_DELAY_MS: u64 = 300;

pub(super) async fn emit_gateway_state(
    context: &SessionContext,
    state: &SessionState,
    scan_state: &str,
    scan_reason: Option<&str>,
) -> Result<()> {
    context
        .writer
        .send(&Event::GatewayState {
            gateway: GatewayStatePayload {
                adapter_state: normalize_adapter_state(
                    context
                        .adapter
                        .adapter_state()
                        .await
                        .unwrap_or(CentralState::Unknown),
                ),
                scan_state: scan_state.to_string(),
                scan_reason: scan_reason.map(str::to_string),
                selected_adapter_id: Some(context.selected_adapter_id.clone()),
                last_advertisement_at: state.last_advertisement_at.clone(),
                issue: None,
            },
        })
        .await?;

    Ok(())
}

pub(super) async fn emit_manual_scan_state(
    writer: &EventWriter,
    state: &str,
    candidate_id: Option<String>,
    error: Option<String>,
) -> Result<()> {
    writer
        .send(&Event::ManualScanState {
            state: state.to_string(),
            candidate_id,
            error,
        })
        .await
}

pub(super) async fn sync_scan_state(
    context: &SessionContext,
    state: &mut SessionState,
    allowed: &[ApprovedNodeRule],
) -> Result<()> {
    let now = Instant::now();
    let should_scan_base = should_scan(
        allowed,
        &state.connected_nodes,
        &state.reconnect_states,
        state.manual_scan_deadline,
        now,
    );
    let approved_pending =
        approved_nodes_pending_connection(allowed, &state.connected_nodes, &state.reconnect_states);
    let next_scan_reason = scan_reason(
        allowed,
        &state.connected_nodes,
        &state.reconnect_states,
        state.manual_scan_deadline,
        now,
    );
    let active_connection_count = context.active_connections.lock().await.len();
    let should_scan_now =
        if should_pause_approved_reconnect_scan(next_scan_reason, active_connection_count) {
            false
        } else {
            should_scan_base
        };

    if should_scan_now && !state.scanning {
        context.adapter.start_scan(ScanFilter::default()).await?;
        state.scanning = true;
        state.current_scan_reason = next_scan_reason.map(str::to_string);
        state.last_scan_progress_at = Some(now);
        if next_scan_reason == Some("approved-reconnect") && state.startup_burst_deadline.is_none()
        {
            state.device_registry.start_reconnect_epoch();
            state.startup_burst_deadline =
                Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS));
        }
        context
            .writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: if approved_pending {
                    format!(
                        "Starting approved-node reconnect scan; {} approved node(s) are still missing.",
                        allowed.len().saturating_sub(state.connected_nodes.len())
                    )
                } else {
                    "Starting manual BLE scan window.".to_string()
                },
                details: Some(json!({
                    "approvedPending": approved_pending,
                    "approvedCount": allowed.len(),
                    "connectedApprovedCount": state.connected_nodes.len(),
                    "manualScanActive": state.manual_scan_deadline.is_some(),
                })),
            })
            .await?;
        emit_gateway_state(context, state, "scanning", next_scan_reason).await?;
        return Ok(());
    }

    if should_scan_now && state.scanning {
        let next_scan_reason_string = next_scan_reason.map(str::to_string);
        if state.current_scan_reason != next_scan_reason_string {
            if next_scan_reason == Some("approved-reconnect") {
                state.device_registry.start_reconnect_epoch();
            }
            state.current_scan_reason = next_scan_reason_string;
            emit_gateway_state(context, state, "scanning", next_scan_reason).await?;
        }
        return Ok(());
    }

    if !should_scan_now && state.scanning {
        let _ = context.adapter.stop_scan().await;
        state.scanning = false;
        state.current_scan_reason = None;
        state.last_scan_progress_at = None;
        state.startup_burst_deadline = None;
        emit_verbose_log(
            &context.writer,
            context.config.verbose_logging,
            "Stopping BLE scan window.",
            Some(json!({
                "approvedPending": approved_pending,
                "approvedCount": allowed.len(),
                "connectedApprovedCount": state.connected_nodes.len(),
                "manualScanActive": state.manual_scan_deadline.is_some(),
            })),
        )
        .await?;
        emit_gateway_state(context, state, "stopped", None).await?;
    }

    Ok(())
}

fn should_pause_approved_reconnect_scan(
    scan_reason: Option<&str>,
    active_connection_count: usize,
) -> bool {
    scan_reason == Some("approved-reconnect") && active_connection_count > 0
}

pub(super) fn pause_approved_reconnect_for_operator_decision(
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &mut HashMap<String, ApprovedReconnectState>,
) -> Vec<ApprovedNodeRule> {
    let mut paused_rules = Vec::new();

    for rule in allowed {
        let already_connected = connected_nodes
            .values()
            .any(|node| rule_matches_node(rule, node, allowed));
        if already_connected {
            continue;
        }

        let state = reconnect_states.entry(rule.id.clone()).or_default();
        if state.awaiting_user_decision {
            continue;
        }

        state.retry_exhausted = true;
        state.awaiting_user_decision = true;
        paused_rules.push(rule.clone());
    }

    paused_rules
}

pub(super) fn disconnected_node_from_rule(rule: &ApprovedNodeRule) -> DiscoveredNode {
    DiscoveredNode {
        id: rule
            .known_device_id
            .clone()
            .map(|value| format!("known:{value}"))
            .or_else(|| {
                rule.peripheral_id
                    .clone()
                    .map(|value| format!("peripheral:{value}"))
            })
            .or_else(|| rule.address.clone().map(|value| format!("address:{value}")))
            .or_else(|| rule.local_name.clone().map(|value| format!("name:{value}")))
            .unwrap_or_else(|| rule.id.clone()),
        label: rule.label.clone(),
        peripheral_id: rule.peripheral_id.clone(),
        address: rule.address.clone(),
        local_name: rule.local_name.clone(),
        known_device_id: rule.known_device_id.clone(),
        last_rssi: None,
        last_seen_at: None,
    }
}

pub(super) async fn restart_approved_reconnect_scan(
    context: &SessionContext,
    state: &mut SessionState,
    allowed: &[ApprovedNodeRule],
    active_connection_count: usize,
) -> Result<()> {
    context
        .writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: "Restarting approved-node reconnect scan burst.".to_string(),
            details: Some(json!({
                "scanBurst": state.reconnect_scan_burst,
                "advertisementsSeen": state.advertisements_seen_this_burst,
                "rejectedCandidates": state.rejected_candidates_this_burst,
                "classifiedCandidates": state.classified_candidates_this_burst,
                "lastAdvertisementAt": state.last_advertisement_at,
                "connectedApprovedCount": state.connected_nodes.len(),
                "activeConnectionCount": active_connection_count,
            })),
        })
        .await?;

    let _ = context.adapter.stop_scan().await;
    tokio::time::sleep(Duration::from_millis(
        APPROVED_RECONNECT_SCAN_RESTART_DELAY_MS,
    ))
    .await;

    let should_clear_peripherals =
        should_clear_reconnect_peripherals(&state.connected_nodes, active_connection_count);
    let cleared_peripherals = if should_clear_peripherals {
        context.adapter.clear_peripherals().await.is_ok()
    } else {
        false
    };

    state.device_registry.start_reconnect_epoch();
    context.adapter.start_scan(ScanFilter::default()).await?;
    emit_gateway_state(
        context,
        state,
        "scanning",
        scan_reason(
            allowed,
            &state.connected_nodes,
            &state.reconnect_states,
            None,
            Instant::now(),
        ),
    )
    .await?;
    context
        .writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: "Approved-node reconnect scan burst restarted.".to_string(),
            details: Some(json!({
                "scanBurst": state.reconnect_scan_burst + 1,
                "cacheResetAttempted": should_clear_peripherals,
                "cacheResetApplied": cleared_peripherals,
                "activeConnectionCount": active_connection_count,
            })),
        })
        .await?;

    Ok(())
}
