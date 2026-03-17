use std::time::{Duration, Instant};

use anyhow::Result;
use btleplug::api::{Central, CentralEvent, CentralState};
use serde_json::json;
use tokio::{sync::watch, time::sleep};

use crate::protocol::{Event, GatewayStatePayload};

use super::{
    approval::{
        allow_approved_identity_fallback, approved_rule_id_for_node, is_approved,
        next_reconnect_attempt, reconnect_candidate_ready, reconnect_status_for_rule, scan_reason,
    },
    registry::AdvertisementSnapshot,
    session::{sync_current_scan_state, SessionContext, SessionState},
    session_connection::{
        discovery_candidate_for_event, peripheral_for_event, spawn_reconnect_for_discovered_node,
    },
    session_scan::emit_gateway_state,
    session_util::{emit_verbose_log, normalize_adapter_state},
};

const DISCONNECT_CONFIRM_MS: u64 = 250;

pub(super) async fn handle_central_event(
    context: &SessionContext,
    state: &mut SessionState,
    shutdown: &watch::Receiver<bool>,
    event: CentralEvent,
) -> Result<()> {
    match event {
        CentralEvent::StateUpdate(adapter_state) => {
            let allowed = context.allowed_nodes.read().await.clone();
            context
                .writer
                .send(&Event::GatewayState {
                    gateway: GatewayStatePayload {
                        adapter_state: normalize_adapter_state(adapter_state),
                        scan_state: if state.scanning {
                            "scanning"
                        } else {
                            "stopped"
                        }
                        .to_string(),
                        scan_reason: if state.scanning {
                            scan_reason(
                                &allowed,
                                &state.connected_nodes,
                                &state.reconnect_states,
                                state.manual_scan_deadline,
                                Instant::now(),
                            )
                            .map(str::to_string)
                        } else {
                            None
                        },
                        selected_adapter_id: Some(context.selected_adapter_id.clone()),
                        last_advertisement_at: state.last_advertisement_at.clone(),
                        issue: None,
                    },
                })
                .await?;
        }
        CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
            if !state.scanning {
                return Ok(());
            }

            state.advertisements_seen_this_burst =
                state.advertisements_seen_this_burst.saturating_add(1);

            let Some(peripheral) = peripheral_for_event(context, "device_discovered", &id).await
            else {
                return Ok(());
            };
            let allowed = context.allowed_nodes.read().await.clone();
            let discovery_scan_reason = scan_reason(
                &allowed,
                &state.connected_nodes,
                &state.reconnect_states,
                state.manual_scan_deadline,
                Instant::now(),
            );
            if let Some(candidate) = discovery_candidate_for_event(
                context,
                "device_discovered",
                &peripheral,
                &allowed,
                allow_approved_identity_fallback(
                    &allowed,
                    &state.connected_nodes,
                    &state.reconnect_states,
                    state.manual_scan_deadline,
                    Instant::now(),
                ),
            )
            .await
            {
                let node = candidate.node;
                let device_record = node.address.as_ref().map(|address| {
                    state.device_registry.upsert(AdvertisementSnapshot {
                        address: address.clone(),
                        local_name: node.local_name.clone(),
                        service_uuids: candidate.service_uuids.clone(),
                        rssi: node.last_rssi,
                        seen_at: node.last_seen_at.clone().unwrap_or_else(|| {
                            state.last_advertisement_at.clone().unwrap_or_default()
                        }),
                        seen_at_monotonic: Instant::now(),
                    })
                });
                let reconnect_relevant = candidate.classification.runtime_service_matched
                    || candidate.classification.approved_identity_matched;
                let reconnect_ready = reconnect_candidate_ready(
                    &candidate.classification,
                    node.local_name.is_some(),
                    device_record.as_ref(),
                );
                if discovery_scan_reason == Some("approved-reconnect") {
                    if reconnect_relevant {
                        state.classified_candidates_this_burst =
                            state.classified_candidates_this_burst.saturating_add(1);
                        state.last_scan_progress_at = Some(Instant::now());
                    }
                } else {
                    state.classified_candidates_this_burst =
                        state.classified_candidates_this_burst.saturating_add(1);
                    state.last_scan_progress_at = Some(Instant::now());
                }
                state.last_advertisement_at = node.last_seen_at.clone();
                if discovery_scan_reason == Some("manual") {
                    state
                        .manual_candidates
                        .insert(node.id.clone(), node.clone());
                }
                context
                    .writer
                    .send(&Event::NodeDiscovered {
                        node: node.clone(),
                        scan_reason: discovery_scan_reason.map(str::to_string),
                    })
                    .await?;
                emit_gateway_state(context, state, "scanning", discovery_scan_reason).await?;

                if is_approved(&node, &allowed) {
                    let Some(rule_id) = approved_rule_id_for_node(&node, &allowed) else {
                        return Ok(());
                    };
                    if !reconnect_ready {
                        emit_verbose_log(
                            &context.writer,
                            context.config.verbose_logging,
                            format!(
                                "Approved node sighted for {}; waiting for a stronger rediscovery signal before reconnecting.",
                                node.label
                            ),
                            Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "runtimeServiceMatched": candidate.classification.runtime_service_matched,
                                "approvedIdentityMatched": candidate.classification.approved_identity_matched,
                                "namePrefixMatched": candidate.classification.name_prefix_matched,
                                "sightingsInEpoch": device_record
                                    .as_ref()
                                    .map(|record| record.sightings_in_epoch),
                            })),
                        )
                        .await?;
                        return Ok(());
                    }
                    let key = node
                        .peripheral_id
                        .clone()
                        .unwrap_or_else(|| node.id.clone());
                    let active = context.active_connections.lock().await;
                    let reconnect_state = state
                        .reconnect_states
                        .get(&rule_id)
                        .cloned()
                        .unwrap_or_default();
                    let Some(next_attempt) =
                        next_reconnect_attempt(&reconnect_state, active.contains_key(&key))
                    else {
                        return Ok(());
                    };
                    drop(active);
                    let manual_recovery = state
                        .manual_recover_rule_id
                        .as_ref()
                        .map(|target| target == &rule_id)
                        .unwrap_or(false);
                    let _ = spawn_reconnect_for_discovered_node(
                        context,
                        state,
                        shutdown,
                        peripheral,
                        node.clone(),
                        rule_id,
                        next_attempt,
                        format!(
                            "Approved node rediscovered; starting reconnect attempt for {}.",
                            node.label
                        ),
                        json!({
                            "peripheralId": node.peripheral_id,
                            "knownDeviceId": node.known_device_id,
                            "address": node.address,
                            "reconnectAttempt": next_attempt,
                            "runtimeServiceMatched": candidate.classification.runtime_service_matched,
                            "approvedIdentityMatched": candidate.classification.approved_identity_matched,
                            "namePrefixMatched": candidate.classification.name_prefix_matched,
                            "sightingsInEpoch": device_record
                                .as_ref()
                                .map(|record| record.sightings_in_epoch),
                            "manualRecovery": manual_recovery,
                        }),
                        manual_recovery,
                    )
                    .await?;
                }
            } else {
                state.rejected_candidates_this_burst =
                    state.rejected_candidates_this_burst.saturating_add(1);
            }
        }
        CentralEvent::DeviceDisconnected(id) => {
            let Some(peripheral) = peripheral_for_event(context, "device_disconnected", &id).await
            else {
                return Ok(());
            };
            let allowed = context.allowed_nodes.read().await.clone();
            if let Some(candidate) = discovery_candidate_for_event(
                context,
                "device_disconnected",
                &peripheral,
                &allowed,
                allow_approved_identity_fallback(
                    &allowed,
                    &state.connected_nodes,
                    &state.reconnect_states,
                    state.manual_scan_deadline,
                    Instant::now(),
                ),
            )
            .await
            {
                let node = candidate.node;
                let reconnect = reconnect_status_for_rule(
                    approved_rule_id_for_node(&node, &allowed).as_deref(),
                    &state.reconnect_states,
                );
                sleep(Duration::from_millis(DISCONNECT_CONFIRM_MS)).await;
                if peripheral.is_connected().await.unwrap_or(false) {
                    context
                        .writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: format!(
                                "Ignoring transient disconnect for {} after transport re-check.",
                                node.label
                            ),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                            })),
                        })
                        .await?;
                    return Ok(());
                }

                state
                    .connected_nodes
                    .remove(&super::approval::node_key(&node));
                context
                    .writer
                    .send(&Event::NodeConnectionState {
                        node,
                        gateway_connection_state: "disconnected".to_string(),
                        reason: Some("Device disconnected.".to_string()),
                        reconnect,
                    })
                    .await?;
                sync_current_scan_state(context, state).await?;
            }
        }
        _ => {}
    }

    Ok(())
}
