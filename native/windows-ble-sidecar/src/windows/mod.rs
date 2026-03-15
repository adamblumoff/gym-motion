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
        TelemetryPayload,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const SERVICE_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001";
const TELEMETRY_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002";
const CONTROL_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003";
const DEVICE_PREFIX_FALLBACK: &str = "GymMotion-";
const SCAN_WINDOW_SECS: u64 = 15;
const DISCONNECT_CONFIRM_MS: u64 = 500;
const CONNECTION_HEALTH_POLL_MS: u64 = 2_000;
const APP_SESSION_HEARTBEAT_MS: u64 = 5_000;
const APP_SESSION_LEASE_TIMEOUT_MS: u64 = 15_000;
const CONTROL_CHUNK_SIZE: usize = 120;

#[derive(Clone)]
struct Config {
    service_uuid: Uuid,
    telemetry_uuid: Uuid,
    control_uuid: Uuid,
    device_name_prefix: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            service_uuid: parse_uuid("BLE_RUNTIME_SERVICE_UUID", SERVICE_UUID_FALLBACK)?,
            telemetry_uuid: parse_uuid("BLE_TELEMETRY_UUID", TELEMETRY_UUID_FALLBACK)?,
            control_uuid: parse_uuid("BLE_CONTROL_UUID", CONTROL_UUID_FALLBACK)?,
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
    ConnectionEnded {
        node: DiscoveredNode,
        reason: String,
    },
}

fn approved_nodes_pending_connection(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
) -> bool {
    !rules.is_empty() && !all_approved_nodes_connected(rules, connected_nodes)
}

fn should_scan(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    approved_nodes_pending_connection(rules, connected_nodes)
        || manual_scan_deadline
            .map(|deadline| deadline > now)
            .unwrap_or(false)
}

async fn emit_gateway_state(
    writer: &EventWriter,
    adapter: &Adapter,
    selected_adapter_id: &str,
    scan_state: &str,
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
    scanning: &mut bool,
    manual_scan_deadline: Option<Instant>,
    last_advertisement_at: &Option<String>,
) -> Result<()> {
    let now = Instant::now();
    let should_scan_now = should_scan(allowed, connected_nodes, manual_scan_deadline, now);
    let approved_pending = approved_nodes_pending_connection(allowed, connected_nodes);

    if should_scan_now && !*scanning {
        adapter.start_scan(ScanFilter::default()).await?;
        *scanning = true;
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
            last_advertisement_at,
        )
        .await?;
        return Ok(());
    }

    if !should_scan_now && *scanning {
        let _ = adapter.stop_scan().await;
        *scanning = false;
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
            last_advertisement_at,
        )
        .await?;
    }

    Ok(())
}

fn node_key(node: &DiscoveredNode) -> String {
    node.peripheral_id
        .clone()
        .or_else(|| node.known_device_id.clone())
        .unwrap_or_else(|| node.id.clone())
}

fn rule_matches_node(rule: &ApprovedNodeRule, node: &DiscoveredNode) -> bool {
    rule.known_device_id
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
            .unwrap_or(false)
        || rule
            .local_name
            .as_ref()
            .zip(node.local_name.as_ref())
            .map(|(left, right)| left == right)
            .unwrap_or(false)
}

