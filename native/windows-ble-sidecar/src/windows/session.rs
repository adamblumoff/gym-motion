use std::{
    collections::HashMap,
    future::pending,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use btleplug::{
    api::{Central, CentralState, Peripheral as _},
    platform::Adapter,
};
use futures::StreamExt;
use serde_json::json;
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use crate::protocol::{ApprovedNodeRule, DiscoveredNode, Event, GatewayStatePayload};

use super::{
    approval::{
        approved_nodes_pending_connection, node_key, reconnect_status_for_rule, scan_reason,
        should_restart_approved_reconnect_scan, ApprovedReconnectState,
        APPROVED_RECONNECT_SCAN_BURST_LIMIT, APPROVED_RECONNECT_SCAN_BURST_MS,
    },
    config::Config,
    registry::DeviceRegistry,
    session_command::handle_session_command,
    session_connection::disconnect_nodes_for_shutdown,
    session_event::handle_central_event,
    session_scan::{
        disconnected_node_from_rule, emit_gateway_state, emit_manual_scan_state,
        pause_approved_reconnect_for_operator_decision, restart_approved_reconnect_scan,
        sync_scan_state, APPROVED_RECONNECT_DIAGNOSTIC_MS,
    },
    session_types::SessionCommand,
    session_util::{emit_verbose_log, normalize_adapter_state},
    writer::EventWriter,
};

pub(super) const SCAN_WINDOW_SECS: u64 = 15;

pub(super) struct SessionContext {
    pub(super) adapter: Adapter,
    pub(super) selected_adapter_id: String,
    pub(super) writer: EventWriter,
    pub(super) config: Config,
    pub(super) allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    pub(super) active_connections: Arc<Mutex<HashMap<String, DiscoveredNode>>>,
    pub(super) known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    pub(super) command_sender: mpsc::UnboundedSender<SessionCommand>,
}

pub(super) struct SessionState {
    pub(super) device_registry: DeviceRegistry,
    pub(super) connected_nodes: HashMap<String, DiscoveredNode>,
    pub(super) reconnect_states: HashMap<String, ApprovedReconnectState>,
    pub(super) last_advertisement_at: Option<String>,
    pub(super) scanning: bool,
    pub(super) current_scan_reason: Option<String>,
    pub(super) last_scan_progress_at: Option<Instant>,
    pub(super) startup_burst_deadline: Option<Instant>,
    pub(super) manual_scan_deadline: Option<Instant>,
    pub(super) manual_recover_rule_id: Option<String>,
    pub(super) manual_pair_candidate_id: Option<String>,
    pub(super) manual_candidates: HashMap<String, DiscoveredNode>,
    pub(super) reconnect_scan_burst: u32,
    pub(super) advertisements_seen_this_burst: u32,
    pub(super) rejected_candidates_this_burst: u32,
    pub(super) classified_candidates_this_burst: u32,
}

impl SessionState {
    fn new() -> Self {
        Self {
            device_registry: DeviceRegistry::new(),
            connected_nodes: HashMap::new(),
            reconnect_states: HashMap::new(),
            last_advertisement_at: None,
            scanning: false,
            current_scan_reason: None,
            last_scan_progress_at: None,
            startup_burst_deadline: None,
            manual_scan_deadline: None,
            manual_recover_rule_id: None,
            manual_pair_candidate_id: None,
            manual_candidates: HashMap::new(),
            reconnect_scan_burst: 0,
            advertisements_seen_this_burst: 0,
            rejected_candidates_this_burst: 0,
            classified_candidates_this_burst: 0,
        }
    }
}

pub(super) async fn sync_current_scan_state(
    context: &SessionContext,
    state: &mut SessionState,
) -> Result<()> {
    let allowed = context.allowed_nodes.read().await.clone();
    sync_scan_state(context, state, &allowed).await
}

async fn handle_reconnect_diagnostic_tick(
    context: &SessionContext,
    state: &SessionState,
) -> Result<()> {
    let allowed = context.allowed_nodes.read().await.clone();
    if approved_nodes_pending_connection(&allowed, &state.connected_nodes, &state.reconnect_states)
    {
        emit_verbose_log(
            &context.writer,
            context.config.verbose_logging,
            "Approved-node reconnect scan still running; waiting for rediscovery.",
            Some(json!({
                "approvedCount": allowed.len(),
                "connectedApprovedCount": state.connected_nodes.len(),
                "scanReason": scan_reason(
                    &allowed,
                    &state.connected_nodes,
                    &state.reconnect_states,
                    state.manual_scan_deadline,
                    Instant::now(),
                ),
                "lastAdvertisementAt": state.last_advertisement_at,
            })),
        )
        .await?;
    }
    Ok(())
}

async fn handle_reconnect_scan_restart_tick(
    context: &SessionContext,
    state: &mut SessionState,
) -> Result<()> {
    let allowed = context.allowed_nodes.read().await.clone();
    if !state.scanning {
        return Ok(());
    }

    let active_connection_count = context.active_connections.lock().await.len();

    if !should_restart_approved_reconnect_scan(
        &allowed,
        &state.connected_nodes,
        &state.reconnect_states,
        state.manual_scan_deadline,
        Instant::now(),
        state.last_scan_progress_at,
        state.startup_burst_deadline,
        active_connection_count,
    ) {
        return Ok(());
    }

    if state.reconnect_scan_burst >= APPROVED_RECONNECT_SCAN_BURST_LIMIT {
        let paused_rules = pause_approved_reconnect_for_operator_decision(
            &allowed,
            &state.connected_nodes,
            &mut state.reconnect_states,
        );
        context
            .writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: "Approved-node reconnect scan paused after repeated scan bursts; waiting for operator input.".to_string(),
                details: Some(json!({
                    "scanBurstLimit": APPROVED_RECONNECT_SCAN_BURST_LIMIT,
                    "scanBurstCount": state.reconnect_scan_burst,
                    "pausedRuleCount": paused_rules.len(),
                    "connectedApprovedCount": state.connected_nodes.len(),
                })),
            })
            .await?;
        for paused_rule in paused_rules {
            context
                .writer
                .send(&Event::NodeConnectionState {
                    node: disconnected_node_from_rule(&paused_rule),
                    gateway_connection_state: "disconnected".to_string(),
                    reason: Some(format!(
                        "Auto-reconnect paused after {} scan bursts.",
                        APPROVED_RECONNECT_SCAN_BURST_LIMIT
                    )),
                    reconnect: reconnect_status_for_rule(
                        Some(paused_rule.id.as_str()),
                        &state.reconnect_states,
                    ),
                })
                .await?;
        }
        sync_current_scan_state(context, state).await?;
        return Ok(());
    }

    restart_approved_reconnect_scan(context, state, &allowed, active_connection_count).await?;
    state.reconnect_scan_burst = state.reconnect_scan_burst.saturating_add(1);
    state.advertisements_seen_this_burst = 0;
    state.rejected_candidates_this_burst = 0;
    state.classified_candidates_this_burst = 0;
    state.last_scan_progress_at = Some(Instant::now());
    if state
        .startup_burst_deadline
        .map(|deadline| deadline <= Instant::now())
        .unwrap_or(false)
    {
        state.startup_burst_deadline = None;
    }

    Ok(())
}

