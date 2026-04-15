use super::*;
use crate::windows::session_types::added_allowed_rule_ids;

#[test]
fn scan_policy_stays_active_while_approved_nodes_are_missing() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let connected = HashMap::new();
    let reconnect_states = HashMap::new();

    assert!(approved_nodes_pending_connection(
        &rules,
        &connected,
        &reconnect_states
    ));
    assert!(should_scan(
        &rules,
        &connected,
        &reconnect_states,
        None,
        Instant::now()
    ));
}

#[test]
fn scan_policy_stops_once_all_approved_nodes_are_connected_without_manual_scan() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let mut connected = HashMap::new();
    let reconnect_states = HashMap::new();
    connected.insert(
        "peripheral-1".to_string(),
        DiscoveredNode {
            id: "peripheral:peripheral-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
            last_rssi: None,
            last_seen_at: None,
        },
    );

    assert!(!approved_nodes_pending_connection(
        &rules,
        &connected,
        &reconnect_states
    ));
    assert!(!should_scan(
        &rules,
        &connected,
        &reconnect_states,
        None,
        Instant::now()
    ));
}

#[test]
fn exhausted_approved_nodes_no_longer_keep_reconnect_scan_active() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let connected = HashMap::new();
    let reconnect_states = HashMap::from([(
        "node-1".to_string(),
        ApprovedReconnectState {
            attempt: 20,
            retry_exhausted: true,
            awaiting_user_decision: true,
        },
    )]);

    assert!(!approved_nodes_pending_connection(
        &rules,
        &connected,
        &reconnect_states
    ));
    assert!(!should_scan(
        &rules,
        &connected,
        &reconnect_states,
        None,
        Instant::now()
    ));
}

#[test]
fn healthy_connections_clear_pending_reconnect_even_without_device_connected_event() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: Some("AA:BB".to_string()),
        local_name: Some("GymMotion-f4e9d4".to_string()),
        known_device_id: Some("stack-001".to_string()),
    }];
    let mut connected = HashMap::new();
    let mut reconnect_states = HashMap::from([(
        "node-1".to_string(),
        ApprovedReconnectState {
            attempt: 7,
            retry_exhausted: false,
            awaiting_user_decision: false,
        },
    )]);
    let node = DiscoveredNode {
        id: "known:stack-001".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: Some("AA:BB".to_string()),
        local_name: Some("GymMotion-f4e9d4".to_string()),
        known_device_id: Some("stack-001".to_string()),
        last_rssi: None,
        last_seen_at: None,
    };

    mark_node_connected(&mut connected, &mut reconnect_states, &node, &rules);

    assert!(!approved_nodes_pending_connection(
        &rules,
        &connected,
        &reconnect_states
    ));
    assert_eq!(
        reconnect_states.get("node-1").map(|state| state.attempt),
        Some(0)
    );
}

#[test]
fn reconnect_scan_clears_peripherals_only_when_no_connections_are_active() {
    let connected = HashMap::new();

    assert!(!should_clear_reconnect_peripherals(&connected, 1));
    assert!(should_clear_reconnect_peripherals(&connected, 0));
}

#[test]
fn refresh_scan_policy_prunes_exhausted_rules_that_are_no_longer_allowed() {
    let allowed = vec![ApprovedNodeRule {
        id: "node-2".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-2".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let mut reconnect_states = HashMap::from([
        (
            "node-1".to_string(),
            ApprovedReconnectState {
                attempt: 20,
                retry_exhausted: true,
                awaiting_user_decision: true,
            },
        ),
        (
            "node-2".to_string(),
            ApprovedReconnectState {
                attempt: 2,
                retry_exhausted: false,
                awaiting_user_decision: false,
            },
        ),
    ]);

    prune_reconnect_states(&mut reconnect_states, &allowed);

    assert!(!reconnect_states.contains_key("node-1"));
    assert_eq!(
        reconnect_states.get("node-2").map(|state| state.attempt),
        Some(2)
    );
}

#[test]
fn allowed_node_updates_track_new_rule_ids_for_immediate_reconnect_checks() {
    let previous = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench A".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let next = vec![
        previous[0].clone(),
        ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench B".to_string(),
            peripheral_id: Some("peripheral-2".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        },
    ];

    assert_eq!(
        added_allowed_rule_ids(&previous, &next),
        vec!["node-2".to_string()]
    );
}

#[test]
fn next_reconnect_attempt_only_stops_for_active_or_paused_rules() {
    let state = ApprovedReconnectState {
        attempt: RECONNECT_ATTEMPT_LIMIT,
        retry_exhausted: false,
        awaiting_user_decision: false,
    };

    assert_eq!(
        next_reconnect_attempt(&state, false),
        Some(RECONNECT_ATTEMPT_LIMIT + 1)
    );
    assert!(next_reconnect_attempt(&ApprovedReconnectState::default(), true).is_none());
    assert!(next_reconnect_attempt(
        &ApprovedReconnectState {
            attempt: RECONNECT_ATTEMPT_LIMIT,
            retry_exhausted: true,
            awaiting_user_decision: true,
        },
        false,
    )
    .is_none());
    assert_eq!(
        next_reconnect_attempt(
            &ApprovedReconnectState {
                attempt: 3,
                retry_exhausted: false,
                awaiting_user_decision: false,
            },
            false,
        ),
        Some(4)
    );
}