fn all_approved_nodes_connected(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
) -> bool {
    !rules.is_empty()
        && rules.iter().all(|rule| {
            connected_nodes
                .values()
                .any(|node| rule_matches_node(rule, node))
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
            Command::ListAdapters | Command::Rescan => {
                if matches!(command, Command::Rescan) {
                    if self.session.is_none() {
                        self.start_session().await?;
                    }

                    if let Some(session) = &self.session {
                        let _ = session.commands.send(SessionCommand::StartScan);
                    }
                }
                self.emit_adapters().await?;
            }
            Command::SelectAdapter { adapter_id } => {
                self.selected_adapter_id = Some(adapter_id);
                self.emit_adapters().await?;
            }
            Command::SetAllowedNodes { nodes } => {
                *self.allowed_nodes.write().await = nodes;
                if let Some(session) = &self.session {
                    let _ = session.commands.send(SessionCommand::RefreshScanPolicy);
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
    let mut last_advertisement_at = None;
    let mut scanning = false;
    let mut manual_scan_deadline = None;

    {
        let allowed = allowed_nodes.read().await.clone();
        sync_scan_state(
            &adapter,
            &writer,
            &selected_adapter_id,
            &allowed,
            &connected_nodes,
            &mut scanning,
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
                    SessionCommand::RefreshScanPolicy => {}
                    SessionCommand::ConnectionEnded { node, reason } => {
                        let key = node_key(&node);
                        connected_nodes.remove(&key);
                        manual_scan_deadline =
                            Some(Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
                        writer.send(&Event::Log {
                            level: "info".to_string(),
                            message: format!(
                                "Approved-node disconnect for {}; forcing reconnect scan window.",
                                node.label
                            ),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "reason": reason,
                            })),
                        }).await?;
                        writer.send(&Event::NodeConnectionState {
                            node,
                            gateway_connection_state: "disconnected".to_string(),
                            reason: Some(reason),
                        }).await?;
                    }
                }

                let allowed = allowed_nodes.read().await.clone();
                sync_scan_state(
                    &adapter,
                    &writer,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &mut scanning,
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
                let allowed = allowed_nodes.read().await.clone();
                sync_scan_state(
                    &adapter,
                    &writer,
                    &selected_adapter_id,
                    &allowed,
                    &connected_nodes,
                    &mut scanning,
                    manual_scan_deadline,
                    &last_advertisement_at,
                )
                .await?;
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
                        if let Some(node) = discovered_node_for_event(
                            &peripheral,
                            &writer,
                            "device_discovered",
                            &config,
                            &allowed,
                            &known_device_ids,
                        )
                        .await
                        {
                            last_advertisement_at = node.last_seen_at.clone();
                            writer.send(&Event::NodeDiscovered { node: node.clone() }).await?;
                            writer.send(&Event::GatewayState {
                                gateway: GatewayStatePayload {
                                    adapter_state: normalize_adapter_state(adapter.adapter_state().await.unwrap_or(CentralState::Unknown)),
                                    scan_state: "scanning".to_string(),
                                    selected_adapter_id: Some(selected_adapter_id.clone()),
                                    last_advertisement_at: last_advertisement_at.clone(),
                                    issue: None,
                                }
                            }).await?;

                            if is_approved(&node, &allowed) {
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
                                    })),
                                }).await?;
                                let key = node.peripheral_id.clone().unwrap_or_else(|| node.id.clone());
                                let mut active = active_connections.lock().await;
                                if !active.contains(&key) {
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
                                                    reason,
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
                                                    reason: error.to_string(),
                                                });
                                            }
                                        }
                                        active_connections_clone.lock().await.remove(&key);
                                    });
                                }
                            }
                        }
                    }
                    CentralEvent::DeviceConnected(id) => {
                        let Some(peripheral) =
                            peripheral_for_event(&adapter, &writer, "device_connected", &id).await
                        else {
                            continue;
                        };
                        let allowed = allowed_nodes.read().await.clone();
                        if let Some(node) = discovered_node_for_event(
                            &peripheral,
                            &writer,
                            "device_connected",
                            &config,
                            &allowed,
                            &known_device_ids,
                        )
                        .await
                        {
                            connected_nodes.insert(node_key(&node), node.clone());
                            sync_scan_state(
                                &adapter,
                                &writer,
                                &selected_adapter_id,
                                &allowed,
                                &connected_nodes,
                                &mut scanning,
                                manual_scan_deadline,
                                &last_advertisement_at,
                            )
                            .await?;
                            writer.send(&Event::NodeConnectionState {
                                node,
                                gateway_connection_state: "connected".to_string(),
                                reason: None,
                            }).await?;
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
                        )
                        .await
                        {
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
                            }).await?;
                            sync_scan_state(
                                &adapter,
                                &writer,
                                &selected_adapter_id,
                                &allowed,
                                &connected_nodes,
                                &mut scanning,
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

async fn discovered_node_for_event(
    peripheral: &Peripheral,
    writer: &EventWriter,
    event_name: &str,
    config: &Config,
    allowed: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
) -> Option<DiscoveredNode> {
    match discovered_node_from_peripheral(peripheral, config, allowed, known_device_ids).await {
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
) -> Result<Option<String>> {
    if !is_approved(&node, &allowed_nodes.read().await) {
        return Ok(None);
    }

    writer
        .send(&Event::NodeConnectionState {
            node: node.clone(),
            gateway_connection_state: "connecting".to_string(),
            reason: None,
        })
        .await?;

    if !peripheral.is_connected().await.unwrap_or(false) {
        peripheral.connect().await?;
    }
    peripheral.discover_services().await?;

    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|candidate| candidate.uuid == config.telemetry_uuid)
        .ok_or_else(|| anyhow!("telemetry characteristic not found"))?;
    let control_characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|candidate| candidate.uuid == config.control_uuid)
        .ok_or_else(|| anyhow!("runtime control characteristic not found"))?;

    let mut notifications = peripheral.notifications().await?;
    peripheral.subscribe(&characteristic).await?;
    write_chunked_json_command(
        &peripheral,
        &control_characteristic,
        r#"{"type":"sync-now"}"#,
    )
    .await?;
    send_app_session_lease(&peripheral, &control_characteristic, &app_session_id).await?;
    writer
        .send(&Event::NodeConnectionState {
            node: node.clone(),
            gateway_connection_state: "connected".to_string(),
            reason: None,
        })
        .await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));
    let mut connected_identity_confirmed = node.known_device_id.is_some();
    let mut lease_heartbeat =
        tokio::time::interval(Duration::from_millis(APP_SESSION_HEARTBEAT_MS));
    lease_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    lease_heartbeat.tick().await;

    loop {
        tokio::select! {
            notification = notifications.next() => {
                let Some(notification) = notification else {
                    break;
                };

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
                            if !connected_identity_confirmed {
                                connected_identity_confirmed = true;
                                writer
                                    .send(&Event::NodeConnectionState {
                                        node: enriched.clone(),
                                        gateway_connection_state: "connected".to_string(),
                                        reason: None,
                                    })
                                    .await?;
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
            _ = sleep(Duration::from_millis(CONNECTION_HEALTH_POLL_MS)) => {
                if !peripheral.is_connected().await.unwrap_or(false) {
                    return Ok(Some(format!("BLE transport ended for {}.", node.label)));
                }
            }
            _ = lease_heartbeat.tick() => {
                send_app_session_lease(&peripheral, &control_characteristic, &app_session_id)
                    .await?;
            }
        }
    }

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
) -> Result<Option<DiscoveredNode>> {
    let Some(properties) = peripheral.properties().await? else {
        return Ok(None);
    };

    let local_name = properties.local_name.or(properties.advertisement_name);
    let has_runtime_service = properties
        .services
        .iter()
        .any(|uuid| *uuid == config.service_uuid);
    let prefix_matches = local_name
        .as_ref()
        .map(|name| {
            !config.device_name_prefix.is_empty() && name.starts_with(&config.device_name_prefix)
        })
        .unwrap_or(false);

    if !has_runtime_service && !prefix_matches {
        return Ok(None);
    }

    let address = Some(properties.address.to_string());
    let peripheral_id = peripheral.id().to_string();
    let known_device_id = known_device_ids
        .read()
        .await
        .get(&peripheral_id)
        .cloned()
        .or_else(|| {
            allowed_nodes.iter().find_map(|rule| {
                if rule
                    .peripheral_id
                    .as_ref()
                    .map(|value| value == &peripheral_id)
                    .unwrap_or(false)
                {
                    return rule.known_device_id.clone();
                }

                if rule
                    .address
                    .as_ref()
                    .zip(address.as_ref())
                    .map(|(left, right)| left.eq_ignore_ascii_case(right))
                    .unwrap_or(false)
                {
                    return rule.known_device_id.clone();
                }

                if rule
                    .local_name
                    .as_ref()
                    .zip(local_name.as_ref())
                    .map(|(left, right)| left == right)
                    .unwrap_or(false)
                {
                    return rule.known_device_id.clone();
                }

                None
            })
        });
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
    rules.iter().any(|rule| {
        rule.known_device_id
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
                .unwrap_or(false)
            || rule
                .local_name
                .as_ref()
                .zip(node.local_name.as_ref())
                .map(|(left, right)| left == right)
                .unwrap_or(false)
    })
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
    use super::{control_command_frames, APP_SESSION_LEASE_TIMEOUT_MS};
    use serde_json::Value;

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

        assert!(approved_nodes_pending_connection(&rules, &connected));
        assert!(should_scan(&rules, &connected, None, Instant::now()));
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

        assert!(!approved_nodes_pending_connection(&rules, &connected));
        assert!(!should_scan(&rules, &connected, None, Instant::now()));
    }
}
