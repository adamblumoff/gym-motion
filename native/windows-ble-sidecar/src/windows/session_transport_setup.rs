use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use btleplug::{
    api::{Characteristic, Peripheral as _},
    platform::Peripheral,
};
use serde_json::json;

use crate::protocol::{DiscoveredNode, Event, ReconnectStatus};

use super::{
    config::Config,
    session_transport_prepare_io::{
        prepare_runtime_session_io, NotificationStream, PrepareSessionIoConfig,
    },
    session_transport_recovery::emit_handshake_step,
    session_util::{format_error_chain, is_retryable_pre_session_setup_error},
    writer::EventWriter,
};

pub(super) struct PreparedSession {
    pub(super) peripheral: Peripheral,
    pub(super) notifications: NotificationStream,
    pub(super) live_control_characteristic: Characteristic,
    pub(super) history_control_characteristic: Characteristic,
    pub(super) transport_ready_at: Option<Instant>,
    pub(super) gatt_ready_at: Option<Instant>,
}

#[derive(Clone, Copy)]
pub(super) struct PrepareSessionConfig {
    pub(super) gatt_setup_retry_attempts: u32,
    pub(super) gatt_setup_retry_delay_ms: u64,
    pub(super) service_discovery_retry_attempts: u32,
    pub(super) post_gatt_ready_settle_ms: u64,
    pub(super) pre_session_setup_attempts: u32,
    pub(super) pre_session_setup_retry_delay_ms: u64,
    pub(super) cold_boot_ready_uptime_ms: u64,
    pub(super) cold_boot_ready_max_wait_ms: u64,
}