#[test]
fn approved_reconnect_scan_restart_pauses_while_a_handshake_is_active() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let now = Instant::now();

    assert!(!should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
        Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
        1,
    ));

    assert!(should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
        None,
        0,
    ));
}

#[test]
fn sync_scan_state_does_not_restart_approved_reconnect_while_connection_is_active() {
    assert!(should_pause_approved_reconnect_scan(
        Some("approved-reconnect"),
        1,
    ));
    assert!(!should_pause_approved_reconnect_scan(
        Some("approved-reconnect"),
        0,
    ));
    assert!(!should_pause_approved_reconnect_scan(Some("manual"), 1));
}

#[test]
fn pause_approved_reconnect_marks_missing_rules_awaiting_operator_input() {
    let rules = vec![
        ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench 1".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        },
        ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench 2".to_string(),
            peripheral_id: Some("peripheral-2".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
        },
    ];
    let connected_nodes = HashMap::from([(
        "peripheral-1".to_string(),
        DiscoveredNode {
            id: "peripheral:peripheral-1".to_string(),
            label: "Bench 1".to_string(),
            peripheral_id: Some("peripheral-1".to_string()),
            address: None,
            local_name: None,
            known_device_id: None,
            last_rssi: None,
            last_seen_at: None,
        },
    )]);
    let mut reconnect_states = HashMap::new();

    let paused_rules = pause_approved_reconnect_for_operator_decision(
        &rules,
        &connected_nodes,
        &mut reconnect_states,
    );

    assert_eq!(paused_rules.len(), 1);
    assert_eq!(paused_rules[0].id, "node-2");
    assert_eq!(
        reconnect_states
            .get("node-2")
            .map(|state| state.awaiting_user_decision),
        Some(true)
    );
    assert!(!reconnect_states.contains_key("node-1"));
}

#[test]
fn disconnected_node_from_rule_preserves_approved_identity_fields() {
    let rule = ApprovedNodeRule {
        id: "rule-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: Some("AA:BB".to_string()),
        local_name: Some("GymMotion-bench".to_string()),
        known_device_id: Some("stack-001".to_string()),
    };

    let node = disconnected_node_from_rule(&rule);

    assert_eq!(node.id, "known:stack-001");
    assert_eq!(node.label, "Bench");
    assert_eq!(node.peripheral_id.as_deref(), Some("peripheral-1"));
    assert_eq!(node.address.as_deref(), Some("AA:BB"));
    assert_eq!(node.local_name.as_deref(), Some("GymMotion-bench"));
    assert_eq!(node.known_device_id.as_deref(), Some("stack-001"));
}

#[test]
fn approved_reconnect_scan_restart_waits_for_a_real_stall() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let now = Instant::now();

    assert!(!should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS - 1)),
        None,
        0,
    ));
    assert!(should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
        None,
        0,
    ));
}

#[test]
fn approved_reconnect_scan_restart_is_more_aggressive_during_startup_burst() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let now = Instant::now();

    assert!(!should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS - 1)),
        Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
        0,
    ));
    assert!(should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        now,
        Some(now - Duration::from_millis(APPROVED_RECONNECT_SCAN_BURST_MS)),
        Some(now + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
        0,
    ));
}

#[test]
fn removed_allowed_nodes_are_selected_for_disconnect() {
    let allowed = vec![ApprovedNodeRule {
        id: "node-2".to_string(),
        label: "Bench 2".to_string(),
        peripheral_id: Some("peripheral-2".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let connected = HashMap::from([
        (
            "peripheral-1".to_string(),
            DiscoveredNode {
                id: "peripheral:peripheral-1".to_string(),
                label: "Bench 1".to_string(),
                peripheral_id: Some("peripheral-1".to_string()),
                address: None,
                local_name: None,
                known_device_id: None,
                last_rssi: None,
                last_seen_at: None,
            },
        ),
        (
            "peripheral-2".to_string(),
            DiscoveredNode {
                id: "peripheral:peripheral-2".to_string(),
                label: "Bench 2".to_string(),
                peripheral_id: Some("peripheral-2".to_string()),
                address: None,
                local_name: None,
                known_device_id: None,
                last_rssi: None,
                last_seen_at: None,
            },
        ),
    ]);

    let removed = disconnected_nodes_removed_from_allowed(&connected, &allowed);

    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].peripheral_id.as_deref(), Some("peripheral-1"));
}
