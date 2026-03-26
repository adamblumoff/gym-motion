use std::{pin::Pin, time::Duration};

use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _, ValueNotification},
    platform::Peripheral,
};
use futures::Stream;
use serde_json::json;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus, RuntimeStatusPayload};

use super::{
    config::Config,
    handshake::{send_app_session_bootstrap, send_app_session_lease},
    session_transport_recovery::emit_handshake_step,
    writer::EventWriter,
};

pub(super) type NotificationStream = Pin<Box<dyn Stream<Item = ValueNotification> + Send>>;

#[derive(Clone, Copy)]
pub(super) struct PrepareSessionIoConfig {
    pub(super) cold_boot_ready_uptime_ms: u64,
    pub(super) cold_boot_ready_max_wait_ms: u64,
}

async fn wait_for_cold_boot_ready_window(
    peripheral: &Peripheral,
    status_characteristic: &Characteristic,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    io_config: PrepareSessionIoConfig,
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
    if boot_uptime_ms >= io_config.cold_boot_ready_uptime_ms {
        return Ok(());
    }

    let wait_ms = (io_config.cold_boot_ready_uptime_ms - boot_uptime_ms)
        .min(io_config.cold_boot_ready_max_wait_ms);
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
    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    Ok(())
}

fn required_characteristic(
    peripheral: &Peripheral,
    uuid: uuid::Uuid,
    missing_message: &str,
) -> Result<Characteristic> {
    peripheral
        .characteristics()
        .into_iter()
        .find(|candidate| candidate.uuid == uuid)
        .ok_or_else(|| anyhow!(missing_message.to_string()))
}

fn required_service(
    peripheral: &Peripheral,
    uuid: uuid::Uuid,
    missing_message: &str,
) -> Result<()> {
    let found = peripheral
        .services()
        .iter()
        .any(|service| service.uuid == uuid);
    found
        .then_some(())
        .ok_or_else(|| anyhow!(missing_message.to_string()))
}

pub(super) async fn prepare_runtime_session_io(
    peripheral: &Peripheral,
    node: &DiscoveredNode,
    writer: &EventWriter,
    config: &Config,
    reconnect: &Option<ReconnectStatus>,
    app_session_id: &str,
    app_session_nonce: &str,
    io_config: PrepareSessionIoConfig,
) -> Result<(NotificationStream, Characteristic, Characteristic)> {
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "verifying runtime service",
    )
    .await?;
    required_service(
        peripheral,
        config.service_uuid,
        "runtime service not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "verifying history service",
    )
    .await?;
    required_service(
        peripheral,
        config.history_service_uuid,
        "history service not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "resolving telemetry characteristic",
    )
    .await?;
    let telemetry_characteristic = required_characteristic(
        peripheral,
        config.telemetry_uuid,
        "telemetry characteristic not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "resolving control characteristic",
    )
    .await?;
    let control_characteristic = required_characteristic(
        peripheral,
        config.control_uuid,
        "runtime control characteristic not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "resolving history control characteristic",
    )
    .await?;
    let history_control_characteristic = required_characteristic(
        peripheral,
        config.history_control_uuid,
        "history control characteristic not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "resolving runtime status characteristic",
    )
    .await?;
    let status_characteristic = required_characteristic(
        peripheral,
        config.status_uuid,
        "runtime status characteristic not found",
    )?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "resolving history status characteristic",
    )
    .await?;
    let history_status_characteristic = required_characteristic(
        peripheral,
        config.history_status_uuid,
        "history status characteristic not found",
    )?;
    wait_for_cold_boot_ready_window(
        peripheral,
        &status_characteristic,
        writer,
        node,
        reconnect,
        io_config,
    )
    .await?;

    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "opening notifications stream",
    )
    .await?;
    let notifications = peripheral
        .notifications()
        .await
        .with_context(|| format!("notifications step failed for {}", node.label))?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "subscribing to runtime status",
    )
    .await?;
    peripheral
        .subscribe(&status_characteristic)
        .await
        .with_context(|| format!("status subscribe step failed for {}", node.label))?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "subscribing to history status",
    )
    .await?;
    peripheral
        .subscribe(&history_status_characteristic)
        .await
        .with_context(|| format!("history status subscribe step failed for {}", node.label))?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "subscribing to telemetry",
    )
    .await?;
    peripheral
        .subscribe(&telemetry_characteristic)
        .await
        .with_context(|| format!("subscribe step failed for {}", node.label))?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "sending app-session bootstrap",
    )
    .await?;
    send_app_session_bootstrap(peripheral, &control_characteristic, app_session_nonce)
        .await
        .with_context(|| format!("app-session-bootstrap step failed for {}", node.label))?;
    emit_handshake_step(
        writer,
        config.verbose_logging,
        node,
        reconnect,
        "sending app-session lease",
    )
    .await?;
    send_app_session_lease(peripheral, &control_characteristic, app_session_id)
        .await
        .with_context(|| format!("app-session-lease step failed for {}", node.label))?;

    Ok((notifications, control_characteristic, history_control_characteristic))
}
