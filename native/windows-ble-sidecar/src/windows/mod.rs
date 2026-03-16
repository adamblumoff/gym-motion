mod approval;
mod config;
mod discovery;
mod handshake;
mod registry;
mod winrt_adapter;
mod writer;

use std::{
    collections::HashMap,
    future::pending,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter},
    platform::{Adapter, Manager, Peripheral},
};
use futures::StreamExt;
use serde_json::json;
use tokio::{
    io::{self, AsyncBufReadExt, BufReader},
    sync::{mpsc, watch, Mutex, RwLock},
    task::JoinHandle,
    time::sleep,
};
use uuid::Uuid;

use self::{
    approval::{
        allow_approved_identity_fallback, approved_nodes_pending_connection,
        approved_rule_id_for_node, disconnected_nodes_removed_from_allowed, is_approved,
        mark_node_connected, next_reconnect_attempt, node_key, prune_reconnect_states,
        reconnect_candidate_ready, reconnect_status_for_rule, scan_reason,
        should_clear_reconnect_peripherals, should_restart_approved_reconnect_scan, should_scan,
        ApprovedReconnectState, APPROVED_RECONNECT_SCAN_BURST_MS, RECONNECT_ATTEMPT_LIMIT,
    },
    config::Config,
    discovery::{discovery_candidate_from_peripheral, DiscoveryCandidate},
    handshake::{send_app_session_bootstrap, send_app_session_lease, write_chunked_json_command},
    registry::{AdvertisementSnapshot, DeviceRegistry},
    winrt_adapter::list_winrt_adapters,
    writer::EventWriter,
};

use crate::{
    json_decoder::JsonObjectDecoder,
    protocol::{
        AdapterSummary, ApprovedNodeRule, Command, DiscoveredNode, Event, GatewayStatePayload,
        ReconnectStatus, RuntimeStatusPayload, TelemetryPayload,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const SCAN_WINDOW_SECS: u64 = 15;
const DISCONNECT_CONFIRM_MS: u64 = 250;
const CONNECTION_HEALTH_POLL_MS: u64 = 2_000;
const APPROVED_RECONNECT_DIAGNOSTIC_MS: u64 = 10_000;
const APPROVED_RECONNECT_STARTUP_BURST_MS: u64 = 5_000;
const APPROVED_RECONNECT_SCAN_RESTART_DELAY_MS: u64 = 300;
const APP_SESSION_HEARTBEAT_MS: u64 = 5_000;
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

struct SessionHandle {
    shutdown: watch::Sender<bool>,
    commands: mpsc::UnboundedSender<SessionCommand>,
    task: JoinHandle<()>,
}

enum SessionCommand {
    StartScan,
    RefreshScanPolicy,
    RecoverApprovedNode {
        rule_id: String,
    },
    AllowedNodesUpdated {
        nodes: Vec<ApprovedNodeRule>,
    },
    ConnectionHealthy {
        node: DiscoveredNode,
    },
    ConnectionEnded {
        node: DiscoveredNode,
        reason: String,
    },
}

async fn emit_gateway_state(
    writer: &EventWriter,
    adapter: &Adapter,
    selected_adapter_id: &str,
    scan_state: &str,
    scan_reason: Option<&str>,
    last_advertisement_at: &Option<String>,
) -> Result<()> {
    writer
        .send(&Event::GatewayState {
            gateway: GatewayStatePayload {
                adapter_state: normalize_adapter_state(
                    adapter
                        .adapter_state()
                        .await
                        .unwrap_or(CentralState::Unknown),
                ),
                scan_state: scan_state.to_string(),
                scan_reason: scan_reason.map(str::to_string),
                selected_adapter_id: Some(selected_adapter_id.to_string()),
                last_advertisement_at: last_advertisement_at.clone(),
                issue: None,
            },
        })
        .await?;

    Ok(())
}

async fn emit_verbose_log(
    writer: &EventWriter,
    enabled: bool,
    message: impl Into<String>,
    details: Option<serde_json::Value>,
) -> Result<()> {
    if !enabled {
        return Ok(());
    }

    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: message.into(),
            details,
        })
        .await
}

async fn sync_scan_state(
    adapter: &Adapter,
    writer: &EventWriter,
    config: &Config,
    selected_adapter_id: &str,
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    device_registry: &mut DeviceRegistry,
    scanning: &mut bool,
    current_scan_reason: &mut Option<String>,
    manual_scan_deadline: Option<Instant>,
    last_advertisement_at: &Option<String>,
    last_scan_progress_at: &mut Option<Instant>,
    startup_burst_deadline: &mut Option<Instant>,
) -> Result<()> {
    let now = Instant::now();
    let should_scan_now = should_scan(
        allowed,
        connected_nodes,
        reconnect_states,
        manual_scan_deadline,
        now,
    );
    let approved_pending =
        approved_nodes_pending_connection(allowed, connected_nodes, reconnect_states);
    let next_scan_reason = scan_reason(
        allowed,
        connected_nodes,
        reconnect_states,
        manual_scan_deadline,
        now,
    );

    if should_scan_now && !*scanning {
        adapter.start_scan(ScanFilter::default()).await?;
        *scanning = true;
        *current_scan_reason = next_scan_reason.map(str::to_string);
        *last_scan_progress_at = Some(now);
        if next_scan_reason == Some("approved-reconnect") && startup_burst_deadline.is_none() {
            device_registry.start_reconnect_epoch();
            *startup_burst_deadline =
                Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS));
        }
        writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: if approved_pending {
                    format!(
                        "Starting approved-node reconnect scan; {} approved node(s) are still missing.",
                        allowed.len().saturating_sub(connected_nodes.len())
                    )
                } else {
                    "Starting manual BLE scan window.".to_string()
                },
                details: Some(json!({
                    "approvedPending": approved_pending,
                    "approvedCount": allowed.len(),
                    "connectedApprovedCount": connected_nodes.len(),
                    "manualScanActive": manual_scan_deadline.is_some(),
                })),
            })
            .await?;
        emit_gateway_state(
            writer,
            adapter,
            selected_adapter_id,
            "scanning",
            next_scan_reason,
            last_advertisement_at,
        )
        .await?;
        return Ok(());
    }

    if should_scan_now && *scanning {
        let next_scan_reason_string = next_scan_reason.map(str::to_string);
        if *current_scan_reason != next_scan_reason_string {
            if next_scan_reason == Some("approved-reconnect") {
                device_registry.start_reconnect_epoch();
            }
            *current_scan_reason = next_scan_reason_string;
            emit_gateway_state(
                writer,
                adapter,
                selected_adapter_id,
                "scanning",
                next_scan_reason,
                last_advertisement_at,
            )
            .await?;
        }
        return Ok(());
    }

    if !should_scan_now && *scanning {
        let _ = adapter.stop_scan().await;
        *scanning = false;
        *current_scan_reason = None;
        *last_scan_progress_at = None;
        *startup_burst_deadline = None;
        emit_verbose_log(
            writer,
            config.verbose_logging,
            "Stopping BLE scan window.",
            Some(json!({
                "approvedPending": approved_pending,
                "approvedCount": allowed.len(),
                "connectedApprovedCount": connected_nodes.len(),
                "manualScanActive": manual_scan_deadline.is_some(),
            })),
        )
        .await?;
        emit_gateway_state(
            writer,
            adapter,
            selected_adapter_id,
            "stopped",
            None,
            last_advertisement_at,
        )
        .await?;
    }

    Ok(())
}

