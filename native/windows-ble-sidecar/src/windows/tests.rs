use super::approval::{
    all_approved_nodes_connected, classify_discovery_candidate, reconnect_candidate_ready,
    APPROVED_RECONNECT_SCAN_BURST_MS, APPROVED_RECONNECT_STALL_MS,
};
use super::handshake::control_command_frames;
use super::registry::DeviceRecord;
use super::{
    allow_approved_identity_fallback, approved_nodes_pending_connection, approved_rule_id_for_node,
    disconnected_node_from_rule, disconnected_nodes_removed_from_allowed,
    explicit_connect_candidate_ready, is_approved, is_retryable_pre_session_setup_error,
    mark_node_connected, next_reconnect_attempt, node_key,
    pause_approved_reconnect_for_operator_decision, prune_reconnect_states, scan_reason,
    should_clear_reconnect_peripherals, should_pause_approved_reconnect_scan,
    should_restart_approved_reconnect_scan, should_scan, ApprovedReconnectState, Config,
    APPROVED_RECONNECT_STARTUP_BURST_MS, RECONNECT_ATTEMPT_LIMIT,
};
use crate::protocol::{ApprovedNodeRule, DiscoveredNode};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

mod discovery;
mod scan_policy;
