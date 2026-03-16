use std::{
    collections::{HashMap, HashSet},
    env,
    future::pending,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{
        Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter, WriteType,
    },
    platform::{Adapter, Manager, Peripheral},
};
use futures::StreamExt;
use serde_json::json;
use tokio::{
    io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch, Mutex, RwLock},
    task::JoinHandle,
    time::sleep,
};
use uuid::Uuid;

use crate::{
    json_decoder::JsonObjectDecoder,
    protocol::{
        AdapterSummary, ApprovedNodeRule, Command, DiscoveredNode, Event, GatewayStatePayload,
        ReconnectStatus, RuntimeStatusPayload, TelemetryPayload,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const SERVICE_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001";
const TELEMETRY_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002";
const CONTROL_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003";
const STATUS_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004";
const DEVICE_PREFIX_FALLBACK: &str = "GymMotion-";
const SCAN_WINDOW_SECS: u64 = 15;
const DISCONNECT_CONFIRM_MS: u64 = 500;
const CONNECTION_HEALTH_POLL_MS: u64 = 2_000;
const APPROVED_RECONNECT_DIAGNOSTIC_MS: u64 = 10_000;
const APPROVED_RECONNECT_SCAN_BURST_MS: u64 = 4_000;
const APPROVED_RECONNECT_SCAN_RESTART_DELAY_MS: u64 = 300;
const APP_SESSION_HEARTBEAT_MS: u64 = 5_000;
const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
const SESSION_HEALTH_ACK_TIMEOUT_MS: u64 = 2_000;
const RECONNECT_ATTEMPT_LIMIT: u32 = 20;
const CONTROL_CHUNK_SIZE: usize = 120;
const GATT_SETUP_RETRY_ATTEMPTS: u32 = 3;
const GATT_SETUP_RETRY_DELAY_MS: u64 = 750;
const SERVICE_DISCOVERY_RETRY_ATTEMPTS: u32 = 3;

#[derive(Clone)]
struct Config {
    service_uuid: Uuid,
    telemetry_uuid: Uuid,
    control_uuid: Uuid,
    status_uuid: Uuid,
    device_name_prefix: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            service_uuid: parse_uuid("BLE_RUNTIME_SERVICE_UUID", SERVICE_UUID_FALLBACK)?,
            telemetry_uuid: parse_uuid("BLE_TELEMETRY_UUID", TELEMETRY_UUID_FALLBACK)?,
            control_uuid: parse_uuid("BLE_CONTROL_UUID", CONTROL_UUID_FALLBACK)?,
            status_uuid: parse_uuid("BLE_STATUS_UUID", STATUS_UUID_FALLBACK)?,
            device_name_prefix: env::var("BLE_DEVICE_NAME_PREFIX")
                .unwrap_or_else(|_| DEVICE_PREFIX_FALLBACK.to_string()),
        })
    }
}

fn parse_uuid(name: &str, fallback: &str) -> Result<Uuid> {
    let raw = env::var(name).unwrap_or_else(|_| fallback.to_string());
    Ok(Uuid::parse_str(&raw).with_context(|| format!("invalid {name}: {raw}"))?)
}

#[derive(Clone)]
struct EventWriter {
    inner: Arc<Mutex<io::Stdout>>,
}

impl EventWriter {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(io::stdout())),
        }
    }

    async fn send(&self, event: &Event) -> Result<()> {
        let encoded = serde_json::to_string(event)?;
        let mut stdout = self.inner.lock().await;
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
        Ok(())
    }
    async fn error(&self, message: impl Into<String>, details: Option<serde_json::Value>) {
        let _ = self
            .send(&Event::Error {
                message: message.into(),
                details,
            })
            .await;
    }
}

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

#[derive(Clone, Debug, Default)]
struct ApprovedReconnectState {
    attempt: u32,
    retry_exhausted: bool,
}