async fn restart_approved_reconnect_scan(
    adapter: &Adapter,
    writer: &EventWriter,
    device_registry: &mut DeviceRegistry,
    selected_adapter_id: &str,
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    last_advertisement_at: &Option<String>,
    scan_burst: u32,
    advertisements_seen: u32,
    rejected_candidates: u32,
    classified_candidates: u32,
    active_connection_count: usize,
) -> Result<()> {
    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: "Restarting approved-node reconnect scan burst.".to_string(),
            details: Some(json!({
                "scanBurst": scan_burst,
                "advertisementsSeen": advertisements_seen,
                "rejectedCandidates": rejected_candidates,
                "classifiedCandidates": classified_candidates,
                "lastAdvertisementAt": last_advertisement_at,
                "connectedApprovedCount": connected_nodes.len(),
                "activeConnectionCount": active_connection_count,
            })),
        })
        .await?;

    let _ = adapter.stop_scan().await;
    sleep(Duration::from_millis(
        APPROVED_RECONNECT_SCAN_RESTART_DELAY_MS,
    ))
    .await;

    let should_clear_peripherals =
        should_clear_reconnect_peripherals(connected_nodes, active_connection_count);

    let cleared_peripherals = if should_clear_peripherals {
        adapter.clear_peripherals().await.is_ok()
    } else {
        false
    };

    device_registry.start_reconnect_epoch();
    adapter.start_scan(ScanFilter::default()).await?;
    emit_gateway_state(
        writer,
        adapter,
        selected_adapter_id,
        "scanning",
        scan_reason(
            allowed,
            connected_nodes,
            reconnect_states,
            None,
            Instant::now(),
        ),
        last_advertisement_at,
    )
    .await?;
    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: "Approved-node reconnect scan burst restarted.".to_string(),
            details: Some(json!({
                "scanBurst": scan_burst + 1,
                "cacheResetAttempted": should_clear_peripherals,
                "cacheResetApplied": cleared_peripherals,
                "activeConnectionCount": active_connection_count,
            })),
        })
        .await?;

    Ok(())
}

struct Sidecar {
    manager: Manager,
    writer: EventWriter,
    config: Config,
    selected_adapter_id: Option<String>,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    session: Option<SessionHandle>,
}

impl Sidecar {
    async fn new() -> Result<Self> {
        Ok(Self {
            manager: Manager::new().await?,
            writer: EventWriter::new(),
            config: Config::from_env()?,
            selected_adapter_id: None,
            allowed_nodes: Arc::new(RwLock::new(Vec::new())),
            session: None,
        })
    }

    async fn send_ready(&self) -> Result<()> {
        self.writer
            .send(&Event::Ready {
                platform: "win32".to_string(),
                protocol_version: PROTOCOL_VERSION,
            })
            .await
    }

    async fn list_adapters(&self) -> Result<Vec<AdapterSummary>> {
        let winrt_adapters = list_winrt_adapters().await?;
        let adapters = self.manager.adapters().await?;
        let mut summaries = Vec::with_capacity(adapters.len());

        for (index, adapter) in adapters.into_iter().enumerate() {
            // Keep btleplug as the canonical adapter source until session startup
            // is fully migrated to raw WinRT, otherwise adapter ids can drift.
            let fallback_label = adapter
                .adapter_info()
                .await
                .unwrap_or_else(|_| format!("Bluetooth adapter {}", index + 1));
            let state = adapter
                .adapter_state()
                .await
                .unwrap_or(CentralState::Unknown);
            let winrt_descriptor = winrt_adapters.get(index);
            let mut details = vec![format!("state:{:?}", state)];
            if let Some(descriptor) = winrt_descriptor {
                for detail in &descriptor.details {
                    if !details.contains(detail) {
                        details.push(detail.clone());
                    }
                }
            }
            summaries.push(AdapterSummary {
                id: format!("winrt:{index}"),
                label: winrt_descriptor
                    .map(|descriptor| descriptor.label.clone())
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or(fallback_label),
                transport: "winrt".to_string(),
                is_available: state == CentralState::PoweredOn,
                issue: match state {
                    CentralState::PoweredOff => Some("Adapter is powered off.".to_string()),
                    _ => winrt_descriptor.and_then(|descriptor| descriptor.issue.clone()),
                },
                details,
            });
        }

        Ok(summaries)
    }

    async fn emit_adapters(&self) -> Result<()> {
        self.writer
            .send(&Event::AdapterList {
                adapters: self.list_adapters().await?,
            })
            .await
    }

    async fn handle_command(&mut self, command: Command) -> Result<bool> {
        match command {
            Command::ListAdapters | Command::Rescan | Command::RefreshScanPolicy => {
                if matches!(command, Command::Rescan) {
                    if self.session.is_none() {
                        self.start_session().await?;
                    }

                    if let Some(session) = &self.session {
                        let _ = session.commands.send(SessionCommand::StartScan);
                    }
                } else if matches!(command, Command::RefreshScanPolicy) {
                    if self.session.is_none() {
                        self.start_session().await?;
                    }

                    if let Some(session) = &self.session {
                        let _ = session.commands.send(SessionCommand::RefreshScanPolicy);
                    }
                }
                self.emit_adapters().await?;
            }
            Command::RecoverApprovedNode { rule_id } => {
                if self.session.is_none() {
                    self.start_session().await?;
                }

                if let Some(session) = &self.session {
                    let _ = session
                        .commands
                        .send(SessionCommand::RecoverApprovedNode { rule_id });
                }
            }
            Command::SelectAdapter { adapter_id } => {
                self.selected_adapter_id = Some(adapter_id);
                self.emit_adapters().await?;
            }
            Command::SetAllowedNodes { nodes } => {
                *self.allowed_nodes.write().await = nodes;
                if let Some(session) = &self.session {
                    let _ = session.commands.send(SessionCommand::AllowedNodesUpdated {
                        nodes: self.allowed_nodes.read().await.clone(),
                    });
                }
            }
            Command::Start => {
                self.start_session().await?;
            }
            Command::Stop => {
                self.stop_session().await?;
            }
            Command::Shutdown => {
                self.stop_session().await?;
                return Ok(false);
            }
        }

        Ok(true)
    }

    async fn start_session(&mut self) -> Result<()> {
        self.stop_session().await?;

        let Some(selected_adapter_id) = self.selected_adapter_id.clone() else {
            self.writer
                .send(&Event::GatewayState {
                    gateway: GatewayStatePayload {
                        adapter_state: "unknown".to_string(),
                        scan_state: "stopped".to_string(),
                        scan_reason: None,
                        selected_adapter_id: None,
                        last_advertisement_at: None,
                        issue: Some(
                            "Select a BLE adapter before starting the gateway.".to_string(),
                        ),
                    },
                })
                .await?;
            return Ok(());
        };

        let adapter = resolve_adapter(&self.manager, &selected_adapter_id).await?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let command_tx_clone = command_tx.clone();
        let writer = self.writer.clone();
        let config = self.config.clone();
        let allowed_nodes = self.allowed_nodes.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = run_session(
                adapter,
                selected_adapter_id,
                writer.clone(),
                config,
                allowed_nodes,
                shutdown_rx,
                command_tx_clone,
                command_rx,
            )
            .await
            {
                writer
                    .error(
                        format!("Windows BLE session failed: {error}"),
                        Some(json!({ "error": error.to_string() })),
                    )
                    .await;
            }
        });

        self.session = Some(SessionHandle {
            shutdown: shutdown_tx,
            commands: command_tx,
            task,
        });

        Ok(())
    }

    async fn stop_session(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            let _ = session.shutdown.send(true);
            let _ = session.task.await;
        }
        Ok(())
    }
}

pub async fn run() -> Result<()> {
    let mut sidecar = Sidecar::new().await?;
    sidecar.send_ready().await?;
    sidecar.emit_adapters().await?;

    let stdin = BufReader::new(io::stdin());
    let mut lines = stdin.lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let command: Command = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                sidecar
                    .writer
                    .error(
                        format!("Failed to parse command: {error}"),
                        Some(json!({ "line": line })),
                    )
                    .await;
                continue;
            }
        };

        if !sidecar.handle_command(command).await? {
            break;
        }
    }

    sidecar.stop_session().await?;
    Ok(())
}

