use std::{
    collections::{HashMap, HashSet},
    env,
    future::pending,
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter},
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
const DEVICE_PREFIX_FALLBACK: &str = "GymMotion-";
const SCAN_WINDOW_SECS: u64 = 15;

#[derive(Clone)]
struct Config {
    service_uuid: Uuid,
    telemetry_uuid: Uuid,
    device_name_prefix: String,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            service_uuid: parse_uuid("BLE_RUNTIME_SERVICE_UUID", SERVICE_UUID_FALLBACK)?,
            telemetry_uuid: parse_uuid("BLE_TELEMETRY_UUID", TELEMETRY_UUID_FALLBACK)?,
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
        && rules
            .iter()
            .all(|rule| connected_nodes.values().any(|node| rule_matches_node(rule, node)))
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
    let mut scan_deadline = None;

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

                if matches!(command, SessionCommand::StartScan) && !scanning {
                    adapter.start_scan(ScanFilter::default()).await?;
                    scanning = true;
                    scan_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(SCAN_WINDOW_SECS));
                    writer
                        .send(&Event::GatewayState {
                            gateway: GatewayStatePayload {
                                adapter_state: normalize_adapter_state(
                                    adapter
                                        .adapter_state()
                                        .await
                                        .unwrap_or(CentralState::Unknown),
                                ),
                                scan_state: "scanning".to_string(),
                                selected_adapter_id: Some(selected_adapter_id.clone()),
                                last_advertisement_at: last_advertisement_at.clone(),
                                issue: None,
                            },
                        })
                        .await?;
                }
            }
            _ = async {
                if let Some(deadline) = scan_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    pending::<()>().await;
                }
            } => {
                if scanning {
                    let _ = adapter.stop_scan().await;
                    scanning = false;
                    scan_deadline = None;
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
                                selected_adapter_id: Some(selected_adapter_id.clone()),
                                last_advertisement_at: last_advertisement_at.clone(),
                                issue: None,
                            }
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

                        let peripheral = adapter.peripheral(&id).await?;
                        if let Some(node) = discovered_node_from_peripheral(&peripheral, &config, &known_device_ids).await? {
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

                            if is_approved(&node, &allowed_nodes.read().await) {
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
                                    tokio::spawn(async move {
                                        let result = connect_and_stream(peripheral, node.clone(), writer_clone.clone(), config_clone, allowed_nodes_clone, known_device_ids_clone).await;
                                        if let Err(error) = result {
                                            writer_clone.error(format!("BLE connect failed: {error}"), None).await;
                                            let _ = writer_clone.send(&Event::NodeConnectionState {
                                                node,
                                                gateway_connection_state: "disconnected".to_string(),
                                                reason: Some(error.to_string()),
                                            }).await;
                                        }
                                        active_connections_clone.lock().await.remove(&key);
                                    });
                                }
                            }
                        }
                    }
                    CentralEvent::DeviceConnected(id) => {
                        let peripheral = adapter.peripheral(&id).await?;
                        if let Some(node) = discovered_node_from_peripheral(&peripheral, &config, &known_device_ids).await? {
                            connected_nodes.insert(node_key(&node), node.clone());
                            if scanning {
                                let allowed = allowed_nodes.read().await;
                                if all_approved_nodes_connected(&allowed, &connected_nodes) {
                                    let _ = adapter.stop_scan().await;
                                    scanning = false;
                                    scan_deadline = None;
                                    writer.send(&Event::GatewayState {
                                        gateway: GatewayStatePayload {
                                            adapter_state: normalize_adapter_state(
                                                adapter
                                                    .adapter_state()
                                                    .await
                                                    .unwrap_or(CentralState::Unknown),
                                            ),
                                            scan_state: "stopped".to_string(),
                                            selected_adapter_id: Some(selected_adapter_id.clone()),
                                            last_advertisement_at: last_advertisement_at.clone(),
                                            issue: None,
                                        }
                                    }).await?;
                                }
                            }
                            writer.send(&Event::NodeConnectionState {
                                node,
                                gateway_connection_state: "connected".to_string(),
                                reason: None,
                            }).await?;
                        }
                    }
                    CentralEvent::DeviceDisconnected(id) => {
                        let peripheral = adapter.peripheral(&id).await?;
                        if let Some(node) = discovered_node_from_peripheral(&peripheral, &config, &known_device_ids).await? {
                            connected_nodes.remove(&node_key(&node));
                            let state = if is_approved(&node, &allowed_nodes.read().await) {
                                "reconnecting"
                            } else {
                                "disconnected"
                            };
                            writer.send(&Event::NodeConnectionState {
                                node,
                                gateway_connection_state: state.to_string(),
                                reason: Some("Device disconnected.".to_string()),
                            }).await?;
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

async fn connect_and_stream(
    peripheral: Peripheral,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
) -> Result<()> {
    if !is_approved(&node, &allowed_nodes.read().await) {
        return Ok(());
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

    let mut notifications = peripheral.notifications().await?;
    peripheral.subscribe(&characteristic).await?;
    writer
        .send(&Event::NodeConnectionState {
            node: node.clone(),
            gateway_connection_state: "connected".to_string(),
            reason: None,
        })
        .await?;
    let mut decoder = JsonObjectDecoder::new(format!("telemetry:{}", node.label));

    while let Some(notification) = notifications.next().await {
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

    sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn discovered_node_from_peripheral(
    peripheral: &Peripheral,
    config: &Config,
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

    let peripheral_id = peripheral.id().to_string();
    let known_device_id = known_device_ids.read().await.get(&peripheral_id).cloned();
    let address = Some(properties.address.to_string());
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
