use super::approval::{
    all_approved_nodes_connected, allow_approved_identity_fallback,
    approved_nodes_pending_connection, approved_rule_id_for_node, classify_discovery_candidate,
    disconnected_nodes_removed_from_allowed, is_approved, mark_node_connected,
    next_reconnect_attempt, node_key, prune_reconnect_states, reconnect_candidate_ready,
    scan_reason, should_clear_reconnect_peripherals, should_restart_approved_reconnect_scan,
    should_scan, ApprovedReconnectState, APPROVED_RECONNECT_SCAN_BURST_MS,
    APPROVED_RECONNECT_STALL_MS, RECONNECT_ATTEMPT_LIMIT,
};
use super::config::Config;
use super::handshake::control_command_frames;
use super::registry::DeviceRecord;
use super::session_connection::explicit_connect_candidate_ready;
use super::session_scan::{
    disconnected_node_from_rule, pause_approved_reconnect_for_operator_decision,
    should_pause_approved_reconnect_scan, APPROVED_RECONNECT_STARTUP_BURST_MS,
};
use super::session_util::is_retryable_pre_session_setup_error;
use crate::protocol::{ApprovedNodeRule, DiscoveredNode};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

mod candidate_identity;
mod control_frames;
mod discovery;
mod scan_policy;
