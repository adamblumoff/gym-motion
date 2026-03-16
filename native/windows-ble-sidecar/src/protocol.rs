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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    ListAdapters,
    SelectAdapter { adapter_id: String },
    SetAllowedNodes { nodes: Vec<ApprovedNodeRule> },
    Start,
    Stop,
    Rescan,
    RefreshScanPolicy,
    RecoverApprovedNode { rule_id: String },
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
    use super::{ApprovedNodeRule, Command, Event, TelemetryPayload};

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
    fn serializes_recover_approved_node_command() {
        let value = serde_json::to_value(Command::RecoverApprovedNode {
            rule_id: "known:stack-001".to_string(),
        })
        .expect("command should serialize");

        assert_eq!(value["type"], "recover_approved_node");
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
}
