use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Central, CentralState, Manager as _},
    platform::{Adapter, Manager},
};
use serde_json::json;
use tokio::{
    io::{self, AsyncBufReadExt, BufReader},
    sync::RwLock,
};

use super::{
    config::Config,
    session::run_session,
    session_types::{added_allowed_rule_ids, SessionCommand, SessionHandle},
    session_util::format_error_chain,
    winrt_adapter::list_winrt_adapters,
    writer::EventWriter,
};
use crate::protocol::{AdapterSummary, ApprovedNodeRule, Command, Event, GatewayStatePayload};

const PROTOCOL_VERSION: u32 = 1;

struct Sidecar {
    manager: Manager,
    writer: EventWriter,
    config: Config,
    selected_adapter_id: Option<String>,
    allowed_nodes: std::sync::Arc<RwLock<Vec<ApprovedNodeRule>>>,
    session: Option<SessionHandle>,
}

impl Sidecar {
    async fn new() -> Result<Self> {
        Ok(Self {
            manager: Manager::new().await?,
            writer: EventWriter::new(),
            config: Config::from_env()?,
            selected_adapter_id: None,
            allowed_nodes: std::sync::Arc::new(RwLock::new(Vec::new())),
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
            Command::ListAdapters
            | Command::Rescan
            | Command::StartManualScan
            | Command::RefreshScanPolicy => {
                if matches!(command, Command::Rescan | Command::StartManualScan) {
                    if self.session.is_none() {
                        self.start_session().await?;
                    }

                    if let Some(session) = &self.session {
                        let _ = session.commands.send(SessionCommand::StartManualScan);
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
            Command::PairManualCandidate { candidate_id } => {
                if self.session.is_none() {
                    self.start_session().await?;
                }

                if let Some(session) = &self.session {
                    let _ = session
                        .commands
                        .send(SessionCommand::PairManualCandidate { candidate_id });
                }
            }
            Command::ResumeApprovedNodeReconnect { rule_id } => {
                if self.session.is_none() {
                    self.start_session().await?;
                }

                if let Some(session) = &self.session {
                    let _ = session
                        .commands
                        .send(SessionCommand::ResumeApprovedNodeReconnect { rule_id });
                }
            }
            Command::SelectAdapter { adapter_id } => {
                self.selected_adapter_id = Some(adapter_id);
                self.emit_adapters().await?;
            }
            Command::SetAllowedNodes { nodes } => {
                let previous_nodes = self.allowed_nodes.read().await.clone();
                let added_rule_ids = added_allowed_rule_ids(&previous_nodes, &nodes);
                *self.allowed_nodes.write().await = nodes;
                if let Some(session) = &self.session {
                    let _ = session.commands.send(SessionCommand::AllowedNodesUpdated {
                        nodes: self.allowed_nodes.read().await.clone(),
                        added_rule_ids,
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
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
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
                        Some(json!({ "error": format_error_chain(&error) })),
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
