use std::time::Instant;

use anyhow::Result;
use serde_json::json;
use tokio::sync::mpsc;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{session_types::SessionCommand, writer::EventWriter};

pub(super) async fn report_reconnect_completed(
    writer: &EventWriter,
    command_sender: &mpsc::UnboundedSender<SessionCommand>,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    transport_ready_at: Option<Instant>,
    gatt_ready_at: Option<Instant>,
    reconnect_started_at: Instant,
    used_telemetry_fallback: bool,
) -> Result<()> {
    let _ = command_sender.send(SessionCommand::ConnectionHealthy { node: node.clone() });
    writer
        .send(&Event::NodeConnectionState {
            node: node.clone(),
            gateway_connection_state: "connected".to_string(),
            reason: None,
            reconnect: reconnect.clone(),
        })
        .await?;
    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: format!("Reconnect completed for {}.", node.label),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
                "transportMs": transport_ready_at
                    .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                "gattMs": gatt_ready_at
                    .map(|instant| instant.duration_since(reconnect_started_at).as_millis() as u64),
                "sessionMs": Instant::now()
                    .duration_since(reconnect_started_at)
                    .as_millis() as u64,
                "usedTelemetryFallback": used_telemetry_fallback,
            })),
        })
        .await?;
    Ok(())
}
