use std::env;

use anyhow::{Context, Result};
use uuid::Uuid;

const SERVICE_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001";
const TELEMETRY_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002";
const CONTROL_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003";
const STATUS_UUID_FALLBACK: &str = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004";
const DEVICE_PREFIX_FALLBACK: &str = "GymMotion-";

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) service_uuid: Uuid,
    pub(crate) telemetry_uuid: Uuid,
    pub(crate) control_uuid: Uuid,
    pub(crate) status_uuid: Uuid,
    pub(crate) device_name_prefix: String,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
        Ok(Self {
            service_uuid: parse_uuid("BLE_RUNTIME_SERVICE_UUID", SERVICE_UUID_FALLBACK)?,
            telemetry_uuid: parse_uuid("BLE_TELEMETRY_UUID", TELEMETRY_UUID_FALLBACK)?,
            control_uuid: parse_uuid("BLE_CONTROL_UUID", CONTROL_UUID_FALLBACK)?,
            status_uuid: parse_uuid("BLE_STATUS_UUID", STATUS_UUID_FALLBACK)?,
            device_name_prefix: env::var("BLE_DEVICE_NAME_PREFIX")
                .unwrap_or_else(|_| DEVICE_PREFIX_FALLBACK.to_string()),
        })
    }
}

fn parse_uuid(name: &str, fallback: &str) -> Result<Uuid> {
    let raw = env::var(name).unwrap_or_else(|_| fallback.to_string());
    Ok(Uuid::parse_str(&raw).with_context(|| format!("invalid {name}: {raw}"))?)
}
