use super::*;

#[test]
fn frames_runtime_control_commands_for_firmware_parser() {
    let frames = control_command_frames(r#"{"type":"sync-now"}"#);

    assert_eq!(frames.first().map(Vec::as_slice), Some(&b"BEGIN:19"[..]));
    assert_eq!(
        frames.get(1).map(Vec::as_slice),
        Some(&br#"{"type":"sync-now"}"#[..])
    );
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

#[test]
fn frames_app_session_bootstrap_commands_for_firmware_parser() {
    let payload = r#"{"type":"app-session-bootstrap","sessionNonce":"nonce-1"}"#;
    let frames = control_command_frames(payload);

    assert_eq!(
        frames.first().map(Vec::as_slice),
        Some(format!("BEGIN:{}", payload.len()).as_bytes())
    );
    assert_eq!(frames.get(1).map(Vec::as_slice), Some(payload.as_bytes()));
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

#[test]
fn frames_app_session_lease_commands_for_firmware_parser() {
    let payload = format!(
        r#"{{"type":"app-session-lease","sessionId":"session-1","expiresInMs":{}}}"#,
        15_000
    );
    let frames = control_command_frames(&payload);

    assert_eq!(
        frames.first().map(Vec::as_slice),
        Some(format!("BEGIN:{}", payload.len()).as_bytes())
    );

    let body = frames[1..frames.len() - 1]
        .iter()
        .flat_map(|frame| frame.iter().copied())
        .collect::<Vec<_>>();
    let decoded: Value =
        serde_json::from_slice(&body).expect("lease payload should decode as JSON");

    assert_eq!(decoded["type"], "app-session-lease");
    assert_eq!(decoded["sessionId"], "session-1");
    assert_eq!(decoded["expiresInMs"], 15_000);
    assert_eq!(frames.last().map(Vec::as_slice), Some(&b"END"[..]));
}

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
fn reconnect_scan_does_not_clear_peripherals_during_silent_retry_bursts() {
    let connected = HashMap::new();

    assert!(!should_clear_reconnect_peripherals(&connected, 1));
    assert!(!should_clear_reconnect_peripherals(&connected, 0));
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

    assert!(!should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        Instant::now(),
        Some(Instant::now() - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
        Some(Instant::now() + Duration::from_millis(APPROVED_RECONNECT_STARTUP_BURST_MS)),
        1,
    ));

    assert!(should_restart_approved_reconnect_scan(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        Instant::now(),
        Some(Instant::now() - Duration::from_millis(APPROVED_RECONNECT_STALL_MS)),
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

#[test]
fn shared_local_name_alone_does_not_make_a_node_approved() {
    let rules = vec![
        ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench A".to_string(),
            peripheral_id: None,
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: None,
        },
        ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench B".to_string(),
            peripheral_id: None,
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: None,
        },
    ];
    let node = DiscoveredNode {
        id: "peripheral:peripheral-9".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-9".to_string()),
        address: None,
        local_name: Some("GymMotion-f4e9d4".to_string()),
        known_device_id: None,
        last_rssi: None,
        last_seen_at: None,
    };

    assert!(!is_approved(&node, &rules));
}

#[test]
fn approved_reconnect_scan_reason_stays_silent_without_manual_scan_window() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];

    assert_eq!(
        scan_reason(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            None,
            Instant::now()
        ),
        Some("approved-reconnect")
    );
}

#[test]
fn manual_scan_reason_overrides_silent_reconnect_when_operator_starts_scan() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];

    assert_eq!(
        scan_reason(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            Some(Instant::now() + Duration::from_secs(5)),
            Instant::now(),
        ),
        Some("manual")
    );
}

#[test]
fn approved_identity_fallback_applies_while_any_approved_node_is_still_missing() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];

    assert!(allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        None,
        Instant::now()
    ));

    let mut connected_nodes = HashMap::new();
    connected_nodes.insert(
        "node-1".to_string(),
        DiscoveredNode {
            id: "stack-node-1".to_string(),
            label: "Bench".to_string(),
            address: None,
            local_name: Some("GymMotion-bench".to_string()),
            last_rssi: None,
            last_seen_at: None,
            peripheral_id: Some("peripheral-1".to_string()),
            known_device_id: None,
        },
    );

    assert!(!allow_approved_identity_fallback(
        &rules,
        &connected_nodes,
        &HashMap::new(),
        None,
        Instant::now()
    ));
}

#[test]
fn manual_scan_reason_does_not_disable_approved_identity_fallback_for_missing_nodes() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];

    assert_eq!(
        scan_reason(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            Some(Instant::now() + Duration::from_secs(5)),
            Instant::now(),
        ),
        Some("manual")
    );

    assert!(allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        Some(Instant::now() + Duration::from_secs(5)),
        Instant::now()
    ));
}

#[test]
fn manual_scan_keeps_approved_identity_fallback_for_retry_exhausted_nodes() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: Some("AA:BB".to_string()),
        local_name: None,
        known_device_id: None,
    }];
    let reconnect_states = HashMap::from([(
        "node-1".to_string(),
        ApprovedReconnectState {
            attempt: RECONNECT_ATTEMPT_LIMIT,
            retry_exhausted: true,
            awaiting_user_decision: true,
        },
    )]);
    let now = Instant::now();

    assert!(allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &reconnect_states,
        Some(now + Duration::from_secs(5)),
        now
    ));

    assert!(!allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &reconnect_states,
        None,
        now
    ));
}

#[test]
fn approved_reconnect_candidate_matches_by_peripheral_id_without_service_uuid() {
    let config = Config {
        service_uuid: Uuid::nil(),
        telemetry_uuid: Uuid::nil(),
        control_uuid: Uuid::nil(),
        status_uuid: Uuid::nil(),
        device_name_prefix: "GymMotion-".to_string(),
        verbose_logging: false,
    };
    let allowed = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: Some("stack-001".to_string()),
    }];

    let classification = classify_discovery_candidate(
        "peripheral-1",
        Some("AA:BB"),
        None,
        false,
        &config,
        &allowed,
        &HashMap::new(),
    );

    assert!(classification.approved_identity_matched);
    assert_eq!(
        classification.matched_known_device_id.as_deref(),
        Some("stack-001")
    );
    assert!(!classification.runtime_service_matched);
    assert!(!classification.name_prefix_matched);
}

#[test]
fn approved_reconnect_candidate_matches_by_address_without_service_uuid() {
    let config = Config {
        service_uuid: Uuid::nil(),
        telemetry_uuid: Uuid::nil(),
        control_uuid: Uuid::nil(),
        status_uuid: Uuid::nil(),
        device_name_prefix: "GymMotion-".to_string(),
        verbose_logging: false,
    };
    let allowed = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: None,
        address: Some("AA:BB".to_string()),
        local_name: None,
        known_device_id: Some("stack-001".to_string()),
    }];

    let classification = classify_discovery_candidate(
        "peripheral-2",
        Some("aa:bb"),
        None,
        false,
        &config,
        &allowed,
        &HashMap::new(),
    );

    assert!(classification.approved_identity_matched);
    assert_eq!(
        classification.matched_known_device_id.as_deref(),
        Some("stack-001")
    );
}
