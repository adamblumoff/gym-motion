use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _},
    platform::Peripheral,
};
use serde_json::json;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{
    handshake::send_app_session_begin, session_util::emit_verbose_log, writer::EventWriter,
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
    telemetry_uuid: uuid::Uuid,
    control_uuid: uuid::Uuid,
    status_uuid: uuid::Uuid,
    history_control_uuid: uuid::Uuid,
    history_status_uuid: uuid::Uuid,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<(Characteristic, Characteristic, Characteristic, Characteristic)> {
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

    let characteristics = peripheral.characteristics();

    let control_characteristic = characteristics
        .iter()
        .find(|candidate| candidate.uuid == control_uuid)
        .cloned()
        .ok_or_else(|| {
            anyhow!("runtime control characteristic not found during active session recovery")
        })?;

    let telemetry_characteristic = characteristics
        .iter()
        .find(|candidate| candidate.uuid == telemetry_uuid)
        .cloned()
        .ok_or_else(|| {
            anyhow!("telemetry characteristic not found during active session recovery")
        })?;

    let status_characteristic = characteristics
        .iter()
        .find(|candidate| candidate.uuid == status_uuid)
        .cloned()
        .ok_or_else(|| {
            anyhow!("runtime status characteristic not found during active session recovery")
        })?;

    let history_control_characteristic = characteristics
        .iter()
        .find(|candidate| candidate.uuid == history_control_uuid)
        .cloned()
        .ok_or_else(|| {
            anyhow!("history control characteristic not found during active session recovery")
        })?;

    let history_status_characteristic = characteristics
        .iter()
        .find(|candidate| candidate.uuid == history_status_uuid)
        .cloned()
        .ok_or_else(|| {
            anyhow!("history status characteristic not found during active session recovery")
        })?;

    peripheral
        .subscribe(&status_characteristic)
        .await
        .with_context(|| {
            format!(
                "runtime status resubscribe failed during active session recovery for {}",
                node.label
            )
        })?;
    peripheral
        .subscribe(&history_status_characteristic)
        .await
        .with_context(|| {
            format!(
                "history status resubscribe failed during active session recovery for {}",
                node.label
            )
        })?;
    peripheral
        .subscribe(&telemetry_characteristic)
        .await
        .with_context(|| {
            format!(
                "telemetry resubscribe failed during active session recovery for {}",
                node.label
            )
        })?;

    send_app_session_begin(
        peripheral,
        &control_characteristic,
        app_session_nonce,
        app_session_id,
    )
    .await
    .with_context(|| {
        format!(
            "app-session begin replay failed during active session recovery for {}",
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

    Ok((
        control_characteristic,
        status_characteristic,
        history_control_characteristic,
        history_status_characteristic,
    ))
}
