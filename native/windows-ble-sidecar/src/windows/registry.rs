use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};

use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdvertisementSnapshot {
    pub(crate) address: String,
    pub(crate) local_name: Option<String>,
    pub(crate) service_uuids: HashSet<Uuid>,
    pub(crate) rssi: Option<i16>,
    pub(crate) seen_at: String,
    pub(crate) seen_at_monotonic: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceRecord {
    pub(crate) address: String,
    pub(crate) local_name: Option<String>,
    pub(crate) service_uuids: HashSet<Uuid>,
    pub(crate) rssi: Option<i16>,
    pub(crate) last_seen_at: String,
    pub(crate) reconnect_epoch: u64,
    pub(crate) sightings_in_epoch: u32,
    pub(crate) first_seen_at_monotonic: Instant,
    pub(crate) last_seen_at_monotonic: Instant,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DeviceRegistry {
    records_by_address: HashMap<String, DeviceRecord>,
    reconnect_epoch: u64,
}

impl DeviceRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn start_reconnect_epoch(&mut self) -> u64 {
        self.reconnect_epoch = self.reconnect_epoch.saturating_add(1);
        self.reconnect_epoch
    }

    pub(crate) fn upsert(&mut self, snapshot: AdvertisementSnapshot) -> DeviceRecord {
        let normalized_address = normalize_ble_address(&snapshot.address);
        let next = if let Some(existing) = self.records_by_address.get(&normalized_address) {
            let same_epoch = existing.reconnect_epoch == self.reconnect_epoch;
            DeviceRecord {
                address: normalized_address.clone(),
                local_name: snapshot.local_name.or_else(|| existing.local_name.clone()),
                service_uuids: if snapshot.service_uuids.is_empty() {
                    existing.service_uuids.clone()
                } else {
                    snapshot.service_uuids
                },
                rssi: snapshot.rssi.or(existing.rssi),
                last_seen_at: snapshot.seen_at,
                reconnect_epoch: self.reconnect_epoch,
                sightings_in_epoch: if same_epoch {
                    existing.sightings_in_epoch.saturating_add(1)
                } else {
                    1
                },
                first_seen_at_monotonic: if same_epoch {
                    existing.first_seen_at_monotonic
                } else {
                    snapshot.seen_at_monotonic
                },
                last_seen_at_monotonic: snapshot.seen_at_monotonic,
            }
        } else {
            DeviceRecord {
                address: normalized_address.clone(),
                local_name: snapshot.local_name,
                service_uuids: snapshot.service_uuids,
                rssi: snapshot.rssi,
                last_seen_at: snapshot.seen_at,
                reconnect_epoch: self.reconnect_epoch,
                sightings_in_epoch: 1,
                first_seen_at_monotonic: snapshot.seen_at_monotonic,
                last_seen_at_monotonic: snapshot.seen_at_monotonic,
            }
        };

        self.records_by_address
            .insert(normalized_address, next.clone());
        next
    }

    #[cfg(test)]
    pub(crate) fn get(&self, address: &str) -> Option<&DeviceRecord> {
        self.records_by_address.get(&normalize_ble_address(address))
    }
}

pub(crate) fn normalize_ble_address(address: &str) -> String {
    address.to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{AdvertisementSnapshot, DeviceRegistry};
    use std::{
        collections::HashSet,
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    #[test]
    fn upsert_normalizes_address_keys() {
        let mut registry = DeviceRegistry::new();

        registry.upsert(AdvertisementSnapshot {
            address: "AA:BB:CC:DD".to_string(),
            local_name: Some("GymMotion-a".to_string()),
            service_uuids: HashSet::new(),
            rssi: Some(-54),
            seen_at: "2026-03-16T18:00:00.000Z".to_string(),
            seen_at_monotonic: Instant::now(),
        });

        let device = registry.get("aa:bb:cc:dd").expect("device should exist");
        assert_eq!(device.address, "aa:bb:cc:dd");
        assert_eq!(device.local_name.as_deref(), Some("GymMotion-a"));
    }

    #[test]
    fn upsert_preserves_existing_fields_when_a_later_advertisement_is_sparse() {
        let mut registry = DeviceRegistry::new();
        let runtime_uuid =
            Uuid::parse_str("4b2f41d1-6f1b-4d3a-92e5-7db4891f7001").expect("uuid should parse");
        let mut initial_services = HashSet::new();
        initial_services.insert(runtime_uuid);

        registry.upsert(AdvertisementSnapshot {
            address: "AA:BB:CC:DD".to_string(),
            local_name: Some("GymMotion-a".to_string()),
            service_uuids: initial_services,
            rssi: Some(-54),
            seen_at: "2026-03-16T18:00:00.000Z".to_string(),
            seen_at_monotonic: Instant::now(),
        });

        let later = Instant::now() + Duration::from_millis(200);
        registry.upsert(AdvertisementSnapshot {
            address: "aa:bb:cc:dd".to_string(),
            local_name: None,
            service_uuids: HashSet::new(),
            rssi: None,
            seen_at: "2026-03-16T18:00:02.000Z".to_string(),
            seen_at_monotonic: later,
        });

        let device = registry.get("AA:BB:CC:DD").expect("device should exist");
        assert_eq!(device.local_name.as_deref(), Some("GymMotion-a"));
        assert_eq!(device.rssi, Some(-54));
        assert!(device.service_uuids.contains(&runtime_uuid));
        assert_eq!(device.last_seen_at, "2026-03-16T18:00:02.000Z");
        assert_eq!(device.sightings_in_epoch, 2);
    }

    #[test]
    fn upsert_resets_epoch_sighting_count_after_reconnect_epoch_advances() {
        let mut registry = DeviceRegistry::new();
        let initial = Instant::now();

        registry.upsert(AdvertisementSnapshot {
            address: "AA:BB:CC:DD".to_string(),
            local_name: Some("GymMotion-a".to_string()),
            service_uuids: HashSet::new(),
            rssi: Some(-54),
            seen_at: "2026-03-16T18:00:00.000Z".to_string(),
            seen_at_monotonic: initial,
        });

        registry.start_reconnect_epoch();

        registry.upsert(AdvertisementSnapshot {
            address: "AA:BB:CC:DD".to_string(),
            local_name: None,
            service_uuids: HashSet::new(),
            rssi: None,
            seen_at: "2026-03-16T18:00:03.000Z".to_string(),
            seen_at_monotonic: initial + Duration::from_millis(300),
        });

        let device = registry.get("AA:BB:CC:DD").expect("device should exist");
        assert_eq!(device.sightings_in_epoch, 1);
        assert_eq!(device.reconnect_epoch, 1);
    }
}
