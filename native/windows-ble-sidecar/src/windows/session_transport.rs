use std::{collections::HashMap, sync::Arc, time::Duration, time::Instant};

use anyhow::Result;
use btleplug::{api::Peripheral as _, platform::Peripheral};
use tokio::sync::{mpsc, watch, RwLock};
use uuid::Uuid;

use crate::protocol::{ApprovedNodeRule, DiscoveredNode, Event, ReconnectStatus};

use super::{
    approval::is_approved,
    config::Config,
    session_transport_monitor::{monitor_active_session, MonitorSessionConfig},
    session_transport_setup::{prepare_session_stream, PrepareSessionConfig},
    session_types::SessionCommand,
    writer::EventWriter,
};

pub(super) const APP_SESSION_HEARTBEAT_MS: u64 = 2_500;
const CONNECTION_HEALTH_POLL_MS: u64 = 2_000;
const SESSION_HEALTH_ACK_TIMEOUT_MS: u64 = 3_000;
const GATT_SETUP_RETRY_ATTEMPTS: u32 = 2;
const GATT_SETUP_RETRY_DELAY_MS: u64 = 300;
const SERVICE_DISCOVERY_RETRY_ATTEMPTS: u32 = 2;
const PRE_SESSION_SETUP_RETRY_DELAY_MS: u64 = 750;
const PRE_SESSION_SETUP_ATTEMPTS: u32 = 3;
const SESSION_BEGIN_RETRY_LIMIT: u32 = 1;
const POST_GATT_READY_SETTLE_MS: u64 = 250;
const POST_SUBSCRIBE_READY_SETTLE_MS: u64 = 150;
const COLD_BOOT_READY_UPTIME_MS: u64 = 8_000;
const COLD_BOOT_READY_MAX_WAIT_MS: u64 = 5_000;

fn short_session_token() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    raw[..16].to_string()
}

pub(super) async fn connect_and_stream(
    peripheral: Peripheral,
    node: DiscoveredNode,
    writer: EventWriter,
    config: Config,
    allowed_nodes: Arc<RwLock<Vec<ApprovedNodeRule>>>,
    active_session_controls: Arc<
        tokio::sync::Mutex<HashMap<String, super::session::ActiveSessionChannels>>,
    >,
    known_device_ids: Arc<RwLock<HashMap<String, String>>>,
    reconnect: Option<ReconnectStatus>,
    session_shutdown: watch::Receiver<bool>,
    command_sender: mpsc::UnboundedSender<SessionCommand>,
) -> Result<Option<String>> {
    let cleanup_peripheral = peripheral.clone();
    let app_session_id = short_session_token();
    let app_session_nonce = short_session_token();
    let reconnect_started_at = Instant::now();

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

    let prepared = prepare_session_stream(
        peripheral,
        &node,
        &writer,
        &config,
        &reconnect,
        PrepareSessionConfig {
            gatt_setup_retry_attempts: GATT_SETUP_RETRY_ATTEMPTS,
            gatt_setup_retry_delay_ms: GATT_SETUP_RETRY_DELAY_MS,
            service_discovery_retry_attempts: SERVICE_DISCOVERY_RETRY_ATTEMPTS,
            post_gatt_ready_settle_ms: POST_GATT_READY_SETTLE_MS,
            pre_session_setup_attempts: PRE_SESSION_SETUP_ATTEMPTS,
            pre_session_setup_retry_delay_ms: PRE_SESSION_SETUP_RETRY_DELAY_MS,
            cold_boot_ready_uptime_ms: COLD_BOOT_READY_UPTIME_MS,
            cold_boot_ready_max_wait_ms: COLD_BOOT_READY_MAX_WAIT_MS,
        },
    )
    .await?;

    let result = monitor_active_session(
        prepared,
        node,
        writer,
        config,
        allowed_nodes,
        active_session_controls,
        known_device_ids,
        reconnect,
        session_shutdown,
        command_sender,
        app_session_id,
        app_session_nonce,
        reconnect_started_at,
        MonitorSessionConfig {
            connection_health_poll_ms: CONNECTION_HEALTH_POLL_MS,
            session_health_ack_timeout_ms: SESSION_HEALTH_ACK_TIMEOUT_MS,
            session_begin_retry_limit: SESSION_BEGIN_RETRY_LIMIT,
            post_subscribe_ready_settle_ms: POST_SUBSCRIBE_READY_SETTLE_MS,
        },
    )
    .await;

    if !matches!(result, Ok(None)) && cleanup_peripheral.is_connected().await.unwrap_or(false) {
        let _ = cleanup_peripheral.disconnect().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    result
}
