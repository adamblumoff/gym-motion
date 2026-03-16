use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use crate::protocol::{ApprovedNodeRule, DiscoveredNode, ReconnectStatus};

use super::{config::Config, registry::DeviceRecord};

pub(crate) const RECONNECT_ATTEMPT_LIMIT: u32 = 20;
pub(crate) const APPROVED_RECONNECT_SCAN_BURST_MS: u64 = 2_000;
pub(crate) const APPROVED_RECONNECT_STALL_MS: u64 = 3_000;

#[derive(Clone, Debug, Default)]
pub(crate) struct ApprovedReconnectState {
    pub(crate) attempt: u32,
    pub(crate) retry_exhausted: bool,
    pub(crate) awaiting_user_decision: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DiscoveryClassification {
    pub(crate) runtime_service_matched: bool,
    pub(crate) name_prefix_matched: bool,
    pub(crate) approved_identity_matched: bool,
    pub(crate) matched_known_device_id: Option<String>,
}

pub(crate) fn approved_rule_id_for_node(
    node: &DiscoveredNode,
    rules: &[ApprovedNodeRule],
) -> Option<String> {
    rules
        .iter()
        .find(|rule| rule_matches_node(rule, node, rules))
        .map(|rule| rule.id.clone())
}

pub(crate) fn disconnected_nodes_removed_from_allowed(
    connected_nodes: &HashMap<String, DiscoveredNode>,
    allowed: &[ApprovedNodeRule],
) -> Vec<DiscoveredNode> {
    connected_nodes
        .values()
        .filter(|node| !is_approved(node, allowed))
        .cloned()
        .collect()
}

pub(crate) fn reconnect_status_for_rule(
    rule_id: Option<&str>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> Option<ReconnectStatus> {
    rule_id.map(|id| {
        let state = reconnect_states.get(id).cloned().unwrap_or_default();
        ReconnectStatus {
            attempt: state.attempt,
            attempt_limit: RECONNECT_ATTEMPT_LIMIT,
            retry_exhausted: state.retry_exhausted,
            awaiting_user_decision: state.awaiting_user_decision,
        }
    })
}

pub(crate) fn mark_node_connected(
    connected_nodes: &mut HashMap<String, DiscoveredNode>,
    reconnect_states: &mut HashMap<String, ApprovedReconnectState>,
    node: &DiscoveredNode,
    allowed: &[ApprovedNodeRule],
) {
    connected_nodes.insert(node_key(node), node.clone());

    if let Some(rule_id) = approved_rule_id_for_node(node, allowed) {
        reconnect_states.insert(rule_id, ApprovedReconnectState::default());
    }
}

pub(crate) fn prune_reconnect_states(
    reconnect_states: &mut HashMap<String, ApprovedReconnectState>,
    allowed: &[ApprovedNodeRule],
) {
    let allowed_rule_ids = allowed
        .iter()
        .map(|rule| rule.id.as_str())
        .collect::<HashSet<_>>();
    reconnect_states.retain(|rule_id, _| allowed_rule_ids.contains(rule_id.as_str()));
}

pub(crate) fn should_clear_reconnect_peripherals(
    connected_nodes: &HashMap<String, DiscoveredNode>,
    active_connection_count: usize,
) -> bool {
    // WinRT reconnect scans can keep emitting discovery events whose peripheral ids
    // become unreadable if we aggressively clear the adapter cache between bursts.
    // Keep the cache intact during silent reconnect loops and let explicit shutdown
    // or adapter resets own cache invalidation instead.
    let _ = connected_nodes;
    let _ = active_connection_count;
    false
}

pub(crate) fn classify_discovery_candidate(
    peripheral_id: &str,
    address: Option<&str>,
    local_name: Option<&str>,
    has_runtime_service: bool,
    config: &Config,
    allowed_nodes: &[ApprovedNodeRule],
    known_device_ids: &HashMap<String, String>,
) -> DiscoveryClassification {
    let name_prefix_matched = local_name
        .map(|name| {
            !config.device_name_prefix.is_empty() && name.starts_with(&config.device_name_prefix)
        })
        .unwrap_or(false);
    let unique_local_name_rule = local_name.and_then(|candidate_name| {
        let mut matches = allowed_nodes.iter().filter(|rule| {
            rule.known_device_id.is_none()
                && rule.peripheral_id.is_none()
                && rule.address.is_none()
                && rule
                    .local_name
                    .as_ref()
                    .map(|value| value == candidate_name)
                    .unwrap_or(false)
        });
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(first)
    });
    let matched_known_device_id = known_device_ids.get(peripheral_id).cloned().or_else(|| {
        allowed_nodes.iter().find_map(|rule| {
            if rule
                .peripheral_id
                .as_ref()
                .map(|value| value == peripheral_id)
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            if rule
                .address
                .as_ref()
                .zip(address)
                .map(|(left, right)| left.eq_ignore_ascii_case(right))
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            if unique_local_name_rule
                .map(|unique_rule| unique_rule.id == rule.id)
                .unwrap_or(false)
            {
                return rule.known_device_id.clone();
            }

            None
        })
    });

    DiscoveryClassification {
        runtime_service_matched: has_runtime_service,
        name_prefix_matched,
        approved_identity_matched: matched_known_device_id.is_some()
            || allowed_nodes.iter().any(|rule| {
                rule.peripheral_id
                    .as_ref()
                    .map(|value| value == peripheral_id)
                    .unwrap_or(false)
                    || rule
                        .address
                        .as_ref()
                        .zip(address)
                        .map(|(left, right)| left.eq_ignore_ascii_case(right))
                        .unwrap_or(false)
                    || unique_local_name_rule
                        .map(|unique_rule| unique_rule.id == rule.id)
                        .unwrap_or(false)
            }),
        matched_known_device_id,
    }
}

pub(crate) fn reconnect_candidate_ready(
    classification: &DiscoveryClassification,
    local_name_present: bool,
    record: Option<&DeviceRecord>,
) -> bool {
    if classification.runtime_service_matched {
        return true;
    }

    if !classification.approved_identity_matched {
        return false;
    }
    let _ = local_name_present;
    let _ = record;
    false
}

pub(crate) fn approved_nodes_pending_connection(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> bool {
    !rules.is_empty() && !all_approved_nodes_connected(rules, connected_nodes, reconnect_states)
}

pub(crate) fn should_scan(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    approved_nodes_pending_connection(rules, connected_nodes, reconnect_states)
        || manual_scan_deadline
            .map(|deadline| deadline > now)
            .unwrap_or(false)
}

pub(crate) fn scan_reason(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> Option<&'static str> {
    if manual_scan_deadline
        .map(|deadline| deadline > now)
        .unwrap_or(false)
    {
        return Some("manual");
    }

    if approved_nodes_pending_connection(rules, connected_nodes, reconnect_states) {
        return Some("approved-reconnect");
    }

    None
}

pub(crate) fn allow_approved_identity_fallback(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    if approved_nodes_pending_connection(rules, connected_nodes, reconnect_states) {
        return true;
    }

    let manual_scan_active = manual_scan_deadline
        .map(|deadline| deadline > now)
        .unwrap_or(false);
    if !manual_scan_active {
        return false;
    }

    rules.iter().any(|rule| {
        reconnect_states
            .get(&rule.id)
            .map(|state| state.retry_exhausted)
            .unwrap_or(false)
    })
}

pub(crate) fn should_restart_approved_reconnect_scan(
    allowed: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
    manual_scan_deadline: Option<Instant>,
    now: Instant,
    last_scan_progress_at: Option<Instant>,
    startup_burst_deadline: Option<Instant>,
    active_connection_count: usize,
) -> bool {
    if active_connection_count > 0 {
        return false;
    }

    if scan_reason(
        allowed,
        connected_nodes,
        reconnect_states,
        manual_scan_deadline,
        now,
    ) != Some("approved-reconnect")
    {
        return false;
    }

    let Some(last_progress) = last_scan_progress_at else {
        return false;
    };

    let restart_after = if startup_burst_deadline
        .map(|deadline| deadline > now)
        .unwrap_or(false)
    {
        Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS)
    } else {
        Duration::from_millis(APPROVED_RECONNECT_STALL_MS)
    };

    now.duration_since(last_progress) >= restart_after
}

pub(crate) fn next_reconnect_attempt(
    state: &ApprovedReconnectState,
    active_for_node: bool,
) -> Option<u32> {
    if active_for_node
        || state.retry_exhausted
        || state.awaiting_user_decision
        || state.attempt >= RECONNECT_ATTEMPT_LIMIT
    {
        return None;
    }

    Some(state.attempt + 1)
}

pub(crate) fn node_key(node: &DiscoveredNode) -> String {
    node.peripheral_id
        .clone()
        .or_else(|| node.known_device_id.clone())
        .unwrap_or_else(|| node.id.clone())
}

fn unique_name_only_rule_id<'a>(
    local_name: Option<&str>,
    rules: &'a [ApprovedNodeRule],
) -> Option<&'a str> {
    let candidate_name = local_name?;
    let mut matches = rules.iter().filter(|rule| {
        rule.known_device_id.is_none()
            && rule.peripheral_id.is_none()
            && rule.address.is_none()
            && rule
                .local_name
                .as_ref()
                .map(|value| value == candidate_name)
                .unwrap_or(false)
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.id.as_str())
}

pub(crate) fn rule_matches_node(
    rule: &ApprovedNodeRule,
    node: &DiscoveredNode,
    rules: &[ApprovedNodeRule],
) -> bool {
    let strong_identity_match = rule
        .known_device_id
        .as_ref()
        .zip(node.known_device_id.as_ref())
        .map(|(left, right)| left == right)
        .unwrap_or(false)
        || rule
            .peripheral_id
            .as_ref()
            .zip(node.peripheral_id.as_ref())
            .map(|(left, right)| left == right)
            .unwrap_or(false)
        || rule
            .address
            .as_ref()
            .zip(node.address.as_ref())
            .map(|(left, right)| left.eq_ignore_ascii_case(right))
            .unwrap_or(false);

    if strong_identity_match {
        return true;
    }

    unique_name_only_rule_id(node.local_name.as_deref(), rules)
        .map(|rule_id| rule_id == rule.id.as_str())
        .unwrap_or(false)
}

pub(crate) fn all_approved_nodes_connected(
    rules: &[ApprovedNodeRule],
    connected_nodes: &HashMap<String, DiscoveredNode>,
    reconnect_states: &HashMap<String, ApprovedReconnectState>,
) -> bool {
    !rules.is_empty()
        && rules.iter().all(|rule| {
            if reconnect_states
                .get(&rule.id)
                .map(|state| state.retry_exhausted)
                .unwrap_or(false)
            {
                return true;
            }

            connected_nodes
                .values()
                .any(|node| rule_matches_node(rule, node, rules))
        })
}

pub(crate) fn is_approved(node: &DiscoveredNode, rules: &[ApprovedNodeRule]) -> bool {
    approved_rule_id_for_node(node, rules).is_some()
}