pub(super) async fn prepare_session_stream(
    peripheral: Peripheral,
    node: &DiscoveredNode,
    writer: &EventWriter,
    config: &Config,
    reconnect: &Option<ReconnectStatus>,
    app_session_id: &str,
    app_session_nonce: &str,
    prepare_config: PrepareSessionConfig,
) -> Result<PreparedSession> {
    let mut transport_ready_at: Option<Instant> = None;
    let mut gatt_ready_at: Option<Instant> = None;
    let mut gatt_ready = false;
    let mut last_gatt_error = None;

    for attempt in 1..=prepare_config.gatt_setup_retry_attempts {
        emit_handshake_step(
            writer,
            config.verbose_logging,
            node,
            reconnect,
            "checking transport connection",
        )
        .await?;
        let was_connected = peripheral.is_connected().await.unwrap_or(false);
        if !was_connected {
            emit_handshake_step(
                writer,
                config.verbose_logging,
                node,
                reconnect,
                "calling peripheral.connect()",
            )
            .await?;
            if let Err(error) = peripheral.connect().await {
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
                if peripheral.is_connected().await.unwrap_or(false) {
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
                    let _ = peripheral.disconnect().await;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                last_gatt_error = Some(connect_error);
                if attempt == prepare_config.gatt_setup_retry_attempts {
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
                            "error": last_gatt_error.as_ref().map(format_error_chain),
                        })),
                    })
                    .await?;
                tokio::time::sleep(Duration::from_millis(
                    prepare_config.gatt_setup_retry_delay_ms,
                ))
                .await;
                continue;
            }
            tokio::time::sleep(Duration::from_millis(
                prepare_config.gatt_setup_retry_delay_ms,
            ))
            .await;
        }

        if !peripheral.is_connected().await.unwrap_or(false) {
            let Some(error) = last_gatt_error.take() else {
                last_gatt_error = Some(anyhow!(
                    "transport still disconnected for {} after connect attempt",
                    node.label
                ));
                continue;
            };

            if attempt == prepare_config.gatt_setup_retry_attempts {
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
                        "error": format_error_chain(&error),
                    })),
                })
                .await?;
            tokio::time::sleep(Duration::from_millis(
                prepare_config.gatt_setup_retry_delay_ms,
            ))
            .await;
            continue;
        }
        transport_ready_at.get_or_insert_with(Instant::now);

        for discovery_attempt in 1..=prepare_config.service_discovery_retry_attempts {
            emit_handshake_step(
                writer,
                config.verbose_logging,
                node,
                reconnect,
                "discovering services",
            )
            .await?;
            match peripheral.discover_services().await {
                Ok(()) => {
                    gatt_ready = true;
                    gatt_ready_at.get_or_insert_with(Instant::now);
                    last_gatt_error = None;
                    break;
                }
                Err(error) => {
                    writer
                        .send(&Event::Log {
                            level: "warn".to_string(),
                            message: format!(
                                "discover_services attempt {discovery_attempt}/{} failed; waiting before retry.",
                                prepare_config.service_discovery_retry_attempts,
                            ),
                            details: Some(json!({
                                "peripheralId": node.peripheral_id,
                                "knownDeviceId": node.known_device_id,
                                "address": node.address,
                                "reconnect": reconnect,
                                "error": format!("{:#}", error),
                            })),
                        })
                        .await?;
                    last_gatt_error = Some(
                        anyhow!(error)
                            .context(format!("discover_services step failed for {}", node.label)),
                    );
                    if discovery_attempt < prepare_config.service_discovery_retry_attempts {
                        tokio::time::sleep(Duration::from_millis(
                            prepare_config.gatt_setup_retry_delay_ms,
                        ))
                        .await;
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
        if attempt == prepare_config.gatt_setup_retry_attempts {
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
                    "error": format_error_chain(&error),
                })),
            })
            .await?;

        if peripheral.is_connected().await.unwrap_or(false) {
            let _ = peripheral.disconnect().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_millis(
            prepare_config.gatt_setup_retry_delay_ms,
        ))
        .await;
    }

    if !gatt_ready {
        return Err(anyhow!("gatt setup never became ready for {}", node.label));
    }

    tokio::time::sleep(Duration::from_millis(
        prepare_config.post_gatt_ready_settle_ms,
    ))
    .await;
    let mut setup_result = Err(anyhow!("pre-session setup did not run"));
    for setup_attempt in 1..=prepare_config.pre_session_setup_attempts {
        setup_result = async {
            prepare_runtime_session_io(
                &peripheral,
                node,
                writer,
                config,
                reconnect,
                app_session_id,
                app_session_nonce,
                PrepareSessionIoConfig {
                    cold_boot_ready_uptime_ms: prepare_config.cold_boot_ready_uptime_ms,
                    cold_boot_ready_max_wait_ms: prepare_config.cold_boot_ready_max_wait_ms,
                },
            )
            .await
        }
        .await;

        let Err(error) = &setup_result else {
            break;
        };

        if setup_attempt == prepare_config.pre_session_setup_attempts
            || !is_retryable_pre_session_setup_error(error)
            || !peripheral.is_connected().await.unwrap_or(false)
        {
            break;
        }

        writer
            .send(&Event::Log {
                level: "warn".to_string(),
                message: "Runtime pre-session setup hit a transient WinRT handle failure; refreshing services and retrying on the same connection.".to_string(),
                details: Some(json!({
                    "peripheralId": node.peripheral_id,
                    "knownDeviceId": node.known_device_id,
                    "address": node.address,
                    "reconnect": reconnect,
                    "setupAttempt": setup_attempt,
                    "setupAttemptLimit": prepare_config.pre_session_setup_attempts,
                    "error": format_error_chain(error),
                })),
            })
            .await?;
        tokio::time::sleep(Duration::from_millis(
            prepare_config.pre_session_setup_retry_delay_ms,
        ))
        .await;
        peripheral
            .discover_services()
            .await
            .with_context(|| format!("refresh services before retry failed for {}", node.label))?;
    }

    match setup_result {
        Ok((notifications, live_control_characteristic, history_control_characteristic)) => Ok(PreparedSession {
            peripheral,
            notifications,
            live_control_characteristic,
            history_control_characteristic,
            transport_ready_at,
            gatt_ready_at,
        }),
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
                            "error": format_error_chain(&error),
                        })),
                    })
                    .await?;
                let _ = peripheral.disconnect().await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error)
        }
    }
}
