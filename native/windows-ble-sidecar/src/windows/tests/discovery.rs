use super::*;
use crate::windows::discovery::{service_uuid_session_token, split_local_name_and_session};

fn test_config() -> Config {
    Config {
        service_uuid: Uuid::nil(),
        telemetry_uuid: Uuid::nil(),
        control_uuid: Uuid::nil(),
        status_uuid: Uuid::nil(),
        history_service_uuid: Uuid::nil(),
        history_control_uuid: Uuid::nil(),
        history_status_uuid: Uuid::nil(),
        device_name_prefix: "GymMotion-".to_string(),
        verbose_logging: false,
    }
}

#[test]
fn retryable_pre_session_setup_failures_use_the_inline_setup_retry() {
    let subscribe_error = anyhow::anyhow!("status subscribe step failed for Bench");
    let closed_lease_error = anyhow::anyhow!(
        "app-session-lease step failed for Bench: Error {{ code: HRESULT(0x80000013), message: \"The object has been closed.\" }}"
    );

    assert!(is_retryable_pre_session_setup_error(&subscribe_error));
    assert!(is_retryable_pre_session_setup_error(&closed_lease_error));
}

#[test]
fn approved_reconnect_waits_for_stronger_signal_after_first_sparse_sighting() {
    let classification = classify_discovery_candidate(
        "peripheral-2",
        Some("aa:bb"),
        None,
        false,
        &test_config(),
        &[ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: None,
            address: Some("AA:BB".to_string()),
            local_name: None,
            known_device_id: Some("stack-001".to_string()),
        }],
        &HashMap::new(),
    );

    let now = Instant::now();
    let record = DeviceRecord {
        address: "aa:bb".to_string(),
        local_name: None,
        service_uuids: Default::default(),
        rssi: Some(-50),
        last_seen_at: "2026-03-16T18:00:00.000Z".to_string(),
        reconnect_epoch: 1,
        sightings_in_epoch: 1,
        first_seen_at_monotonic: now,
        last_seen_at_monotonic: now,
    };

    assert!(!reconnect_candidate_ready(
        &classification,
        false,
        Some(&record),
    ));
}

#[test]
fn approved_reconnect_allows_sparse_repeat_sighting_for_approved_identity() {
    let classification = classify_discovery_candidate(
        "peripheral-2",
        Some("aa:bb"),
        None,
        false,
        &test_config(),
        &[ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: None,
            address: Some("AA:BB".to_string()),
            local_name: None,
            known_device_id: Some("stack-001".to_string()),
        }],
        &HashMap::new(),
    );

    let start = Instant::now();
    let record = DeviceRecord {
        address: "aa:bb".to_string(),
        local_name: None,
        service_uuids: Default::default(),
        rssi: Some(-50),
        last_seen_at: "2026-03-16T18:00:00.300Z".to_string(),
        reconnect_epoch: 1,
        sightings_in_epoch: 2,
        first_seen_at_monotonic: start,
        last_seen_at_monotonic: start + Duration::from_millis(300),
    };

    assert!(reconnect_candidate_ready(
        &classification,
        false,
        Some(&record),
    ));
}

#[test]
fn approved_reconnect_allows_visible_local_name_without_runtime_service() {
    let classification = classify_discovery_candidate(
        "peripheral-2",
        Some("aa:bb"),
        Some("GymMotion-ac12c0"),
        false,
        &test_config(),
        &[ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench".to_string(),
            peripheral_id: None,
            address: Some("AA:BB".to_string()),
            local_name: Some("GymMotion-ac12c0".to_string()),
            known_device_id: Some("stack-001".to_string()),
        }],
        &HashMap::new(),
    );

    assert!(reconnect_candidate_ready(&classification, true, None,));
}

#[test]
fn explicit_windows_pairing_can_connect_visible_name_prefix_nodes() {
    let classification = classify_discovery_candidate(
        "peripheral-2",
        Some("aa:bb"),
        Some("GymMotion-f4e9d4"),
        false,
        &test_config(),
        &[],
        &HashMap::new(),
    );

    assert!(explicit_connect_candidate_ready(
        &classification,
        true,
        true
    ));
    assert!(!explicit_connect_candidate_ready(
        &classification,
        true,
        false
    ));
}

#[test]
fn manual_discovery_stays_strict_when_only_approved_identity_matches() {
    let config = test_config();
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

    let manual_discovery_accepted =
        classification.runtime_service_matched || classification.name_prefix_matched;

    assert!(classification.approved_identity_matched);
    assert!(!manual_discovery_accepted);
}

#[test]
fn approved_reconnect_does_not_match_shared_local_name_without_stronger_identity() {
    let config = test_config();
    let allowed = vec![
        ApprovedNodeRule {
            id: "node-1".to_string(),
            label: "Bench A".to_string(),
            peripheral_id: None,
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: Some("stack-001".to_string()),
        },
        ApprovedNodeRule {
            id: "node-2".to_string(),
            label: "Bench B".to_string(),
            peripheral_id: None,
            address: None,
            local_name: Some("GymMotion-f4e9d4".to_string()),
            known_device_id: Some("stack-002".to_string()),
        },
    ];

    let classification = classify_discovery_candidate(
        "peripheral-9",
        None,
        Some("GymMotion-f4e9d4"),
        false,
        &config,
        &allowed,
        &HashMap::new(),
    );

    assert!(!classification.approved_identity_matched);
    assert!(classification.matched_known_device_id.is_none());
}

#[test]
fn duplicate_name_only_rules_do_not_bind_one_connected_node_to_multiple_approvals() {
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
    let connected = HashMap::from([(node_key(&node), node.clone())]);
    let reconnect_states = HashMap::new();

    assert!(approved_rule_id_for_node(&node, &rules).is_none());
    assert!(!all_approved_nodes_connected(
        &rules,
        &connected,
        &reconnect_states
    ));
}

#[test]
fn extracts_short_session_token_from_service_uuid_family() {
    let service_uuid = Uuid::parse_str("deadbeef-f2a7-e592-3a4d-1b6fd1412f4b")
        .expect("token uuid should parse");

    assert_eq!(
        service_uuid_session_token(&service_uuid),
        Some("deadbeef".to_string())
    );
}

#[test]
fn extracts_short_session_token_from_little_endian_service_uuid_family() {
    let service_uuid = Uuid::parse_str("efbeadde-a7f2-92e5-3a4d-1b6fd1412f4b")
        .expect("little-endian token uuid should parse");

    assert_eq!(
        service_uuid_session_token(&service_uuid),
        Some("efbeadde".to_string())
    );
}

#[test]
fn strips_short_session_token_suffix_from_local_name() {
    let (local_name, advertised_session_id) =
        split_local_name_and_session(Some("GymMotion-ac12c0-sdeadbeef".to_string()));

    assert_eq!(local_name, Some("GymMotion-ac12c0".to_string()));
    assert_eq!(advertised_session_id, Some("deadbeef".to_string()));
}