#[derive(Clone, Debug)]
struct DiscoveryClassification {
    runtime_service_matched: bool,
    name_prefix_matched: bool,
    approved_identity_matched: bool,
    matched_known_device_id: Option<String>,
}

fn approved_rule_id_for_node(node: &DiscoveredNode, rules: &[ApprovedNodeRule]) -> Option<String> {
    rules.iter()
        .find(|rule| rule_matches_node(rule, node, rules))
        .map(|rule| rule.id.clone())
}

fn disconnected_nodes_removed_from_allowed(
    connected_nodes: &HashMap<String, DiscoveredNode>,
    allowed: &[ApprovedNodeRule],
) -> Vec<DiscoveredNode> {
    connected_nodes
        .values()
        .filter(|node| !is_approved(node, allowed))
        .cloned()
        .collect()
}

fn reconnect_status_for_rule(
    rule_id: Option<&str>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> Option<ReconnectStatus> {
    rule_id.map(|id| {
        let state = reconnect_states.get(id).cloned().unwrap_or_default();
        ReconnectStatus {
            attempt: state.attempt,
            attempt_limit: RECONNECT_ATTEMPT_LIMIT,
            retry_exhausted: state.retry_exhausted,
        }
    })
}

fn mark_node_connected(
    connected_nodes: &mut HashMap<String, DiscoveredNode>,
    reconnect_states: &mut HashMap<String, ApprovedReconnectState>,
    node: &DiscoveredNode,
    allowed: &[ApprovedNodeRule],
) {
    connected_nodes.insert(node_key(node), node.clone());

    if let Some(rule_id) = approved_rule_id_for_node(node, allowed) {
        reconnect_states.insert(rule_id, ApprovedReconnectState::default());
    }
}

fn prune_reconnect_states(
    reconnect_states: &mut HashMap<String, ApprovedReconnectState>,
    allowed: &[ApprovedNodeRule],
) {
    let allowed_rule_ids = allowed
        .iter()
        .map(|rule| rule.id.as_str())
        .collect::<HashSet<_>>();
    reconnect_states.retain(|rule_id, _| allowed_rule_ids.contains(rule_id.as_str()));
}

fn should_clear_reconnect_peripherals(
    connected_nodes: &HashMap<String, DiscoveredNode>,
    active_connection_count: usize,
) -> bool {
    connected_nodes.is_empty() && active_connection_count == 0
}

fn classify_discovery_candidate(
    peripheral_id: &str,
    address: Option<&str>,
    local_name: Option<&str>,
    has_runtime_service: bool,
    config: &Config,
    allowed_nodes: &[ApprovedNodeRule],
    known_device_ids: &HashMap<String, String>,
) -> DiscoveryClassification {
    let name_prefix_matched = local_name
        .map(|name| !config.device_name_prefix.is_empty() && name.starts_with(&config.device_name_prefix))
        .unwrap_or(false);
    let unique_local_name_rule = local_name.and_then(|candidate_name| {
        let mut matches = allowed_nodes.iter().filter(|rule| {
            rule.known_device_id.is_none()
                && rule.peripheral_id.is_none()
                && rule.address.is_none()
                && rule
                    .local_name
                    .as_ref()
                    .map(|value| value == candidate_name)
                    .unwrap_or(false)
        });
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(first)
    });
    let matched_known_device_id = known_device_ids.get(peripheral_id).cloned().or_else(|| {
        allowed_nodes.iter().find_map(|rule| {
            if rule
                .peripheral_id
                .as_ref()
                .map(|value| value == peripheral_id)
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            if rule
                .address
                .as_ref()
                .zip(address)
                .map(|(left, right)| left.eq_ignore_ascii_case(right))
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            if unique_local_name_rule
                .map(|unique_rule| unique_rule.id == rule.id)
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            None
        })
    });

    DiscoveryClassification {
        runtime_service_matched: has_runtime_service,
        name_prefix_matched,
        approved_identity_matched: matched_known_device_id.is_some()
            || allowed_nodes.iter().any(|rule| {
                rule.peripheral_id
                    .as_ref()
                    .map(|value| value == peripheral_id)
                    .unwrap_or(false)
                    || rule
                        .address
                        .as_ref()
                        .zip(address)
                        .map(|(left, right)| left.eq_ignore_ascii_case(right))
                        .unwrap_or(false)
                    || unique_local_name_rule
                        .map(|unique_rule| unique_rule.id == rule.id)
                        .unwrap_or(false)
            }),
        matched_known_device_id,
    }
}

fn approved_nodes_pending_connection(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> bool {
    !rules.is_empty() && !all_approved_nodes_connected(rules, connected_nodes, reconnect_states)
}

fn should_scan(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    approved_nodes_pending_connection(rules, connected_nodes, reconnect_states)
        || manual_scan_deadline
            .map(|deadline| deadline > now)
            .unwrap_or(false)
}

fn scan_reason(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> Option<&'static str> {
    if manual_scan_deadline
        .map(|deadline| deadline > now)
        .unwrap_or(false)
    {
        return Some("manual");
    }

    if approved_nodes_pending_connection(rules, connected_nodes, reconnect_states) {
        return Some("approved-reconnect");
    }

    None
}

fn allow_approved_identity_fallback(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    if approved_nodes_pending_connection(rules, connected_nodes, reconnect_states) {
        return true;
    }

    let manual_scan_active = manual_scan_deadline
        .map(|deadline| deadline > now)
        .unwrap_or(false);
    if !manual_scan_active {
        return false;
    }

    rules.iter().any(|rule| {
        reconnect_states
            .get(&rule.id)
            .map(|state| state.retry_exhausted)
            .unwrap_or(false)
    })
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

async fn sync_scan_state(
    adapter: &Adapter,
    writer: &EventWriter,
    selected_adapter_id: &str,
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    scanning: &mut bool,
    current_scan_reason: &mut Option<String>,
    manual_scan_deadline: Option<Instant>,
    last_advertisement_at: &Option<String>,
) -> Result<()> {
    let now = Instant::now();
    let should_scan_now =
        should_scan(allowed, connected_nodes, reconnect_states, manual_scan_deadline, now);
    let approved_pending =
        approved_nodes_pending_connection(allowed, connected_nodes, reconnect_states);
    let next_scan_reason =
        scan_reason(allowed, connected_nodes, reconnect_states, manual_scan_deadline, now);

    if should_scan_now && !*scanning {
        adapter.start_scan(ScanFilter::default()).await?;
        *scanning = true;
        *current_scan_reason = next_scan_reason.map(str::to_string);
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
        writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: "Stopping BLE scan window.".to_string(),
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

fn should_restart_approved_reconnect_scan(
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
    active_connection_count: usize,
) -> bool {
    if active_connection_count > 0 {
        return false;
    }

    scan_reason(
        allowed,
        connected_nodes,
        reconnect_states,
        manual_scan_deadline,
        now,
    ) == Some("approved-reconnect")
}

fn next_reconnect_attempt(state: &ApprovedReconnectState, active_for_node: bool) -> Option<u32> {
    if active_for_node || state.retry_exhausted || state.attempt >= RECONNECT_ATTEMPT_LIMIT {
        return None;
    }

    Some(state.attempt + 1)
}

fn node_key(node: &DiscoveredNode) -> String {
    node.peripheral_id
        .clone()
        .or_else(|| node.known_device_id.clone())
        .unwrap_or_else(|| node.id.clone())
}

fn unique_name_only_rule_id<'a>(
    local_name: Option<&str>,
    rules: &'a [ApprovedNodeRule],
) -> Option<&'a str> {
    let candidate_name = local_name?;
    let mut matches = rules.iter().filter(|rule| {
        rule.known_device_id.is_none()
            && rule.peripheral_id.is_none()
            && rule.address.is_none()
            && rule
                .local_name
                .as_ref()
                .map(|value| value == candidate_name)
                .unwrap_or(false)
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.id.as_str())
}

fn rule_matches_node(rule: &ApprovedNodeRule, node: &DiscoveredNode, rules: &[ApprovedNodeRule]) -> bool {
    let strong_identity_match = rule.known_device_id
        .as_ref()
        .zip(node.known_device_id.as_ref())
        .map(|(left, right)| left == right)
        .unwrap_or(false)
        || rule
            .peripheral_id
            .as_ref()
            .zip(node.peripheral_id.as_ref())
            .map(|(left, right)| left == right)
            .unwrap_or(false)
        || rule
            .address
            .as_ref()
            .zip(node.address.as_ref())
            .map(|(left, right)| left.eq_ignore_ascii_case(right))
            .unwrap_or(false);

    if strong_identity_match {
        return true;
    }

    unique_name_only_rule_id(node.local_name.as_deref(), rules)
        .map(|rule_id| rule_id == rule.id.as_str())
        .unwrap_or(false)
}

fn all_approved_nodes_connected(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> bool {
    !rules.is_empty()
        && rules.iter().all(|rule| {
            if reconnect_states
                .get(&rule.id)
                .map(|state| state.retry_exhausted)
                .unwrap_or(false)
            {
                return true;
            }

            connected_nodes
                .values()
                .any(|node| rule_matches_node(rule, node, rules))
        })
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
        let adapters = self.manager.adapters().await?;
        let mut summaries = Vec::with_capacity(adapters.len());

        for (index, adapter) in adapters.into_iter().enumerate() {
            let label = adapter
                .adapter_info()
                .await
                .unwrap_or_else(|_| format!("Bluetooth adapter {}", index + 1));
            let state = adapter
                .adapter_state()
                .await
                .unwrap_or(CentralState::Unknown);
            summaries.push(AdapterSummary {
                id: format!("winrt:{index}"),
                label,
                transport: "winrt".to_string(),
                is_available: state == CentralState::PoweredOn,
                issue: if state == CentralState::PoweredOff {
                    Some("Adapter is powered off.".to_string())
                } else {
                    None
                },
                details: vec![format!("state:{:?}", state)],
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
                    let _ = session
                        .commands
                        .send(SessionCommand::AllowedNodesUpdated {
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
    let app_session_id = Uuid::new_v4().to_string();
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
    let active_connections = Arc::new(Mutex::new(HashSet::<String>::new()));
    let known_device_ids = Arc::new(RwLock::new(HashMap::<String, String>::new()));
    let mut connected_nodes = HashMap::<String, DiscoveredNode>::new();
    let mut reconnect_states = HashMap::<String, ApprovedReconnectState>::new();
    let mut last_advertisement_at = None;
    let mut scanning = false;
    let mut current_scan_reason = None;
    let mut manual_scan_deadline = None;
    let mut manual_recover_rule_id: Option<String> = None;
    let mut reconnect_diagnostic_tick =
        tokio::time::interval(Duration::from_millis(APPROVED_RECONNECT_DIAGNOSTIC_MS));
    reconnect_diagnostic_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect_diagnostic_tick.tick().await;

    {
        let allowed = allowed_nodes.read().await.clone();
        sync_scan_state(
            &adapter,
            &writer,
            &selected_adapter_id,
            &allowed,
            &connected_nodes,
            &reconnect_states,
            &mut scanning,
            &mut current_scan_reason,
            manual_scan_deadline,
            &last_advertisement_at,
        )
        .await?;
    }

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
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
                            &selected_adapter_id,
                            &allowed,
                            &connected_nodes,
                            &reconnect_states,
                            &mut scanning,
                            &mut current_scan_reason,
                            manual_scan_deadline,
                            &last_advertisement_at,
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
                            &selected_adapter_id,
                            &allowed,
                            &connected_nodes,
                            &reconnect_states,
                            &mut scanning,
                            &mut current_scan_reason,
                            manual_scan_deadline,
                            &last_advertisement_at,
                        )
                        .await?;
                        continue;
                    }
                }

                let allowed = allowed_nodes.read().await.clone();
                sync_scan_state(
                    &adapter,
                    &writer,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    &mut scanning,
                    &mut current_scan_reason,
                    manual_scan_deadline,
                    &last_advertisement_at,
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
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &reconnect_states,
                    &mut scanning,
                    &mut current_scan_reason,
                    manual_scan_deadline,
                    &last_advertisement_at,
                )
                .await?;
            }
            _ = reconnect_diagnostic_tick.tick() => {
                let allowed = allowed_nodes.read().await.clone();
                if approved_nodes_pending_connection(&allowed, &connected_nodes, &reconnect_states) {
                    writer.send(&Event::Log {
                        level: "info".to_string(),
                        message: "Approved-node reconnect scan still running; waiting for rediscovery.".to_string(),
                        details: Some(json!({
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
                    }).await?;
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
                        if let Some(node) = discovered_node_for_event(
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
                                let key = node.peripheral_id.clone().unwrap_or_else(|| node.id.clone());
                                let mut active = active_connections.lock().await;
                                let reconnect_state =
                                    reconnect_states.get(&rule_id).cloned().unwrap_or_default();
                                let Some(next_attempt) = next_reconnect_attempt(
                                    &reconnect_state,
                                    active.contains(&key),
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
                                }
                                let manual_recover_rule_id_for_log = manual_recover_rule_id
                                    .as_ref()
                                    .map(|target| target == &rule_id)
                                    .unwrap_or(false);
                                active.insert(key.clone());
                                drop(active);
                                let writer_clone = writer.clone();
                                let config_clone = config.clone();
                                let allowed_nodes_clone = allowed_nodes.clone();
                                let active_connections_clone = active_connections.clone();
                                let known_device_ids_clone = known_device_ids.clone();
                                let command_tx_clone = command_sender.clone();
                                let app_session_id_clone = app_session_id.clone();
                                tokio::spawn(async move {
                                    let result = connect_and_stream(
                                        peripheral,
                                        node.clone(),
                                        writer_clone.clone(),
                                        config_clone,
                                        allowed_nodes_clone,
                                        known_device_ids_clone,
                                        app_session_id_clone,
                                        Some(ReconnectStatus {
                                            attempt: next_attempt,
                                            attempt_limit: RECONNECT_ATTEMPT_LIMIT,
                                            retry_exhausted: false,
                                        }),
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
                        if let Some(node) = discovered_node_for_event(
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
                                &selected_adapter_id,
                                &allowed,
                                &connected_nodes,
                                &reconnect_states,
                                &mut scanning,
                                &mut current_scan_reason,
                                manual_scan_deadline,
                                &last_advertisement_at,
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

async fn discovered_node_for_event(
    peripheral: &Peripheral,
    writer: &EventWriter,
    event_name: &str,
    config: &Config,
    allowed: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    allow_approved_identity_fallback: bool,
) -> Option<DiscoveredNode> {
    match discovered_node_from_peripheral(
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

async fn connect_and_stream(
    peripheral: Peripheral,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    app_session_id: String,
    reconnect: Option<ReconnectStatus>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
) -> Result<Option<String>> {
    let log_handshake_step = |step: &str| Event::Log {
        level: "info".to_string(),
        message: format!("Reconnect handshake step: {step}"),
        details: Some(json!({
            "peripheralId": node.peripheral_id,
            "knownDeviceId": node.known_device_id,
            "address": node.address,
            "reconnect": reconnect,
        })),
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

    for attempt in 1..=GATT_SETUP_RETRY_ATTEMPTS {
        writer
            .send(&Event::Log {
                level: "info".to_string(),
                message: format!(
                    "Reconnect handshake GATT setup attempt {attempt}/{GATT_SETUP_RETRY_ATTEMPTS}"
                ),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                })),
            })
            .await?;

        writer.send(&log_handshake_step("checking transport connection")).await?;
        let was_connected = peripheral.is_connected().await.unwrap_or(false);
        if !was_connected {
            writer.send(&log_handshake_step("calling peripheral.connect()")).await?;
            if let Err(error) = peripheral.connect().await {
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
                            "error": error.to_string(),
                        })),
                    })
                    .await?;
                last_gatt_error = Some(anyhow!(error).context(format!(
                    "connect step failed for {}",
                    node.label
                )));
            }
            sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
        }

        let connected_after_attempt = peripheral.is_connected().await.unwrap_or(false);
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

        for discovery_attempt in 1..=SERVICE_DISCOVERY_RETRY_ATTEMPTS {
            writer.send(&log_handshake_step("discovering services")).await?;
            match peripheral.discover_services().await {
                Ok(()) => {
                    gatt_ready = true;
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
                    last_gatt_error = Some(anyhow!(error).context(format!(
                        "discover_services step failed for {}",
                        node.label
                    )));
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

        if peripheral.is_connected().await.unwrap_or(false) {
            let _ = peripheral.disconnect().await;
            sleep(Duration::from_millis(100)).await;
        }
        sleep(Duration::from_millis(GATT_SETUP_RETRY_DELAY_MS)).await;
    }

    if !gatt_ready {
        return Err(anyhow!("gatt setup never became ready for {}", node.label));
    }

    let setup_result = async {
        writer
            .send(&log_handshake_step("resolving telemetry characteristic"))
            .await?;
        let characteristic = peripheral
            .characteristics()
            .into_iter()
            .find(|candidate| candidate.uuid == config.telemetry_uuid)
            .ok_or_else(|| anyhow!("telemetry characteristic not found"))?;
        writer
            .send(&log_handshake_step("resolving control characteristic"))
            .await?;
        let control_characteristic = peripheral
            .characteristics()
            .into_iter()
            .find(|candidate| candidate.uuid == config.control_uuid)
            .ok_or_else(|| anyhow!("runtime control characteristic not found"))?;
        writer
            .send(&log_handshake_step("resolving runtime status characteristic"))
            .await?;
        let status_characteristic = peripheral
            .characteristics()
            .into_iter()
            .find(|candidate| candidate.uuid == config.status_uuid)
            .ok_or_else(|| anyhow!("runtime status characteristic not found"))?;

        writer.send(&log_handshake_step("opening notifications stream")).await?;
        let notifications = peripheral
            .notifications()
            .await
            .with_context(|| format!("notifications step failed for {}", node.label))?;
        writer
            .send(&log_handshake_step("subscribing to runtime status"))
            .await?;
        peripheral
            .subscribe(&status_characteristic)
            .await
            .with_context(|| format!("status subscribe step failed for {}", node.label))?;
        writer.send(&log_handshake_step("subscribing to telemetry")).await?;
        peripheral
            .subscribe(&characteristic)
            .await
            .with_context(|| format!("subscribe step failed for {}", node.label))?;
        writer.send(&log_handshake_step("sending app-session bootstrap")).await?;
        send_app_session_bootstrap(&peripheral, &control_characteristic)
            .await
            .with_context(|| format!("app-session-bootstrap step failed for {}", node.label))?;
        writer.send(&log_handshake_step("sending app-session lease")).await?;
        send_app_session_lease(&peripheral, &control_characteristic, &app_session_id)
            .await
            .with_context(|| format!("app-session-lease step failed for {}", node.label))?;

        Ok::<_, anyhow::Error>((notifications, control_characteristic))
    }
    .await;

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

    writer
        .send(&log_handshake_step("waiting for session health ack"))
        .await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));
    let mut status_decoder = JsonObjectDecoder::new(format!("status:{}", node.label));
    let mut session_healthy_reported = false;
    let session_health_deadline = Instant::now() + Duration::from_millis(SESSION_HEALTH_ACK_TIMEOUT_MS);
    let session_health_sleep = tokio::time::sleep_until(session_health_deadline.into());
    tokio::pin!(session_health_sleep);
    let mut telemetry_fallback_node: Option<DiscoveredNode> = None;
    let mut ack_session_id: Option<String> = None;
    let mut ack_received = false;
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

                                if let Some(session_id) = status.session_id.clone() {
                                    if session_id != app_session_id {
                                        continue;
                                    }
                                    ack_session_id = Some(session_id);
                                }

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

                                if !session_healthy_reported {
                                    session_healthy_reported = true;
                                    let _ = command_sender.send(SessionCommand::ConnectionHealthy {
                                        node: enriched.clone(),
                                    });
                                    writer
                                        .send(&Event::NodeConnectionState {
                                            node: enriched.clone(),
                                            gateway_connection_state: "connected".to_string(),
                                            reason: None,
                                            reconnect: reconnect.clone(),
                                        })
                                        .await?;
                                    writer
                                        .send(&log_handshake_step("sending sync-now"))
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
            _ = &mut session_health_sleep, if !session_healthy_reported && !ack_received => {
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

async fn send_app_session_lease(
    peripheral: &Peripheral,
    characteristic: &btleplug::api::Characteristic,
    session_id: &str,
) -> Result<()> {
    let payload = json!({
        "type": "app-session-lease",
        "sessionId": session_id,
        "expiresInMs": APP_SESSION_LEASE_TIMEOUT_MS,
    })
    .to_string();
    write_chunked_json_command(peripheral, characteristic, &payload).await
}

async fn send_app_session_bootstrap(
    peripheral: &Peripheral,
    characteristic: &btleplug::api::Characteristic,
) -> Result<()> {
    write_chunked_json_command(
        peripheral,
        characteristic,
        r#"{"type":"app-session-bootstrap"}"#,
    )
    .await
}

async fn write_chunked_json_command(
    peripheral: &Peripheral,
    characteristic: &btleplug::api::Characteristic,
    payload: &str,
) -> Result<()> {
    for chunk in control_command_frames(payload) {
        peripheral
            .write(characteristic, &chunk, WriteType::WithResponse)
            .await?;
    }

    Ok(())
}

fn control_command_frames(payload: &str) -> Vec<Vec<u8>> {
    let mut frames = Vec::with_capacity((payload.len() / CONTROL_CHUNK_SIZE) + 2);
    frames.push(format!("BEGIN:{}", payload.len()).into_bytes());

    for chunk in payload.as_bytes().chunks(CONTROL_CHUNK_SIZE) {
        frames.push(chunk.to_vec());
    }

    frames.push(b"END".to_vec());
    frames
}

async fn discovered_node_from_peripheral(
    peripheral: &Peripheral,
    config: &Config,
    allowed_nodes: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    allow_approved_identity_fallback: bool,
) -> Result<Option<DiscoveredNode>> {
    let Some(properties) = peripheral.properties().await? else {
        return Ok(None);
    };

    let local_name = properties.local_name.or(properties.advertisement_name);
    let has_runtime_service = properties
        .services
        .iter()
        .any(|uuid| *uuid == config.service_uuid);
    let address = Some(properties.address.to_string());
    let peripheral_id = peripheral.id().to_string();
    let known_device_ids_guard = known_device_ids.read().await;
    let classification = classify_discovery_candidate(
        &peripheral_id,
        address.as_deref(),
        local_name.as_deref(),
        has_runtime_service,
        config,
        allowed_nodes,
        &known_device_ids_guard,
    );
    drop(known_device_ids_guard);

    let accepted = classification.runtime_service_matched
        || classification.name_prefix_matched
        || (allow_approved_identity_fallback && classification.approved_identity_matched);

    if !accepted {
        return Ok(None);
    }

    let known_device_id = classification.matched_known_device_id;
    let label = local_name
        .clone()
        .or_else(|| known_device_id.clone())
        .unwrap_or_else(|| peripheral_id.clone());

    Ok(Some(DiscoveredNode {
        id: format!("peripheral:{peripheral_id}"),
        label,
        peripheral_id: Some(peripheral_id),
        address,
        local_name,
        known_device_id,
        last_rssi: properties.rssi,
        last_seen_at: Some(iso_now()),
    }))
}

fn is_approved(node: &DiscoveredNode, rules: &[ApprovedNodeRule]) -> bool {
    approved_rule_id_for_node(node, rules).is_some()
}

fn normalize_adapter_state(state: CentralState) -> String {
    match state {
        CentralState::PoweredOn => "poweredOn",
        CentralState::PoweredOff => "poweredOff",
        CentralState::Unknown => "unknown",
    }
    .to_string()
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}.{}Z",
        chrono_like_seconds(now.as_secs()),
        format!("{:03}", now.subsec_millis())
    )
}

fn chrono_like_seconds(seconds: u64) -> String {
    // RFC3339-ish UTC without adding another dependency.
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        .trim_end_matches('Z')
        .trim_end_matches(".000")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        allow_approved_identity_fallback, approved_nodes_pending_connection,
        approved_rule_id_for_node, all_approved_nodes_connected, classify_discovery_candidate,
        control_command_frames, disconnected_nodes_removed_from_allowed, mark_node_connected,
        is_approved, node_key, prune_reconnect_states, scan_reason,
        should_clear_reconnect_peripherals, should_restart_approved_reconnect_scan,
        should_scan, next_reconnect_attempt, ApprovedReconnectState, Config,
        APP_SESSION_LEASE_TIMEOUT_MS, RECONNECT_ATTEMPT_LIMIT,
    };
    use crate::protocol::{ApprovedNodeRule, DiscoveredNode};
    use std::{collections::HashMap, time::{Duration, Instant}};
    use serde_json::Value;
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
        let frames = control_command_frames(r#"{"type":"app-session-bootstrap"}"#);

        assert_eq!(frames.first().map(Vec::as_slice), Some(&b"BEGIN:32"[..]));
        assert_eq!(
            frames.get(1).map(Vec::as_slice),
            Some(&br#"{"type":"app-session-bootstrap"}"#[..])
        );
        assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
    }

    #[test]
    fn frames_app_session_lease_commands_for_firmware_parser() {
        let payload = format!(
            r#"{{"type":"app-session-lease","sessionId":"session-1","expiresInMs":{}}}"#,
            APP_SESSION_LEASE_TIMEOUT_MS
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
        assert_eq!(decoded["expiresInMs"], APP_SESSION_LEASE_TIMEOUT_MS);
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

        assert!(approved_nodes_pending_connection(&rules, &connected, &reconnect_states));
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

        assert!(!approved_nodes_pending_connection(&rules, &connected, &reconnect_states));
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

        assert!(!approved_nodes_pending_connection(&rules, &connected, &reconnect_states));
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
    fn reconnect_scan_does_not_clear_peripherals_while_a_handshake_is_in_flight() {
        let connected = HashMap::new();

        assert!(!should_clear_reconnect_peripherals(&connected, 1));
        assert!(should_clear_reconnect_peripherals(&connected, 0));
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
            1,
        ));

        assert!(should_restart_approved_reconnect_scan(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            Instant::now(),
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
            scan_reason(&rules, &HashMap::new(), &HashMap::new(), None, Instant::now()),
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
        assert_eq!(classification.matched_known_device_id.as_deref(), Some("stack-001"));
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
        assert_eq!(classification.matched_known_device_id.as_deref(), Some("stack-001"));
    }

    #[test]
    fn manual_discovery_stays_strict_when_only_approved_identity_matches() {
        let config = Config {
            service_uuid: Uuid::nil(),
            telemetry_uuid: Uuid::nil(),
            control_uuid: Uuid::nil(),
            status_uuid: Uuid::nil(),
            device_name_prefix: "GymMotion-".to_string(),
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
