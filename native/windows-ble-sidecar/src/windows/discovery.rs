use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use btleplug::{api::Peripheral as _, platform::Peripheral};
use tokio::sync::RwLock;

use crate::protocol::{ApprovedNodeRule, DiscoveredNode};

use super::{approval::classify_discovery_candidate, config::Config};

pub(crate) async fn discovered_node_from_peripheral(
    peripheral: &Peripheral,
    config: &Config,
    allowed_nodes: &[ApprovedNodeRule],
    known_device_ids: &Arc<RwLock<HashMap<String, String>>>,
    allow_approved_identity_fallback: bool,
) -> Result<Option<DiscoveredNode>> {
    let Some(properties) = peripheral.properties().await? else {
        return Ok(None);
    };

    let local_name = properties.local_name.or(properties.advertisement_name);
    let has_runtime_service = properties
        .services
        .iter()
        .any(|uuid| *uuid == config.service_uuid);
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

    let known_device_id = classification.matched_known_device_id;
    let label = local_name
        .clone()
        .or_else(|| known_device_id.clone())
        .unwrap_or_else(|| peripheral_id.clone());

    Ok(Some(DiscoveredNode {
        id: format!("peripheral:{peripheral_id}"),
        label,
        peripheral_id: Some(peripheral_id),
        address,
        local_name,
        known_device_id,
        last_rssi: properties.rssi,
        last_seen_at: Some(iso_now()),
    }))
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
