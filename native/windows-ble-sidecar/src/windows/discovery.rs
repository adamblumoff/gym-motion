use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Result;
use btleplug::{api::{Peripheral as _, PeripheralProperties}, platform::Peripheral};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::protocol::{ApprovedNodeRule, DiscoveredNode};

use super::{
    approval::{classify_discovery_candidate, DiscoveryClassification},
    config::Config,
};

pub(crate) struct DiscoveryCandidate {
    pub(crate) node: DiscoveredNode,
    pub(crate) classification: DiscoveryClassification,
    pub(crate) service_uuids: HashSet<Uuid>,
    pub(crate) advertised_session_id: Option<String>,
}

const RUNTIME_SESSION_ADVERTISEMENT_VERSION: u8 = 1;
const SHORT_SESSION_TOKEN_BYTES: usize = 4;
const RUNTIME_SESSION_MANUFACTURER_ID: u16 = 0xFFFF;
const RUNTIME_SESSION_ADVERTISEMENT_UUID: Uuid =
    Uuid::from_u128(0x0000_a7f1_0000_1000_8000_0080_5f9b_34fb);
const RUNTIME_SESSION_TOKEN_SERVICE_UUID_SUFFIXES: [&str; 2] = [
    "-f2a7-e592-3a4d-1b6fd1412f4b",
    "-a7f2-92e5-3a4d-1b6fd1412f4b",
];

pub(crate) async fn discovery_candidate_from_peripheral(
    peripheral: &Peripheral,
    config: &Config,
    allowed_nodes: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    allow_approved_identity_fallback: bool,
) -> Result<Option<DiscoveryCandidate>> {
    let Some(properties) = peripheral.properties().await? else {
        return Ok(None);
    };

    let raw_local_name = properties
        .advertisement_name
        .clone()
        .or(properties.local_name.clone());
    let (local_name, advertised_name_session_id) = split_local_name_and_session(raw_local_name);
    let advertised_session_id =
        advertised_name_session_id.or_else(|| advertised_session_id(&properties));
    let service_uuids = properties.services.iter().copied().collect::<HashSet<_>>();
    let has_runtime_service = service_uuids.contains(&config.service_uuid);
    let address = Some(properties.address.to_string());
    let peripheral_id = peripheral.id().to_string();
    let known_device_ids_guard = known_device_ids.read().await;
    let classification = classify_discovery_candidate(
        &peripheral_id,
        address.as_deref(),
        local_name.as_deref(),
        has_runtime_service,
        config,
        allowed_nodes,
        &known_device_ids_guard,
    );
    drop(known_device_ids_guard);

    let accepted = classification.runtime_service_matched
        || classification.name_prefix_matched
        || (allow_approved_identity_fallback && classification.approved_identity_matched);

    if !accepted {
        return Ok(None);
    }

    let known_device_id = classification.matched_known_device_id.clone();
    let label = local_name
        .clone()
        .or_else(|| known_device_id.clone())
        .unwrap_or_else(|| peripheral_id.clone());

    Ok(Some(DiscoveryCandidate {
        node: DiscoveredNode {
            id: format!("peripheral:{peripheral_id}"),
            label,
            peripheral_id: Some(peripheral_id),
            address,
            local_name,
            known_device_id,
            last_rssi: properties.rssi,
            last_seen_at: Some(iso_now()),
        },
        classification,
        service_uuids,
        advertised_session_id,
    }))
}

fn advertised_session_id(properties: &PeripheralProperties) -> Option<String> {
    if let Some(session_id) = properties.services.iter().find_map(service_uuid_session_token) {
        return Some(session_id);
    }

    if let Some(payload) = properties
        .manufacturer_data
        .get(&RUNTIME_SESSION_MANUFACTURER_ID)
    {
        if payload.len() == 1 + SHORT_SESSION_TOKEN_BYTES
            && payload.first().copied()? == RUNTIME_SESSION_ADVERTISEMENT_VERSION
        {
            let mut session_id = String::with_capacity(SHORT_SESSION_TOKEN_BYTES * 2);
            for byte in &payload[1..] {
                use std::fmt::Write as _;
                let _ = write!(&mut session_id, "{byte:02x}");
            }

            return Some(session_id);
        }
    }

    let payload = properties.service_data.get(&RUNTIME_SESSION_ADVERTISEMENT_UUID)?;
    if payload.len() != 1 + SHORT_SESSION_TOKEN_BYTES {
        return None;
    }
    if payload.first().copied()? != RUNTIME_SESSION_ADVERTISEMENT_VERSION {
        return None;
    }

    let mut session_id = String::with_capacity(SHORT_SESSION_TOKEN_BYTES * 2);
    for byte in &payload[1..] {
        use std::fmt::Write as _;
        let _ = write!(&mut session_id, "{byte:02x}");
    }

    Some(session_id)
}

pub(crate) fn service_uuid_session_token(service_uuid: &Uuid) -> Option<String> {
    let canonical = service_uuid.as_hyphenated().to_string().to_lowercase();
    if canonical.len() != 36
        || !RUNTIME_SESSION_TOKEN_SERVICE_UUID_SUFFIXES
            .iter()
            .any(|suffix| canonical.ends_with(suffix))
    {
        return None;
    }

    let token = canonical.get(..SHORT_SESSION_TOKEN_BYTES * 2)?;
    if token.len() != SHORT_SESSION_TOKEN_BYTES * 2 {
        return None;
    }
    if !token.chars().all(|value| value.is_ascii_hexdigit()) {
        return None;
    }

    Some(token.to_string())
}

pub(crate) fn split_local_name_and_session(
    local_name: Option<String>,
) -> (Option<String>, Option<String>) {
    let Some(local_name) = local_name else {
        return (None, None);
    };

    if local_name.len() > 10 {
        let token_start = local_name.len() - 10;
        let suffix = &local_name[token_start..];
        if let Some(token) = suffix.strip_prefix("-s") {
            if token.len() == 8 && token.chars().all(|value| value.is_ascii_hexdigit()) {
                return (Some(local_name[..token_start].to_string()), Some(token.to_lowercase()));
            }
        }
    }

    (Some(local_name), None)
}

pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}.{}Z",
        chrono_like_seconds(now.as_secs()),
        format!("{:03}", now.subsec_millis())
    )
}

fn chrono_like_seconds(seconds: u64) -> String {
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        .trim_end_matches('Z')
        .trim_end_matches(".000")
        .to_string()
}