async fn cleanup_session(context: &SessionContext, state: &SessionState) -> Result<()> {
    if state.scanning {
        let _ = context.adapter.stop_scan().await;
    }
    if let Ok(peripherals) = context.adapter.peripherals().await {
        for peripheral in peripherals {
            if peripheral.is_connected().await.unwrap_or(false) {
                let _ = peripheral.disconnect().await;
            }
        }
    }
    let _ = context.adapter.clear_peripherals().await;
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
                scan_state: "stopped".to_string(),
                scan_reason: None,
                selected_adapter_id: Some(context.selected_adapter_id.clone()),
                last_advertisement_at: state.last_advertisement_at.clone(),
                issue: None,
            },
        })
        .await?;
    Ok(())
}

pub(super) async fn run_session(
    adapter: Adapter,
    selected_adapter_id: String,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    mut shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
    mut commands: mpsc::UnboundedReceiver<SessionCommand>,
) -> Result<()> {
    let context = SessionContext {
        adapter,
        selected_adapter_id,
        writer,
        config,
        allowed_nodes,
        active_connections: Arc::new(Mutex::new(HashMap::new())),
        known_device_ids: Arc::new(RwLock::new(HashMap::new())),
        command_sender,
    };
    let mut state = SessionState::new();

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
                scan_state: "stopped".to_string(),
                scan_reason: None,
                selected_adapter_id: Some(context.selected_adapter_id.clone()),
                last_advertisement_at: None,
                issue: None,
            },
        })
        .await?;

    let mut events = context.adapter.events().await?;
    let mut reconnect_diagnostic_tick =
        tokio::time::interval(Duration::from_millis(APPROVED_RECONNECT_DIAGNOSTIC_MS));
    reconnect_diagnostic_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect_diagnostic_tick.tick().await;
    let mut reconnect_scan_restart_tick =
        tokio::time::interval(Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS));
    reconnect_scan_restart_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect_scan_restart_tick.tick().await;

    emit_manual_scan_state(&context.writer, "idle", None, None).await?;
    sync_current_scan_state(&context, &mut state).await?;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    let mut shutdown_nodes = state.connected_nodes.values().cloned().collect::<Vec<_>>();
                    let active_nodes = context
                        .active_connections
                        .lock()
                        .await
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    for node in active_nodes {
                        if !shutdown_nodes
                            .iter()
                            .any(|candidate| node_key(candidate) == node_key(&node))
                        {
                            shutdown_nodes.push(node);
                        }
                    }
                    disconnect_nodes_for_shutdown(&context, &shutdown_nodes).await;
                    break;
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    break;
                };
                handle_session_command(&context, &mut state, &shutdown, command).await?;
            }
            _ = async {
                if let Some(deadline) = state.manual_scan_deadline {
                    tokio::time::sleep_until(deadline.into()).await;
                } else {
                    pending::<()>().await;
                }
            } => {
                state.manual_scan_deadline = None;
                state.manual_recover_rule_id = None;
                if state.manual_pair_candidate_id.is_none() {
                    state.manual_candidates.clear();
                    emit_manual_scan_state(&context.writer, "idle", None, None).await?;
                }
                sync_current_scan_state(&context, &mut state).await?;
            }
            _ = reconnect_diagnostic_tick.tick() => {
                handle_reconnect_diagnostic_tick(&context, &state).await?;
            }
            _ = reconnect_scan_restart_tick.tick() => {
                handle_reconnect_scan_restart_tick(&context, &mut state).await?;
            }
            event = events.next() => {
                let Some(event) = event else {
                    break;
                };
                handle_central_event(&context, &mut state, &shutdown, event).await?;
            }
        }
    }

    cleanup_session(&context, &state).await?;
    Ok(())
}
