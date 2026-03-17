use super::*;

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
        id: "peripheral:peripheral-1".to_string(),
        label: "Visible node".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: Some("GymMotion-f4e9d4".to_string()),
        known_device_id: None,
        last_rssi: Some(-51),
        last_seen_at: None,
    };

    assert!(!is_approved(&node, &rules));
    assert_eq!(approved_rule_id_for_node(&node, &rules), None);
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
    let deadline = Instant::now() + Duration::from_secs(5);

    assert_eq!(
        scan_reason(
            &rules,
            &HashMap::new(),
            &HashMap::new(),
            Some(deadline),
            Instant::now()
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
    let deadline = Instant::now() + Duration::from_secs(5);

    assert!(allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &HashMap::new(),
        Some(deadline),
        Instant::now()
    ));
}

#[test]
fn manual_scan_keeps_approved_identity_fallback_for_retry_exhausted_nodes() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
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
    let deadline = Instant::now() + Duration::from_secs(5);

    assert!(allow_approved_identity_fallback(
        &rules,
        &HashMap::new(),
        &reconnect_states,
        Some(deadline),
        Instant::now()
    ));
}

#[test]
fn approved_reconnect_candidate_matches_by_peripheral_id_without_service_uuid() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
    }];
    let node = DiscoveredNode {
        id: "peripheral:peripheral-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: None,
        local_name: None,
        known_device_id: None,
        last_rssi: Some(-55),
        last_seen_at: None,
    };

    assert!(is_approved(&node, &rules));
}

#[test]
fn approved_reconnect_candidate_matches_by_address_without_service_uuid() {
    let rules = vec![ApprovedNodeRule {
        id: "node-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: None,
        address: Some("AA:BB".to_string()),
        local_name: None,
        known_device_id: None,
    }];
    let node = DiscoveredNode {
        id: "peripheral:peripheral-1".to_string(),
        label: "Bench".to_string(),
        peripheral_id: Some("peripheral-1".to_string()),
        address: Some("aa:bb".to_string()),
        local_name: None,
        known_device_id: None,
        last_rssi: Some(-55),
        last_seen_at: None,
    };

    assert!(is_approved(&node, &rules));
}
