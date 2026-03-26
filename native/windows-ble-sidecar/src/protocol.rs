use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedNodeRule {
    pub id: String,
    pub label: String,
    pub peripheral_id: Option<String>,
    pub address: Option<String>,
    pub local_name: Option<String>,
    pub known_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdapterSummary {
    pub id: String,
    pub label: String,
    pub transport: String,
    pub is_available: bool,
    pub issue: Option<String>,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GatewayStatePayload {
    pub adapter_state: String,
    pub scan_state: String,
    pub scan_reason: Option<String>,
    pub selected_adapter_id: Option<String>,
    pub last_advertisement_at: Option<String>,
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredNode {
    pub id: String,
    pub label: String,
    pub peripheral_id: Option<String>,
    pub address: Option<String>,
    pub local_name: Option<String>,
    pub known_device_id: Option<String>,
    pub last_rssi: Option<i16>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconnectStatus {
    pub attempt: u32,
    pub attempt_limit: u32,
    pub retry_exhausted: bool,
    pub awaiting_user_decision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TelemetryPayload {
    #[serde(alias = "deviceId")]
    pub device_id: String,
    pub state: String,
    pub timestamp: i64,
    pub delta: Option<i64>,
    pub sequence: Option<u64>,
    #[serde(alias = "bootId")]
    pub boot_id: Option<String>,
    #[serde(alias = "firmwareVersion")]
    pub firmware_version: Option<String>,
    #[serde(alias = "hardwareId")]
    pub hardware_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeStatusPayload {
    #[serde(rename = "type")]
    pub status_type: String,
    #[serde(alias = "deviceId")]
    pub device_id: Option<String>,
    #[serde(alias = "bootId")]
    pub boot_id: Option<String>,
    #[serde(alias = "bootUptimeMs")]
    pub boot_uptime_ms: Option<u64>,
    #[serde(alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(alias = "sessionNonce")]
    pub session_nonce: Option<String>,
    #[serde(alias = "firmwareVersion")]
    pub firmware_version: Option<String>,
    #[serde(alias = "hardwareId")]
    pub hardware_id: Option<String>,
    pub phase: Option<String>,
    pub message: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryRecordPayload {
    #[serde(rename = "type")]
    pub status_type: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(alias = "requestId")]
    pub request_id: String,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistorySyncCompletePayload {
    #[serde(rename = "type")]
    pub status_type: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(alias = "requestId")]
    pub request_id: String,
    #[serde(alias = "latestSequence")]
    pub latest_sequence: u64,
    #[serde(alias = "highWaterSequence")]
    pub high_water_sequence: u64,
    #[serde(alias = "sentCount")]
    pub sent_count: usize,
    #[serde(alias = "hasMore")]
    pub has_more: bool,
    pub overflowed: Option<bool>,
    #[serde(alias = "droppedCount")]
    pub dropped_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryErrorPayload {
    #[serde(rename = "type")]
    pub status_type: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    #[serde(alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(alias = "requestId")]
    pub request_id: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    ListAdapters,
    SelectAdapter { adapter_id: String },
    SetAllowedNodes { nodes: Vec<ApprovedNodeRule> },
    Start,
    Stop,
    Rescan,
    StartManualScan,
    RefreshScanPolicy,
    BeginHistorySync {
        device_id: String,
        after_sequence: u64,
        max_records: usize,
        request_id: String,
    },
    AcknowledgeHistorySync {
        device_id: String,
        sequence: u64,
        request_id: String,
    },
    PairManualCandidate { candidate_id: String },
    RecoverApprovedNode { rule_id: String },
    ResumeApprovedNodeReconnect { rule_id: String },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Ready {
        platform: String,
        protocol_version: u32,
    },
    AdapterList {
        adapters: Vec<AdapterSummary>,
    },
    GatewayState {
        gateway: GatewayStatePayload,
    },
    ManualScanState {
        state: String,
        candidate_id: Option<String>,
        error: Option<String>,
    },
    NodeDiscovered {
        node: DiscoveredNode,
        scan_reason: Option<String>,
    },
    NodeConnectionState {
        node: DiscoveredNode,
        gateway_connection_state: String,
        reason: Option<String>,
        reconnect: Option<ReconnectStatus>,
    },
    Telemetry {
        node: DiscoveredNode,
        payload: TelemetryPayload,
    },
    HistoryRecord {
        node: DiscoveredNode,
        device_id: String,
        request_id: String,
        record: Value,
    },
    HistorySyncComplete {
        node: DiscoveredNode,
        payload: HistorySyncCompletePayload,
    },
    HistoryError {
        node: DiscoveredNode,
        payload: HistoryErrorPayload,
    },
    Log {
        level: String,
        message: String,
        details: Option<Value>,
    },
    Error {
        message: String,
        details: Option<Value>,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ApprovedNodeRule, Command, Event, HistoryErrorPayload, HistorySyncCompletePayload,
        TelemetryPayload,
    };

    #[test]
    fn serializes_commands_with_expected_tag() {
        let value = serde_json::to_value(Command::SelectAdapter {
            adapter_id: "winrt:0".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "select_adapter");
        assert_eq!(value["adapter_id"], "winrt:0");
    }

    #[test]
    fn serializes_refresh_scan_policy_command() {
        let value =
            serde_json::to_value(Command::RefreshScanPolicy).expect("command should serialize");

        assert_eq!(value["type"], "refresh_scan_policy");
    }

    #[test]
    fn serializes_begin_history_sync_command() {
        let value = serde_json::to_value(Command::BeginHistorySync {
            device_id: "device-1".to_string(),
            after_sequence: 12,
            max_records: 0,
            request_id: "req-1".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "begin_history_sync");
        assert_eq!(value["device_id"], "device-1");
        assert_eq!(value["after_sequence"], 12);
        assert_eq!(value["max_records"], 0);
        assert_eq!(value["request_id"], "req-1");
    }

    #[test]
    fn serializes_acknowledge_history_sync_command() {
        let value = serde_json::to_value(Command::AcknowledgeHistorySync {
            device_id: "device-1".to_string(),
            sequence: 17,
            request_id: "req-1".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "acknowledge_history_sync");
        assert_eq!(value["device_id"], "device-1");
        assert_eq!(value["sequence"], 17);
        assert_eq!(value["request_id"], "req-1");
    }

    #[test]
    fn serializes_rescan_command() {
        let value = serde_json::to_value(Command::Rescan).expect("command should serialize");

        assert_eq!(value["type"], "rescan");
    }

    #[test]
    fn serializes_recover_approved_node_command() {
        let value = serde_json::to_value(Command::RecoverApprovedNode {
            rule_id: "known:stack-001".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "recover_approved_node");
        assert_eq!(value["rule_id"], "known:stack-001");
    }

    #[test]
    fn serializes_pair_manual_candidate_command() {
        let value = serde_json::to_value(Command::PairManualCandidate {
            candidate_id: "peripheral:abc".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "pair_manual_candidate");
        assert_eq!(value["candidate_id"], "peripheral:abc");
    }

    #[test]
    fn serializes_resume_approved_node_reconnect_command() {
        let value = serde_json::to_value(Command::ResumeApprovedNodeReconnect {
            rule_id: "known:stack-001".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "resume_approved_node_reconnect");
        assert_eq!(value["rule_id"], "known:stack-001");
    }

    #[test]
    fn round_trips_ready_event() {
        let event = Event::Ready {
            platform: "win32".to_string(),
            protocol_version: 1,
        };
        let encoded = serde_json::to_string(&event).expect("event should serialize");
        let decoded: Event = serde_json::from_str(&encoded).expect("event should deserialize");

        assert_eq!(decoded, event);
    }

    #[test]
    fn deserializes_allowed_node_rules() {
        let raw = r#"{
          "type": "set_allowed_nodes",
          "nodes": [
            {
              "id": "node-1",
              "label": "Bench Sensor",
              "peripheral_id": "abc",
              "address": null,
              "local_name": "GymMotion-123",
              "known_device_id": null
            }
          ]
        }"#;

        let command: Command = serde_json::from_str(raw).expect("command should deserialize");

        assert_eq!(
            command,
            Command::SetAllowedNodes {
                nodes: vec![ApprovedNodeRule {
                    id: "node-1".to_string(),
                    label: "Bench Sensor".to_string(),
                    peripheral_id: Some("abc".to_string()),
                    address: None,
                    local_name: Some("GymMotion-123".to_string()),
                    known_device_id: None,
                }],
            }
        );
    }

    #[test]
    fn serializes_telemetry_event_payload() {
        let event = Event::Telemetry {
            node: super::DiscoveredNode {
                id: "peripheral:abc".to_string(),
                label: "GymMotion-123".to_string(),
                peripheral_id: Some("abc".to_string()),
                address: None,
                local_name: Some("GymMotion-123".to_string()),
                known_device_id: Some("device-1".to_string()),
                last_rssi: Some(-61),
                last_seen_at: Some("2026-03-14T00:00:00.000Z".to_string()),
            },
            payload: TelemetryPayload {
                device_id: "device-1".to_string(),
                state: "moving".to_string(),
                timestamp: 1234,
                delta: Some(41),
                sequence: Some(7),
                boot_id: Some("boot-1".to_string()),
                firmware_version: Some("1.0.0".to_string()),
                hardware_id: Some("hw-1".to_string()),
            },
        };

        let value = serde_json::to_value(event).expect("event should serialize");

        assert_eq!(value["type"], "telemetry");
        assert_eq!(value["payload"]["state"], "moving");
        assert_eq!(value["node"]["known_device_id"], "device-1");
    }

    #[test]
    fn serializes_discovery_event_with_scan_reason() {
        let event = Event::NodeDiscovered {
            node: super::DiscoveredNode {
                id: "peripheral:abc".to_string(),
                label: "GymMotion-123".to_string(),
                peripheral_id: Some("abc".to_string()),
                address: Some("AA:BB".to_string()),
                local_name: Some("GymMotion-123".to_string()),
                known_device_id: None,
                last_rssi: Some(-61),
                last_seen_at: Some("2026-03-14T00:00:00.000Z".to_string()),
            },
            scan_reason: Some("approved-reconnect".to_string()),
        };

        let value = serde_json::to_value(event).expect("event should serialize");

        assert_eq!(value["type"], "node_discovered");
        assert_eq!(value["scan_reason"], "approved-reconnect");
        assert_eq!(value["node"]["address"], "AA:BB");
    }

    #[test]
    fn deserializes_camel_case_telemetry_payload() {
        let raw = r#"{
          "deviceId": "device-1",
          "state": "moving",
          "timestamp": 1234,
          "delta": 41,
          "sequence": 7,
          "bootId": "boot-1",
          "firmwareVersion": "1.0.0",
          "hardwareId": "hw-1"
        }"#;

        let payload: TelemetryPayload =
            serde_json::from_str(raw).expect("camelCase telemetry should deserialize");

        assert_eq!(payload.device_id, "device-1");
        assert_eq!(payload.boot_id.as_deref(), Some("boot-1"));
        assert_eq!(payload.firmware_version.as_deref(), Some("1.0.0"));
        assert_eq!(payload.hardware_id.as_deref(), Some("hw-1"));
    }

    #[test]
    fn serializes_history_record_event() {
        let value = serde_json::to_value(Event::HistoryRecord {
            node: super::DiscoveredNode {
                id: "peripheral:abc".to_string(),
                label: "GymMotion-123".to_string(),
                peripheral_id: Some("abc".to_string()),
                address: None,
                local_name: Some("GymMotion-123".to_string()),
                known_device_id: Some("device-1".to_string()),
                last_rssi: Some(-61),
                last_seen_at: Some("2026-03-14T00:00:00.000Z".to_string()),
            },
            device_id: "device-1".to_string(),
            request_id: "req-1".to_string(),
            record: json!({
                "kind": "motion",
                "sequence": 8,
                "state": "moving",
                "timestamp": 1234,
            }),
        })
        .expect("event should serialize");

        assert_eq!(value["type"], "history_record");
        assert_eq!(value["device_id"], "device-1");
        assert_eq!(value["request_id"], "req-1");
        assert_eq!(value["record"]["sequence"], 8);
    }

    #[test]
    fn serializes_history_sync_complete_event() {
        let value = serde_json::to_value(Event::HistorySyncComplete {
            node: super::DiscoveredNode {
                id: "peripheral:abc".to_string(),
                label: "GymMotion-123".to_string(),
                peripheral_id: Some("abc".to_string()),
                address: None,
                local_name: Some("GymMotion-123".to_string()),
                known_device_id: Some("device-1".to_string()),
                last_rssi: Some(-61),
                last_seen_at: Some("2026-03-14T00:00:00.000Z".to_string()),
            },
            payload: HistorySyncCompletePayload {
                status_type: "history-page-complete".to_string(),
                device_id: "device-1".to_string(),
                request_id: "req-1".to_string(),
                latest_sequence: 20,
                high_water_sequence: 24,
                sent_count: 4,
                has_more: true,
                overflowed: Some(true),
                dropped_count: Some(2),
            },
        })
        .expect("event should serialize");

        assert_eq!(value["type"], "history_sync_complete");
        assert_eq!(value["payload"]["device_id"], "device-1");
        assert_eq!(value["payload"]["request_id"], "req-1");
        assert_eq!(value["payload"]["latest_sequence"], 20);
        assert_eq!(value["payload"]["has_more"], true);
    }

    #[test]
    fn serializes_history_error_event() {
        let value = serde_json::to_value(Event::HistoryError {
            node: DiscoveredNode {
                id: "node-1".to_string(),
                label: "GymMotion-node-1".to_string(),
                peripheral_id: Some("AA:BB".to_string()),
                address: Some("11:22".to_string()),
                local_name: Some("GymMotion-node-1".to_string()),
                known_device_id: Some("device-1".to_string()),
                last_rssi: Some(-40),
                last_seen_at: Some("2026-03-14T00:00:00.000Z".to_string()),
            },
            payload: HistoryErrorPayload {
                status_type: "history-error".to_string(),
                device_id: "device-1".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: Some("req-1".to_string()),
                code: "history.session_unavailable".to_string(),
                message: "History sync requires an active runtime app session.".to_string(),
            },
        })
        .expect("event should serialize");

        assert_eq!(value["type"], "history_error");
        assert_eq!(value["payload"]["device_id"], "device-1");
        assert_eq!(value["payload"]["request_id"], "req-1");
        assert_eq!(value["payload"]["code"], "history.session_unavailable");
    }
}