async fn resolve_adapter(manager: &Manager, selected_adapter_id: &str) -> Result<Adapter> {
    let index = selected_adapter_id
        .strip_prefix("winrt:")
        .ok_or_else(|| anyhow!("unsupported adapter id: {selected_adapter_id}"))?
        .parse::<usize>()
        .with_context(|| format!("invalid adapter index in {selected_adapter_id}"))?;

    let adapters = manager.adapters().await?;
    adapters
        .into_iter()
        .nth(index)
        .ok_or_else(|| anyhow!("adapter {selected_adapter_id} is not available"))
}

async fn run_session(
    adapter: Adapter,
    selected_adapter_id: String,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    mut shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
    mut commands: mpsc::UnboundedReceiver<SessionCommand>,
) -> Result<()> {
    let adapter_state = normalize_adapter_state(
        adapter
            .adapter_state()
            .await
            .unwrap_or(CentralState::Unknown),
    );
    writer
        .send(&Event::GatewayState {
            gateway: GatewayStatePayload {
                adapter_state,
                scan_state: "stopped".to_string(),
                scan_reason: None,
                selected_adapter_id: Some(selected_adapter_id.clone()),
                last_advertisement_at: None,
                issue: None,
            },
        })
        .await?;

    let mut events = adapter.events().await?;
    let active_connections = Arc::new(Mutex::new(HashMap::<String, DiscoveredNode>::new()));
    let known_device_ids = Arc::new(RwLock::new(HashMap::<String, String>::new()));
    let mut device_registry = DeviceRegistry::new();
    let mut connected_nodes = HashMap::<String, DiscoveredNode>::new();
    let mut reconnect_states = HashMap::<String, ApprovedReconnectState>::new();
    let mut last_advertisement_at = None;
    let mut scanning = false;
    let mut current_scan_reason = None;
    let mut last_scan_progress_at = None;
    let mut startup_burst_deadline = None;
    let mut manual_scan_deadline = None;
    let mut manual_recover_rule_id: Option<String> = None;
    let mut reconnect_diagnostic_tick =
        tokio::time::interval(Duration::from_millis(APPROVED_RECONNECT_DIAGNOSTIC_MS));
    reconnect_diagnostic_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect_diagnostic_tick.tick().await;
    let mut reconnect_scan_restart_tick =
        tokio::time::interval(Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS));
    reconnect_scan_restart_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect_scan_restart_tick.tick().await;
    let mut reconnect_scan_burst = 0_u32;
    let mut advertisements_seen_this_burst = 0_u32;
    let mut rejected_candidates_this_burst = 0_u32;
    let mut classified_candidates_this_burst = 0_u32;

    {
        let allowed = allowed_nodes.read().await.clone();
        sync_scan_state(
            &adapter,
            &writer,
            &config,
            &selected_adapter_id,
            &allowed,
            &connected_nodes,
            &reconnect_states,
            &mut device_registry,
            &mut scanning,
            &mut current_scan_reason,
            manual_scan_deadline,
            &last_advertisement_at,
            &mut last_scan_progress_at,
            &mut startup_burst_deadline,
        )
        .await?;
    }

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    let mut shutdown_nodes = connected_nodes
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    let active_nodes = active_connections
                        .lock()
                        .await
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    for node in active_nodes {
                        if !shutdown_nodes.iter().any(|candidate| node_key(candidate) == node_key(&node)) {
                            shutdown_nodes.push(node);
                        }
                    }
                    disconnect_nodes_for_shutdown(&adapter, &writer, &shutdown_nodes).await;
                    break;
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    break;
                };

                match command {
                    SessionCommand::StartScan => {
                        manual_scan_deadline = Some(Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
                    }
                    SessionCommand::RefreshScanPolicy => {
                        let allowed = allowed_nodes.read().await.clone();
                        prune_reconnect_states(&mut reconnect_states, &allowed);
                    }
                    SessionCommand::RecoverApprovedNode { rule_id } => {
                        let allowed = allowed_nodes.read().await.clone();
                        let label = allowed
                            .iter()
                            .find(|rule| rule.id == rule_id)
                            .map(|rule| rule.label.clone())
                            .unwrap_or_else(|| rule_id.clone());
                        reconnect_states.insert(rule_id.clone(), ApprovedReconnectState::default());
                        manual_recover_rule_id = Some(rule_id.clone());
                        manual_scan_deadline =
                            Some(Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
                        writer.send(&Event::Log {
                            level: "info".to_string(),
                            message: format!(
                                "Manual Windows recovery requested for {label}; resetting retry exhaustion and starting a targeted scan."
                            ),
                            details: Some(json!({
                                "ruleId": rule_id,
                                "manualRecovery": true,
                            })),
                        }).await?;
                    }
                    SessionCommand::AllowedNodesUpdated { nodes: allowed } => {
                        prune_reconnect_states(&mut reconnect_states, &allowed);
                        if manual_recover_rule_id
                            .as_ref()
                            .map(|rule_id| !allowed.iter().any(|rule| rule.id == *rule_id))
                            .unwrap_or(false)
                        {
                            manual_recover_rule_id = None;
                        }
                        for node in disconnected_nodes_removed_from_allowed(&connected_nodes, &allowed) {
                            if let Some(peripheral) = peripheral_for_node(&adapter, &node).await {
                                writer.send(&Event::Log {
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
                                }).await?;
                                let _ = peripheral.disconnect().await;
                            }
                        }
                    }
                    SessionCommand::ConnectionHealthy { node } => {
                        let allowed = allowed_nodes.read().await.clone();
                        if approved_rule_id_for_node(&node, &allowed)
                            .as_ref()
                            .zip(manual_recover_rule_id.as_ref())
                            .map(|(left, right)| left == right)
                            .unwrap_or(false)
                        {
                            manual_recover_rule_id = None;
                        }
                        mark_node_connected(
                            &mut connected_nodes,
                            &mut reconnect_states,
                            &node,
                            &allowed,
                        );
                        sync_scan_state(
                            &adapter,
                            &writer,
                            &config,
                            &selected_adapter_id,
                            &allowed,
                            &connected_nodes,
                            &reconnect_states,
                            &mut device_registry,
                            &mut scanning,
                            &mut current_scan_reason,
                            manual_scan_deadline,
                            &last_advertisement_at,
                            &mut last_scan_progress_at,
                            &mut startup_burst_deadline,
                        )
                        .await?;
                        continue;
                    }
                    SessionCommand::ConnectionEnded { node, reason } => {
                        let key = node_key(&node);
                        connected_nodes.remove(&key);
                        let allowed = allowed_nodes.read().await.clone();
                        let reconnect = approved_rule_id_for_node(&node, &allowed).map(|rule_id| {
                            let state = reconnect_states.entry(rule_id).or_default();
                            if state.attempt >= RECONNECT_ATTEMPT_LIMIT {
                                state.retry_exhausted = true;
                            }
                            ReconnectStatus {
                                attempt: state.attempt,
                                attempt_limit: RECONNECT_ATTEMPT_LIMIT,
                                retry_exhausted: state.retry_exhausted,
                            }
                        });
                        writer.send(&Event::Log {
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
                        }).await?;
                        writer.send(&Event::NodeConnectionState {
                            node,
                            gateway_connection_state: "disconnected".to_string(),
                            reason: Some(reason),
                            reconnect,
                        }).await?;
                        sync_scan_state(
                            &adapter,
                            &writer,
                            &config,
                            &selected_adapter_id,
                            &allowed,
                            &connected_nodes,
                            &reconnect_states,
                            &mut device_registry,
                            &mut scanning,
                            &mut current_scan_reason,
                            manual_scan_deadline,
                            &last_advertisement_at,
                            &mut last_scan_progress_at,
                            &mut startup_burst_deadline,
                        )
                        .await?;
                        continue;
                    }
                }

                let allowed = allowed_nodes.read().await.clone();
                sync_scan_state(
                    &adapter,
                    &writer,
                    &config,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    &mut device_registry,
                    &mut scanning,
                    &mut current_scan_reason,
                    manual_scan_deadline,
                    &last_advertisement_at,
                    &mut last_scan_progress_at,
                    &mut startup_burst_deadline,
                )
                .await?;
            }
            _ = async {
                if let Some(deadline) = manual_scan_deadline {
                    tokio::time::sleep_until(deadline.into()).await;
                } else {
                    pending::<()>().await;
                }
            } => {
                manual_scan_deadline = None;
                manual_recover_rule_id = None;
                let allowed = allowed_nodes.read().await.clone();
                sync_scan_state(
                    &adapter,
                    &writer,
                    &config,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    &mut device_registry,
                    &mut scanning,
                    &mut current_scan_reason,
                    manual_scan_deadline,
                    &last_advertisement_at,
                    &mut last_scan_progress_at,
                    &mut startup_burst_deadline,
                )
                .await?;
            }
            _ = reconnect_diagnostic_tick.tick() => {
                let allowed = allowed_nodes.read().await.clone();
                if approved_nodes_pending_connection(&allowed, &connected_nodes, &reconnect_states) {
                    emit_verbose_log(
                        &writer,
                        config.verbose_logging,
                        "Approved-node reconnect scan still running; waiting for rediscovery.",
                        Some(json!({
                            "approvedCount": allowed.len(),
                            "connectedApprovedCount": connected_nodes.len(),
                            "scanReason": scan_reason(
                                &allowed,
                                &connected_nodes,
                                &reconnect_states,
                                manual_scan_deadline,
                                Instant::now(),
                            ),
                            "lastAdvertisementAt": last_advertisement_at,
                        })),
                    )
                    .await?;
                }
            }
            _ = reconnect_scan_restart_tick.tick() => {
                let allowed = allowed_nodes.read().await.clone();
                if !scanning {
                    continue;
                }

                let active_connection_count = active_connections.lock().await.len();

                if !should_restart_approved_reconnect_scan(
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    manual_scan_deadline,
                    Instant::now(),
                    last_scan_progress_at,
                    startup_burst_deadline,
                    active_connection_count,
                ) {
                    continue;
                }

                restart_approved_reconnect_scan(
                    &adapter,
                    &writer,
                    &mut device_registry,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    &last_advertisement_at,
                    reconnect_scan_burst,
                    advertisements_seen_this_burst,
                    rejected_candidates_this_burst,
                    classified_candidates_this_burst,
                    active_connection_count,
                )
                .await?;
                reconnect_scan_burst = reconnect_scan_burst.saturating_add(1);
                advertisements_seen_this_burst = 0;
                rejected_candidates_this_burst = 0;
                classified_candidates_this_burst = 0;
                last_scan_progress_at = Some(Instant::now());
                if startup_burst_deadline
                    .map(|deadline| deadline <= Instant::now())
                    .unwrap_or(false)
                {
                    startup_burst_deadline = None;
                }
            }
            event = events.next() => {
                let Some(event) = event else {
                    break;
                };

                match event {
                    CentralEvent::StateUpdate(state) => {
                        writer.send(&Event::GatewayState {
                            gateway: GatewayStatePayload {
                                adapter_state: normalize_adapter_state(state),
                                scan_state: if scanning { "scanning" } else { "stopped" }.to_string(),
                                scan_reason: if scanning {
                                    scan_reason(
                                        &allowed_nodes.read().await,
                                        &connected_nodes,
                                        &reconnect_states,
                                        manual_scan_deadline,
                                        Instant::now(),
                                    )
                                    .map(str::to_string)
                                } else {
                                    None
                                },
                                selected_adapter_id: Some(selected_adapter_id.clone()),
                                last_advertisement_at: last_advertisement_at.clone(),
                                issue: None,
                            }
                        }).await?;
                    }
                    CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                        if !scanning {
                            continue;
                        }

                        advertisements_seen_this_burst =
                            advertisements_seen_this_burst.saturating_add(1);

                        let Some(peripheral) =
                            peripheral_for_event(&adapter, &writer, "device_discovered", &id).await
                        else {
                            continue;
                        };
                        let allowed = allowed_nodes.read().await.clone();
                        let discovery_scan_reason = scan_reason(
                            &allowed,
                            &connected_nodes,
                            &reconnect_states,
                            manual_scan_deadline,
                            Instant::now(),
                        );
                        if let Some(candidate) = discovery_candidate_for_event(
                            &peripheral,
                            &writer,
                            "device_discovered",
                            &config,
                            &allowed,
                            &known_device_ids,
                            allow_approved_identity_fallback(
                                &allowed,
                                &connected_nodes,
                                &reconnect_states,
                                manual_scan_deadline,
                                Instant::now(),
                            ),
                        )
                        .await
                        {
                            let node = candidate.node;
                            let device_record = node.address.as_ref().map(|address| {
                                device_registry.upsert(AdvertisementSnapshot {
                                    address: address.clone(),
                                    local_name: node.local_name.clone(),
                                    service_uuids: candidate.service_uuids.clone(),
                                    rssi: node.last_rssi,
                                    seen_at: node
                                        .last_seen_at
                                        .clone()
                                        .unwrap_or_else(|| last_advertisement_at.clone().unwrap_or_default()),
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
                                    classified_candidates_this_burst =
                                        classified_candidates_this_burst.saturating_add(1);
                                    last_scan_progress_at = Some(Instant::now());
                                }
                            } else {
                                classified_candidates_this_burst =
                                    classified_candidates_this_burst.saturating_add(1);
                                last_scan_progress_at = Some(Instant::now());
                            }
                            last_advertisement_at = node.last_seen_at.clone();
                            writer.send(&Event::NodeDiscovered {
                                node: node.clone(),
                                scan_reason: discovery_scan_reason.map(str::to_string),
                            }).await?;
                            writer.send(&Event::GatewayState {
                                gateway: GatewayStatePayload {
                                    adapter_state: normalize_adapter_state(adapter.adapter_state().await.unwrap_or(CentralState::Unknown)),
                                    scan_state: "scanning".to_string(),
                                    scan_reason: discovery_scan_reason.map(str::to_string),
                                    selected_adapter_id: Some(selected_adapter_id.clone()),
                                    last_advertisement_at: last_advertisement_at.clone(),
                                    issue: None,
                                }
                            }).await?;

                            if is_approved(&node, &allowed) {
                                let Some(rule_id) = approved_rule_id_for_node(&node, &allowed) else {
                                    continue;
                                };
                                if !reconnect_ready {
                                    emit_verbose_log(
                                        &writer,
                                        config.verbose_logging,
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
                                    continue;
                                }
                                let key = node.peripheral_id.clone().unwrap_or_else(|| node.id.clone());
                                let mut active = active_connections.lock().await;
                                let reconnect_state =
                                    reconnect_states.get(&rule_id).cloned().unwrap_or_default();
                                let Some(next_attempt) = next_reconnect_attempt(
                                    &reconnect_state,
                                    active.contains_key(&key),
                                ) else {
                                    if reconnect_state.attempt >= RECONNECT_ATTEMPT_LIMIT
                                        && !reconnect_state.retry_exhausted
                                    {
                                        reconnect_states.insert(
                                            rule_id.clone(),
                                            ApprovedReconnectState {
                                                attempt: reconnect_state.attempt,
                                                retry_exhausted: true,
                                            },
                                        );
                                    }
                                    drop(active);
                                    continue;
                                };
                                writer.send(&Event::Log {
                                    level: "info".to_string(),
                                    message: format!(
                                        "Approved node rediscovered; starting reconnect attempt for {}.",
                                        node.label
                                    ),
                                    details: Some(json!({
                                        "peripheralId": node.peripheral_id,
                                        "knownDeviceId": node.known_device_id,
                                        "address": node.address,
                                        "reconnectAttempt": next_attempt,
                                        "reconnectAttemptLimit": RECONNECT_ATTEMPT_LIMIT,
                                        "runtimeServiceMatched": candidate.classification.runtime_service_matched,
                                        "approvedIdentityMatched": candidate.classification.approved_identity_matched,
                                        "namePrefixMatched": candidate.classification.name_prefix_matched,
                                        "sightingsInEpoch": device_record
                                            .as_ref()
                                            .map(|record| record.sightings_in_epoch),
                                        "manualRecovery": manual_recover_rule_id
                                            .as_ref()
                                            .map(|target| target == &rule_id)
                                            .unwrap_or(false),
                                    })),
                                }).await?;
                                reconnect_states.insert(
                                    rule_id.clone(),
                                    ApprovedReconnectState {
                                        attempt: next_attempt,
                                        retry_exhausted: false,
                                    },
                                );
                                if scanning {
                                    let _ = adapter.stop_scan().await;
                                    scanning = false;
                                    current_scan_reason = None;
                                    writer.send(&Event::Log {
                                        level: "info".to_string(),
                                        message: "Pausing BLE scan while reconnect handshake is in flight.".to_string(),
                                        details: Some(json!({
                                            "peripheralId": node.peripheral_id,
                                            "knownDeviceId": node.known_device_id,
                                            "address": node.address,
                                            "reconnectAttempt": next_attempt,
                                        })),
                                    }).await?;
                                    emit_gateway_state(
                                        &writer,
                                        &adapter,
                                        &selected_adapter_id,
                                        "stopped",
                                        None,
                                        &last_advertisement_at,
                                    )
                                    .await?;
                                    last_scan_progress_at = None;
                                    startup_burst_deadline = None;
                                }
                                let manual_recover_rule_id_for_log = manual_recover_rule_id
                                    .as_ref()
                                    .map(|target| target == &rule_id)
                                    .unwrap_or(false);
                                active.insert(key.clone(), node.clone());
                                drop(active);
                                let writer_clone = writer.clone();
                                let config_clone = config.clone();
                                let allowed_nodes_clone = allowed_nodes.clone();
                                let active_connections_clone = active_connections.clone();
                                let known_device_ids_clone = known_device_ids.clone();
                                let command_tx_clone = command_sender.clone();
                                let shutdown_clone = shutdown.clone();
                                tokio::spawn(async move {
                                    let result = connect_and_stream(
                                        peripheral,
                                        node.clone(),
                                        writer_clone.clone(),
                                        config_clone,
                                        allowed_nodes_clone,
                                        known_device_ids_clone,
                                        Some(ReconnectStatus {
                                            attempt: next_attempt,
                                            attempt_limit: RECONNECT_ATTEMPT_LIMIT,
                                            retry_exhausted: false,
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
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                    })),
                                                })
                                                .await;
                                            let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                                                node,
                                                reason: if manual_recover_rule_id_for_log {
                                                    format!("manual recovery failed: {reason}")
                                                } else {
                                                    reason
                                                },
                                            });
                                        }
                                        Ok(None) => {}
                                        Err(error) => {
                                            let _ = writer_clone
                                                .send(&Event::Log {
                                                    level: "warn".to_string(),
                                                    message: format!("BLE connect failed: {error}"),
                                                    details: Some(json!({
                                                        "peripheralId": node.peripheral_id,
                                                        "knownDeviceId": node.known_device_id,
                                                        "address": node.address,
                                                    })),
                                                })
                                                .await;
                                            let _ = command_tx_clone.send(SessionCommand::ConnectionEnded {
                                                node,
                                                reason: if manual_recover_rule_id_for_log {
                                                    format!("manual recovery failed: {}", error)
                                                } else {
                                                    error.to_string()
                                                },
                                            });
                                        }
                                    }
                                    active_connections_clone.lock().await.remove(&key);
                                });
                            }
                        }
                        else {
                            rejected_candidates_this_burst =
                                rejected_candidates_this_burst.saturating_add(1);
                        }
                    }
                    CentralEvent::DeviceDisconnected(id) => {
                        let Some(peripheral) = peripheral_for_event(
                            &adapter,
                            &writer,
                            "device_disconnected",
                            &id,
                        )
                        .await
                        else {
                            continue;
                        };
                        let allowed = allowed_nodes.read().await.clone();
                        if let Some(candidate) = discovery_candidate_for_event(
                            &peripheral,
                            &writer,
                            "device_disconnected",
                            &config,
                            &allowed,
                            &known_device_ids,
                            allow_approved_identity_fallback(
                                &allowed,
                                &connected_nodes,
                                &reconnect_states,
                                manual_scan_deadline,
                                Instant::now(),
                            ),
                        )
                        .await
                        {
                            let node = candidate.node;
                            let reconnect =
                                reconnect_status_for_rule(
                                    approved_rule_id_for_node(&node, &allowed).as_deref(),
                                    &reconnect_states,
                                );
                            sleep(Duration::from_millis(DISCONNECT_CONFIRM_MS)).await;
                            if peripheral.is_connected().await.unwrap_or(false) {
                                writer.send(&Event::Log {
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
                                }).await?;
                                continue;
                            }

                            connected_nodes.remove(&node_key(&node));
                            writer.send(&Event::NodeConnectionState {
                                node,
                                gateway_connection_state: "disconnected".to_string(),
                                reason: Some("Device disconnected.".to_string()),
                                reconnect,
                            }).await?;
                            sync_scan_state(
                                &adapter,
                                &writer,
                                &config,
                                &selected_adapter_id,
                                &allowed,
                                &connected_nodes,
                                &reconnect_states,
                                &mut device_registry,
                                &mut scanning,
                                &mut current_scan_reason,
                                manual_scan_deadline,
                                &last_advertisement_at,
                                &mut last_scan_progress_at,
                                &mut startup_burst_deadline,
                            )
                            .await?;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if scanning {
        let _ = adapter.stop_scan().await;
    }
    if let Ok(peripherals) = adapter.peripherals().await {
        for peripheral in peripherals {
            if peripheral.is_connected().await.unwrap_or(false) {
                let _ = peripheral.disconnect().await;
            }
        }
    }
    let _ = adapter.clear_peripherals().await;
    writer
        .send(&Event::GatewayState {
            gateway: GatewayStatePayload {
                adapter_state: normalize_adapter_state(
                    adapter
                        .adapter_state()
                        .await
                        .unwrap_or(CentralState::Unknown),
                ),
                scan_state: "stopped".to_string(),
                scan_reason: None,
                selected_adapter_id: Some(selected_adapter_id),
                last_advertisement_at,
                issue: None,
            },
        })
        .await?;
    Ok(())
}

async fn peripheral_for_event(
    adapter: &Adapter,
    writer: &EventWriter,
    event_name: &str,
    id: &btleplug::platform::PeripheralId,
) -> Option<Peripheral> {
    match adapter.peripheral(id).await {
        Ok(peripheral) => Some(peripheral),
        Err(error) => {
            writer
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

async fn peripheral_for_node(adapter: &Adapter, node: &DiscoveredNode) -> Option<Peripheral> {
    let target_id = node.peripheral_id.as_deref()?;
    let peripherals = adapter.peripherals().await.ok()?;

    peripherals
        .into_iter()
        .find(|peripheral| peripheral.id().to_string() == target_id)
}

async fn disconnect_nodes_for_shutdown(
    adapter: &Adapter,
    writer: &EventWriter,
    nodes: &[DiscoveredNode],
) {
    for node in nodes {
        let Some(peripheral) = peripheral_for_node(adapter, node).await else {
            continue;
        };

        if !peripheral.is_connected().await.unwrap_or(false) {
            continue;
        }

        let _ = writer
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

async fn discovery_candidate_for_event(
    peripheral: &Peripheral,
    writer: &EventWriter,
    event_name: &str,
    config: &Config,
    allowed: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    allow_approved_identity_fallback: bool,
) -> Option<DiscoveryCandidate> {
    match discovery_candidate_from_peripheral(
        peripheral,
        config,
        allowed,
        known_device_ids,
        allow_approved_identity_fallback,
    )
    .await
    {
        Ok(node) => node,
        Err(error) => {
            writer
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

async fn connect_and_stream(
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
                                .map(ToString::to_string),
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
                        "error": error.to_string(),
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
                    "error": error.to_string(),
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
            || !is_subscription_setup_error(error)
            || !peripheral.is_connected().await.unwrap_or(false)
        {
            break;
        }

        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: "Runtime characteristic subscribe was not ready; retrying setup once before disconnecting.".to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                    "setupAttempt": setup_attempt,
                    "setupAttemptLimit": PRE_SESSION_SETUP_ATTEMPTS,
                    "error": error.to_string(),
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
                            "error": error.to_string(),
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
    let (lease_shutdown_tx, mut lease_shutdown_rx) = watch::channel(false);
    let (lease_failure_tx, mut lease_failure_rx) = mpsc::unbounded_channel::<String>();
    let lease_peripheral = peripheral.clone();
    let lease_characteristic = control_characteristic.clone();
    let lease_session_id = app_session_id.clone();
    let lease_task = tokio::spawn(async move {
        let mut lease_heartbeat =
            tokio::time::interval(Duration::from_millis(APP_SESSION_HEARTBEAT_MS));
        lease_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        lease_heartbeat.tick().await;

        loop {
            tokio::select! {
                changed = lease_shutdown_rx.changed() => {
                    if changed.is_ok() && *lease_shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = lease_heartbeat.tick() => {
                    if let Err(error) = send_app_session_lease(
                        &lease_peripheral,
                        &lease_characteristic,
                        &lease_session_id,
                    ).await {
                        let _ = lease_failure_tx.send(error.to_string());
                        break;
                    }
                }
            }
        }
    });

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
                                    &control_characteristic,
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
                            &control_characteristic,
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
                        &control_characteristic,
                        &app_session_nonce,
                    )
                        .await
                        .with_context(|| format!("app-session-bootstrap retry failed for {}", node.label))?;
                    send_app_session_lease(&peripheral, &control_characteristic, &app_session_id)
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

fn is_subscription_setup_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("status subscribe step failed") || message.contains("subscribe step failed")
}

fn normalize_adapter_state(state: CentralState) -> String {
    match state {
        CentralState::PoweredOn => "poweredOn",
        CentralState::PoweredOff => "poweredOff",
        CentralState::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::approval::{
        all_approved_nodes_connected, classify_discovery_candidate, reconnect_candidate_ready,
        APPROVED_RECONNECT_SCAN_BURST_MS, APPROVED_RECONNECT_STALL_MS,
    };
    use super::handshake::control_command_frames;
    use super::registry::DeviceRecord;
    use super::{
        allow_approved_identity_fallback, approved_nodes_pending_connection,
        approved_rule_id_for_node, disconnected_nodes_removed_from_allowed, is_approved,
        mark_node_connected, next_reconnect_attempt, node_key, prune_reconnect_states, scan_reason,
        should_clear_reconnect_peripherals, should_restart_approved_reconnect_scan, should_scan,
        ApprovedReconnectState, Config, APPROVED_RECONNECT_STARTUP_BURST_MS,
        RECONNECT_ATTEMPT_LIMIT,
    };
    use crate::protocol::{ApprovedNodeRule, DiscoveredNode};
    use serde_json::Value;
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    #[test]
    fn frames_runtime_control_commands_for_firmware_parser() {
        let frames = control_command_frames(r#"{"type":"sync-now"}"#);

        assert_eq!(frames.first().map(Vec::as_slice), Some(&b"BEGIN:19"[..]));
        assert_eq!(
            frames.get(1).map(Vec::as_slice),
            Some(&br#"{"type":"sync-now"}"#[..])
        );
        assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
    }

    #[test]
    fn frames_app_session_bootstrap_commands_for_firmware_parser() {
        let payload = r#"{"type":"app-session-bootstrap","sessionNonce":"nonce-1"}"#;
        let frames = control_command_frames(payload);

        assert_eq!(
            frames.first().map(Vec::as_slice),
            Some(format!("BEGIN:{}", payload.len()).as_bytes())
        );
        assert_eq!(frames.get(1).map(Vec::as_slice), Some(payload.as_bytes()));
        assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
    }

    #[test]
    fn frames_app_session_lease_commands_for_firmware_parser() {
        let payload = format!(
            r#"{{"type":"app-session-lease","sessionId":"session-1","expiresInMs":{}}}"#,
            15_000
        );
        let frames = control_command_frames(&payload);

        assert_eq!(
            frames.first().map(Vec::as_slice),
            Some(format!("BEGIN:{}", payload.len()).as_bytes())
        );

        let body = frames[1..frames.len() - 1]
            .iter()
            .flat_map(|frame| frame.iter().copied())
            .collect::<Vec<_>>();
        let decoded: Value =
            serde_json::from_slice(&body).expect("lease payload should decode as JSON");

        assert_eq!(decoded["type"], "app-session-lease");
        assert_eq!(decoded["sessionId"], "session-1");
        assert_eq!(decoded["expiresInMs"], 15_000);
        assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
    }

    #[test]
    fn scan_policy_stays_active_while_approved_nodes_are_missing() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let connected = HashMap::new();
        let reconnect_states = HashMap::new();

        assert!(approved_nodes_pending_connection(
            &rules,
            &connected,
            &reconnect_states
        ));
        assert!(should_scan(
            &rules,
            &connected,
            &reconnect_states,
            None,
            Instant::now()
        ));
    }

    #[test]
    fn scan_policy_stops_once_all_approved_nodes_are_connected_without_manual_scan() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let mut connected = HashMap::new();
        let reconnect_states = HashMap::new();
        connected.insert(
            "peripheral-1".to_string(),
            DiscoveredNode {
                id: "peripheral:peripheral-1".to_string(),
                label: "Bench".to_string(),
                peripheral_id: Some("peripheral-1".to_string()),
                address: None,
                local_name: None,
                known_device_id: None,
                last_rssi: None,
                last_seen_at: None,
            },
        );

        assert!(!approved_nodes_pending_connection(
            &rules,
            &connected,
            &reconnect_states
        ));
        assert!(!should_scan(
            &rules,
            &connected,
            &reconnect_states,
            None,
            Instant::now()
        ));
    }

    #[test]
    fn exhausted_approved_nodes_no_longer_keep_reconnect_scan_active() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let connected = HashMap::new();
        let reconnect_states = HashMap::from([(
            "node-1".to_string(),
            ApprovedReconnectState {
                attempt: 20,
                retry_exhausted: true,
            },
        )]);

        assert!(!approved_nodes_pending_connection(
            &rules,
            &connected,
            &reconnect_states
        ));
        assert!(!should_scan(
            &rules,
            &connected,
            &reconnect_states,
            None,
            Instant::now()
        ));
    }

    #[test]
    fn healthy_connections_clear_pending_reconnect_even_without_device_connected_event() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: Some("AA:BB".to_string()),
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: Some("stack-001".to_string()),
        }];
        let mut connected = HashMap::new();
        let mut reconnect_states = HashMap::from([(
            "node-1".to_string(),
            ApprovedReconnectState {
                attempt: 7,
                retry_exhausted: false,
            },
        )]);
        let node = DiscoveredNode {
            id: "known:stack-001".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: Some("AA:BB".to_string()),
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: Some("stack-001".to_string()),
            last_rssi: None,
            last_seen_at: None,
        };

        mark_node_connected(&mut connected, &mut reconnect_states, &node, &rules);

        assert!(!approved_nodes_pending_connection(
            &rules,
            &connected,
            &reconnect_states
        ));
        assert_eq!(
            reconnect_states.get("node-1").map(|state| state.attempt),
            Some(0)
        );
    }

    #[test]
    fn reconnect_scan_does_not_clear_peripherals_during_silent_retry_bursts() {
        let connected = HashMap::new();

        assert!(!should_clear_reconnect_peripherals(&connected, 1));
        assert!(!should_clear_reconnect_peripherals(&connected, 0));
    }

    #[test]
    fn refresh_scan_policy_prunes_exhausted_rules_that_are_no_longer_allowed() {
        let allowed = vec![ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-2".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let mut reconnect_states = HashMap::from([
            (
                "node-1".to_string(),
                ApprovedReconnectState {
                    attempt: 20,
                    retry_exhausted: true,
                },
            ),
            (
                "node-2".to_string(),
                ApprovedReconnectState {
                    attempt: 2,
                    retry_exhausted: false,
                },
            ),
        ]);

        prune_reconnect_states(&mut reconnect_states, &allowed);

        assert!(!reconnect_states.contains_key("node-1"));
        assert_eq!(
            reconnect_states.get("node-2").map(|state| state.attempt),
            Some(2)
        );
    }

    #[test]
    fn next_reconnect_attempt_stops_when_limit_is_reached_or_connection_is_active() {
        let state = ApprovedReconnectState {
            attempt: RECONNECT_ATTEMPT_LIMIT,
            retry_exhausted: false,
        };

        assert!(next_reconnect_attempt(&state, false).is_none());
        assert!(next_reconnect_attempt(&ApprovedReconnectState::default(), true).is_none());
        assert_eq!(
            next_reconnect_attempt(
                &ApprovedReconnectState {
                    attempt: 3,
                    retry_exhausted: false,
                },
                false,
            ),
            Some(4)
        );
    }

    #[test]
    fn approved_reconnect_scan_restart_pauses_while_a_handshake_is_active() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];

        assert!(!should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            Instant::now(),
            Some(Instant::now() - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
            Some(Instant::now() + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
            1,
        ));

        assert!(should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            Instant::now(),
            Some(Instant::now() - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
            None,
            0,
        ));
    }

    #[test]
    fn approved_reconnect_scan_restart_waits_for_a_real_stall() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let now = Instant::now();

        assert!(!should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            now,
            Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS - 1)),
            None,
            0,
        ));
        assert!(should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            now,
            Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
            None,
            0,
        ));
    }

    #[test]
    fn approved_reconnect_scan_restart_is_more_aggressive_during_startup_burst() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let now = Instant::now();

        assert!(!should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            now,
            Some(now - Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS - 1)),
            Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
            0,
        ));
        assert!(should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            now,
            Some(now - Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS)),
            Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
            0,
        ));
    }

    #[test]
    fn removed_allowed_nodes_are_selected_for_disconnect() {
        let allowed = vec![ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench 2".to_string(),
            peripheral_id: Some("peripheral-2".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];
        let connected = HashMap::from([
            (
                "peripheral-1".to_string(),
                DiscoveredNode {
                    id: "peripheral:peripheral-1".to_string(),
                    label: "Bench 1".to_string(),
                    peripheral_id: Some("peripheral-1".to_string()),
                    address: None,
                    local_name: None,
                    known_device_id: None,
                    last_rssi: None,
                    last_seen_at: None,
                },
            ),
            (
                "peripheral-2".to_string(),
                DiscoveredNode {
                    id: "peripheral:peripheral-2".to_string(),
                    label: "Bench 2".to_string(),
                    peripheral_id: Some("peripheral-2".to_string()),
                    address: None,
                    local_name: None,
                    known_device_id: None,
                    last_rssi: None,
                    last_seen_at: None,
                },
            ),
        ]);

        let removed = disconnected_nodes_removed_from_allowed(&connected, &allowed);

        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].peripheral_id.as_deref(), Some("peripheral-1"));
    }

    #[test]
    fn shared_local_name_alone_does_not_make_a_node_approved() {
        let rules = vec![
            ApprovedNodeRule {
                id: "node-1".to_string(),
                label: "Bench A".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: None,
            },
            ApprovedNodeRule {
                id: "node-2".to_string(),
                label: "Bench B".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: None,
            },
        ];
        let node = DiscoveredNode {
            id: "peripheral:peripheral-9".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-9".to_string()),
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: None,
            last_rssi: None,
            last_seen_at: None,
        };

        assert!(!is_approved(&node, &rules));
    }

    #[test]
    fn approved_reconnect_scan_reason_stays_silent_without_manual_scan_window() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];

        assert_eq!(
            scan_reason(
                &rules,
                &HashMap::new(),
                &HashMap::new(),
                None,
                Instant::now()
            ),
            Some("approved-reconnect")
        );
    }

    #[test]
    fn manual_scan_reason_overrides_silent_reconnect_when_operator_starts_scan() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];

        assert_eq!(
            scan_reason(
                &rules,
                &HashMap::new(),
                &HashMap::new(),
                Some(Instant::now() + Duration::from_secs(5)),
                Instant::now(),
            ),
            Some("manual")
        );
    }

    #[test]
    fn approved_identity_fallback_applies_while_any_approved_node_is_still_missing() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];

        assert!(allow_approved_identity_fallback(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            Instant::now()
        ));

        let mut connected_nodes = HashMap::new();
        connected_nodes.insert(
            "node-1".to_string(),
            DiscoveredNode {
                id: "stack-node-1".to_string(),
                label: "Bench".to_string(),
                address: None,
                local_name: Some("GymMotion-bench".to_string()),
                last_rssi: None,
                last_seen_at: None,
                peripheral_id: Some("peripheral-1".to_string()),
                known_device_id: None,
            },
        );

        assert!(!allow_approved_identity_fallback(
            &rules,
            &connected_nodes,
            &HashMap::new(),
            None,
            Instant::now()
        ));
    }

    #[test]
    fn manual_scan_reason_does_not_disable_approved_identity_fallback_for_missing_nodes() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        }];

        assert_eq!(
            scan_reason(
                &rules,
                &HashMap::new(),
                &HashMap::new(),
                Some(Instant::now() + Duration::from_secs(5)),
                Instant::now(),
            ),
            Some("manual")
        );

        assert!(allow_approved_identity_fallback(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            Some(Instant::now() + Duration::from_secs(5)),
            Instant::now()
        ));
    }

    #[test]
    fn manual_scan_keeps_approved_identity_fallback_for_retry_exhausted_nodes() {
        let rules = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: Some("AA:BB".to_string()),
            local_name: None,
            known_device_id: None,
        }];
        let reconnect_states = HashMap::from([(
            "node-1".to_string(),
            ApprovedReconnectState {
                attempt: RECONNECT_ATTEMPT_LIMIT,
                retry_exhausted: true,
            },
        )]);
        let now = Instant::now();

        assert!(allow_approved_identity_fallback(
            &rules,
            &HashMap::new(),
            &reconnect_states,
            Some(now + Duration::from_secs(5)),
            now
        ));

        assert!(!allow_approved_identity_fallback(
            &rules,
            &HashMap::new(),
            &reconnect_states,
            None,
            now
        ));
    }

    #[test]
    fn approved_reconnect_candidate_matches_by_peripheral_id_without_service_uuid() {
        let config = Config {
            service_uuid: Uuid::nil(),
            telemetry_uuid: Uuid::nil(),
            control_uuid: Uuid::nil(),
            status_uuid: Uuid::nil(),
            device_name_prefix: "GymMotion-".to_string(),
            verbose_logging: false,
        };
        let allowed = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: Some("stack-001".to_string()),
        }];

        let classification = classify_discovery_candidate(
            "peripheral-1",
            Some("AA:BB"),
            None,
            false,
            &config,
            &allowed,
            &HashMap::new(),
        );

        assert!(classification.approved_identity_matched);
        assert_eq!(
            classification.matched_known_device_id.as_deref(),
            Some("stack-001")
        );
        assert!(!classification.runtime_service_matched);
        assert!(!classification.name_prefix_matched);
    }

    #[test]
    fn approved_reconnect_candidate_matches_by_address_without_service_uuid() {
        let config = Config {
            service_uuid: Uuid::nil(),
            telemetry_uuid: Uuid::nil(),
            control_uuid: Uuid::nil(),
            status_uuid: Uuid::nil(),
            device_name_prefix: "GymMotion-".to_string(),
            verbose_logging: false,
        };
        let allowed = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: None,
            address: Some("AA:BB".to_string()),
            local_name: None,
            known_device_id: Some("stack-001".to_string()),
        }];

        let classification = classify_discovery_candidate(
            "peripheral-2",
            Some("aa:bb"),
            None,
            false,
            &config,
            &allowed,
            &HashMap::new(),
        );

        assert!(classification.approved_identity_matched);
        assert_eq!(
            classification.matched_known_device_id.as_deref(),
            Some("stack-001")
        );
    }

    #[test]
    fn only_subscription_setup_failures_use_the_inline_setup_retry() {
        let subscribe_error = anyhow!("status subscribe step failed for Bench");
        let bootstrap_error = anyhow!("app-session-bootstrap step failed for Bench");

        assert!(is_subscription_setup_error(&subscribe_error));
        assert!(!is_subscription_setup_error(&bootstrap_error));
    }

    #[test]
    fn approved_reconnect_waits_for_stronger_signal_after_first_sparse_sighting() {
        let classification = classify_discovery_candidate(
            "peripheral-2",
            Some("aa:bb"),
            None,
            false,
            &Config {
                service_uuid: Uuid::nil(),
                telemetry_uuid: Uuid::nil(),
                control_uuid: Uuid::nil(),
                status_uuid: Uuid::nil(),
                device_name_prefix: "GymMotion-".to_string(),
                verbose_logging: false,
            },
            &[ApprovedNodeRule {
                id: "node-1".to_string(),
                label: "Bench".to_string(),
                peripheral_id: None,
                address: Some("AA:BB".to_string()),
                local_name: None,
                known_device_id: Some("stack-001".to_string()),
            }],
            &HashMap::new(),
        );

        let now = Instant::now();
        let record = DeviceRecord {
            address: "aa:bb".to_string(),
            local_name: None,
            service_uuids: Default::default(),
            rssi: Some(-50),
            last_seen_at: "2026-03-16T18:00:00.000Z".to_string(),
            reconnect_epoch: 1,
            sightings_in_epoch: 1,
            first_seen_at_monotonic: now,
            last_seen_at_monotonic: now,
        };

        assert!(!reconnect_candidate_ready(
            &classification,
            false,
            Some(&record),
        ));
    }

    #[test]
    fn approved_reconnect_requires_runtime_service_even_after_sparse_repeat_sighting() {
        let classification = classify_discovery_candidate(
            "peripheral-2",
            Some("aa:bb"),
            None,
            false,
            &Config {
                service_uuid: Uuid::nil(),
                telemetry_uuid: Uuid::nil(),
                control_uuid: Uuid::nil(),
                status_uuid: Uuid::nil(),
                device_name_prefix: "GymMotion-".to_string(),
                verbose_logging: false,
            },
            &[ApprovedNodeRule {
                id: "node-1".to_string(),
                label: "Bench".to_string(),
                peripheral_id: None,
                address: Some("AA:BB".to_string()),
                local_name: None,
                known_device_id: Some("stack-001".to_string()),
            }],
            &HashMap::new(),
        );

        let start = Instant::now();
        let record = DeviceRecord {
            address: "aa:bb".to_string(),
            local_name: None,
            service_uuids: Default::default(),
            rssi: Some(-50),
            last_seen_at: "2026-03-16T18:00:00.300Z".to_string(),
            reconnect_epoch: 1,
            sightings_in_epoch: 2,
            first_seen_at_monotonic: start,
            last_seen_at_monotonic: start + Duration::from_millis(300),
        };

        assert!(!reconnect_candidate_ready(
            &classification,
            false,
            Some(&record),
        ));
    }

    #[test]
    fn manual_discovery_stays_strict_when_only_approved_identity_matches() {
        let config = Config {
            service_uuid: Uuid::nil(),
            telemetry_uuid: Uuid::nil(),
            control_uuid: Uuid::nil(),
            status_uuid: Uuid::nil(),
            device_name_prefix: "GymMotion-".to_string(),
            verbose_logging: false,
        };
        let allowed = vec![ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: Some("stack-001".to_string()),
        }];

        let classification = classify_discovery_candidate(
            "peripheral-1",
            Some("AA:BB"),
            None,
            false,
            &config,
            &allowed,
            &HashMap::new(),
        );

        let manual_discovery_accepted =
            classification.runtime_service_matched || classification.name_prefix_matched;

        assert!(classification.approved_identity_matched);
        assert!(!manual_discovery_accepted);
    }

    #[test]
    fn approved_reconnect_does_not_match_shared_local_name_without_stronger_identity() {
        let config = Config {
            service_uuid: Uuid::nil(),
            telemetry_uuid: Uuid::nil(),
            control_uuid: Uuid::nil(),
            status_uuid: Uuid::nil(),
            device_name_prefix: "GymMotion-".to_string(),
            verbose_logging: false,
        };
        let allowed = vec![
            ApprovedNodeRule {
                id: "node-1".to_string(),
                label: "Bench A".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: Some("stack-001".to_string()),
            },
            ApprovedNodeRule {
                id: "node-2".to_string(),
                label: "Bench B".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: Some("stack-002".to_string()),
            },
        ];

        let classification = classify_discovery_candidate(
            "peripheral-9",
            None,
            Some("GymMotion-f4e9d4"),
            false,
            &config,
            &allowed,
            &HashMap::new(),
        );

        assert!(!classification.approved_identity_matched);
        assert!(classification.matched_known_device_id.is_none());
    }

    #[test]
    fn duplicate_name_only_rules_do_not_bind_one_connected_node_to_multiple_approvals() {
        let rules = vec![
            ApprovedNodeRule {
                id: "node-1".to_string(),
                label: "Bench A".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: None,
            },
            ApprovedNodeRule {
                id: "node-2".to_string(),
                label: "Bench B".to_string(),
                peripheral_id: None,
                address: None,
                local_name: Some("GymMotion-f4e9d4".to_string()),
                known_device_id: None,
            },
        ];
        let node = DiscoveredNode {
            id: "peripheral:peripheral-9".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-9".to_string()),
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: None,
            last_rssi: None,
            last_seen_at: None,
        };
        let connected = HashMap::from([(node_key(&node), node.clone())]);
        let reconnect_states = HashMap::new();

        assert!(approved_rule_id_for_node(&node, &rules).is_none());
        assert!(!all_approved_nodes_connected(
            &rules,
            &connected,
            &reconnect_states
        ));
    }
}
