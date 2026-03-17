use anyhow::{Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _},
    platform::Peripheral,
};
use serde_json::json;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{
    config::Config,
    handshake::{
        send_app_session_bootstrap_locked, send_app_session_lease_locked, ControlWriteLock,
    },
    session_transport_prepare_io::required_characteristic,
    session_util::emit_verbose_log,
    writer::EventWriter,
};

pub(super) struct RecoveredActiveSessionIo {
    pub(super) control_characteristic: Characteristic,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RecoveryGattSnapshot {
    pub(super) service_count: usize,
    pub(super) characteristic_count: usize,
    pub(super) runtime_service_present: bool,
    pub(super) telemetry_present: bool,
    pub(super) control_present: bool,
    pub(super) status_present: bool,
}

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

pub(super) fn recovery_gatt_snapshot<'a>(
    service_uuids: impl IntoIterator<Item = uuid::Uuid>,
    characteristics: impl IntoIterator<Item = &'a Characteristic>,
    config: &Config,
) -> RecoveryGattSnapshot {
    let service_uuids = service_uuids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let characteristic_uuids = characteristics
        .into_iter()
        .map(|candidate| candidate.uuid)
        .collect::<Vec<_>>();
    let characteristic_count = characteristic_uuids.len();
    let characteristic_uuids = characteristic_uuids
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();

    RecoveryGattSnapshot {
        service_count: service_uuids.len(),
        characteristic_count,
        runtime_service_present: service_uuids.contains(&config.service_uuid),
        telemetry_present: characteristic_uuids.contains(&config.telemetry_uuid),
        control_present: characteristic_uuids.contains(&config.control_uuid),
        status_present: characteristic_uuids.contains(&config.status_uuid),
    }
}

pub(super) async fn recover_active_session_io(
    control_write_lock: &ControlWriteLock,
    peripheral: &Peripheral,
    writer: &EventWriter,
    node: &DiscoveredNode,
    reconnect: &Option<ReconnectStatus>,
    config: &Config,
    app_session_id: &str,
    app_session_nonce: &str,
) -> Result<RecoveredActiveSessionIo> {
    writer
        .send(&Event::Log {
            level: "warn".to_string(),
            message: "WinRT closed a live runtime handle after connect; refreshing services and replaying the app-session handshake on the same connection.".to_string(),
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
    let gatt_snapshot = recovery_gatt_snapshot(
        peripheral
            .services()
            .into_iter()
            .map(|service| service.uuid),
        characteristics.iter(),
        config,
    );

    if !gatt_snapshot.runtime_service_present
        || !gatt_snapshot.telemetry_present
        || !gatt_snapshot.control_present
        || !gatt_snapshot.status_present
    {
        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: "Active-session recovery refreshed an incomplete WinRT GATT snapshot."
                    .to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                    "serviceCount": gatt_snapshot.service_count,
                    "characteristicCount": gatt_snapshot.characteristic_count,
                    "runtimeServicePresent": gatt_snapshot.runtime_service_present,
                    "telemetryPresent": gatt_snapshot.telemetry_present,
                    "controlPresent": gatt_snapshot.control_present,
                    "statusPresent": gatt_snapshot.status_present,
                })),
            })
            .await?;
    }

    let telemetry_characteristic = required_characteristic(
        peripheral,
        config.telemetry_uuid,
        "runtime telemetry characteristic not found during active session recovery",
    )?;
    let control_characteristic = required_characteristic(
        peripheral,
        config.control_uuid,
        "runtime control characteristic not found during active session recovery",
    )?;
    let status_characteristic = required_characteristic(
        peripheral,
        config.status_uuid,
        "runtime status characteristic not found during active session recovery",
    )?;

    peripheral
        .subscribe(&status_characteristic)
        .await
        .with_context(|| {
            format!(
                "status subscribe replay failed during active session recovery for {}",
                node.label
            )
        })?;
    peripheral
        .subscribe(&telemetry_characteristic)
        .await
        .with_context(|| {
            format!(
                "telemetry subscribe replay failed during active session recovery for {}",
                node.label
            )
        })?;

    send_app_session_bootstrap_locked(
        control_write_lock,
        peripheral,
        &control_characteristic,
        app_session_nonce,
    )
    .await
    .with_context(|| {
        format!(
            "app-session-bootstrap replay failed during active session recovery for {}",
            node.label
        )
    })?;
    send_app_session_lease_locked(
        control_write_lock,
        peripheral,
        &control_characteristic,
        app_session_id,
    )
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

    Ok(RecoveredActiveSessionIo {
        control_characteristic,
    })
}
