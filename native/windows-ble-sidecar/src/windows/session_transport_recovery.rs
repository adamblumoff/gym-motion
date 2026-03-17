use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _},
    platform::Peripheral,
};
use serde_json::json;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{
    handshake::{send_app_session_bootstrap, send_app_session_lease},
    session_util::emit_verbose_log,
    writer::EventWriter,
};

pub(super) async fn emit_handshake_step(
    writer: &EventWriter,
    verbose_logging: bool,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    step: &str,
) -> Result<()> {
    emit_verbose_log(
        writer,
        verbose_logging,
        format!("Reconnect handshake step: {step}"),
        Some(json!({
            "peripheralId": node.peripheral_id,
            "knownDeviceId": node.known_device_id,
            "address": node.address,
            "reconnect": reconnect,
        })),
    )
    .await
}

pub(super) async fn recover_active_session_control_path(
    peripheral: &Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    control_uuid: uuid::Uuid,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<Characteristic> {
    writer
        .send(&Event::Log {
            level: "warn".to_string(),
            message: "WinRT closed the runtime control handle after connect; refreshing services and replaying the app-session handshake on the same connection.".to_string(),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
            })),
        })
        .await?;

    peripheral.discover_services().await.with_context(|| {
        format!(
            "refresh services for active session recovery failed for {}",
            node.label
        )
    })?;

    let control_characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|candidate| candidate.uuid == control_uuid)
        .ok_or_else(|| {
            anyhow!("runtime control characteristic not found during active session recovery")
        })?;

    send_app_session_bootstrap(peripheral, &control_characteristic, app_session_nonce)
        .await
        .with_context(|| {
            format!(
                "app-session-bootstrap replay failed during active session recovery for {}",
                node.label
            )
        })?;
    send_app_session_lease(peripheral, &control_characteristic, app_session_id)
        .await
        .with_context(|| {
            format!(
                "app-session-lease replay failed during active session recovery for {}",
                node.label
            )
        })?;

    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: format!(
                "Recovered runtime control path for {} without restarting reconnect scan.",
                node.label
            ),
            details: Some(json!({
                "peripheralId": node.peripheral_id,
                "knownDeviceId": node.known_device_id,
                "address": node.address,
                "reconnect": reconnect,
            })),
        })
        .await?;

    Ok(control_characteristic)
}
