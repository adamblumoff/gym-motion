use super::*;
use crate::windows::session_transport_recovery::recovery_gatt_snapshot;
use btleplug::api::{CharPropFlags, Characteristic};

fn runtime_characteristic(service_uuid: Uuid, uuid: Uuid) -> Characteristic {
    Characteristic {
        uuid,
        service_uuid,
        properties: CharPropFlags::READ | CharPropFlags::WRITE | CharPropFlags::NOTIFY,
        descriptors: Default::default(),
    }
}

fn runtime_config() -> Config {
    Config {
        service_uuid: Uuid::parse_str("4b2f41d1-6f1b-4d3a-92e5-7db4891f7001").unwrap(),
        telemetry_uuid: Uuid::parse_str("4b2f41d1-6f1b-4d3a-92e5-7db4891f7002").unwrap(),
        control_uuid: Uuid::parse_str("4b2f41d1-6f1b-4d3a-92e5-7db4891f7003").unwrap(),
        status_uuid: Uuid::parse_str("4b2f41d1-6f1b-4d3a-92e5-7db4891f7004").unwrap(),
        device_name_prefix: "GymMotion-".to_string(),
        verbose_logging: false,
    }
}

#[test]
fn recovery_snapshot_marks_missing_runtime_control_characteristic() {
    let config = runtime_config();
    let characteristics = vec![
        runtime_characteristic(config.service_uuid, config.telemetry_uuid),
        runtime_characteristic(config.service_uuid, config.status_uuid),
    ];

    let snapshot = recovery_gatt_snapshot([config.service_uuid], &characteristics, &config);

    assert!(snapshot.runtime_service_present);
    assert!(snapshot.telemetry_present);
    assert!(!snapshot.control_present);
    assert!(snapshot.status_present);
    assert_eq!(snapshot.service_count, 1);
    assert_eq!(snapshot.characteristic_count, 2);
}

#[test]
fn recovery_snapshot_marks_complete_runtime_gatt_state() {
    let config = runtime_config();
    let characteristics = vec![
        runtime_characteristic(config.service_uuid, config.telemetry_uuid),
        runtime_characteristic(config.service_uuid, config.control_uuid),
        runtime_characteristic(config.service_uuid, config.status_uuid),
    ];

    let snapshot = recovery_gatt_snapshot([config.service_uuid], &characteristics, &config);

    assert!(snapshot.runtime_service_present);
    assert!(snapshot.telemetry_present);
    assert!(snapshot.control_present);
    assert!(snapshot.status_present);
    assert_eq!(snapshot.service_count, 1);
    assert_eq!(snapshot.characteristic_count, 3);
}
