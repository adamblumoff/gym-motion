import { getDb } from "@/lib/db";
import { deriveHealthStatus } from "@/lib/device-status";
import type {
  DeviceAssignmentInput,
  DeviceSummary,
  FirmwareReleaseInput,
  FirmwareReleaseSummary,
  HeartbeatPayload,
  IngestPayload,
  MotionEventSummary,
  MotionStreamPayload,
  ProvisioningState,
  UpdateStatus,
} from "@/lib/motion";

type DeviceRow = {
  id: string;
  last_state: DeviceSummary["lastState"];
  last_seen_at: string | number;
  last_delta: number | null;
  updated_at: Date;
  hardware_id: string | null;
  boot_id: string | null;
  firmware_version: string;
  machine_label: string | null;
  site_id: string | null;
  provisioning_state: ProvisioningState;
  update_status: UpdateStatus;
  last_heartbeat_at: Date | null;
  last_event_received_at: Date | null;
};

type MotionEventRow = {
  id: string | number;
  device_id: string;
  state: MotionEventSummary["state"];
  delta: number | null;
  event_timestamp: string | number;
  received_at: Date;
  boot_id: string | null;
  firmware_version: string | null;
  hardware_id: string | null;
};

type FirmwareReleaseRow = {
  version: string;
  git_sha: string;
  asset_url: string;
  sha256: string;
  md5: string | null;
  size_bytes: string | number;
  rollout_state: FirmwareReleaseSummary["rolloutState"];
  created_at: Date;
};

type FirmwareCheckInput = {
  deviceId: string;
  firmwareVersion: string | null;
};

function toSafeNumber(value: string | number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numericValue)) {
    throw new Error(`Value is not a safe integer: ${value}`);
  }

  return numericValue;
}

function mapDeviceRow(row: DeviceRow): DeviceSummary {
  const lastContactAt = row.last_heartbeat_at ?? row.last_event_received_at;

  return {
    id: row.id,
    lastState: row.last_state,
    lastSeenAt: toSafeNumber(row.last_seen_at),
    lastDelta: row.last_delta,
    updatedAt: row.updated_at.toISOString(),
    hardwareId: row.hardware_id,
    bootId: row.boot_id,
    firmwareVersion: row.firmware_version,
    machineLabel: row.machine_label,
    siteId: row.site_id,
    provisioningState: row.provisioning_state,
    updateStatus: row.update_status,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    lastEventReceivedAt: row.last_event_received_at?.toISOString() ?? null,
    healthStatus: deriveHealthStatus(lastContactAt?.toISOString() ?? null),
  };
}

function mapMotionEventRow(row: MotionEventRow): MotionEventSummary {
  return {
    id: toSafeNumber(row.id),
    deviceId: row.device_id,
    state: row.state,
    delta: row.delta,
    eventTimestamp: toSafeNumber(row.event_timestamp),
    receivedAt: row.received_at.toISOString(),
    bootId: row.boot_id,
    firmwareVersion: row.firmware_version,
    hardwareId: row.hardware_id,
  };
}

function mapFirmwareReleaseRow(row: FirmwareReleaseRow): FirmwareReleaseSummary {
  return {
    version: row.version,
    gitSha: row.git_sha,
    assetUrl: row.asset_url,
    sha256: row.sha256,
    md5: row.md5,
    sizeBytes: toSafeNumber(row.size_bytes),
    rolloutState: row.rollout_state,
    createdAt: row.created_at.toISOString(),
  };
}

export async function recordMotionEvent(payload: IngestPayload): Promise<MotionStreamPayload> {
  const delta = payload.delta ?? null;
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    const upsertedDevice = await client.query<DeviceRow>(
      `insert into devices (
         id,
         last_state,
         last_seen_at,
         last_delta,
         updated_at,
         hardware_id,
         boot_id,
         firmware_version,
         provisioning_state,
         update_status,
         last_event_received_at
       )
       values ($1, $2, $3, $4, now(), $5, $6, $7, 'provisioned', 'idle', now())
       on conflict (id) do update
       set last_state = excluded.last_state,
           last_seen_at = excluded.last_seen_at,
           last_delta = excluded.last_delta,
           updated_at = now(),
           hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
           boot_id = coalesce(excluded.boot_id, devices.boot_id),
           firmware_version = excluded.firmware_version,
           provisioning_state = case
             when devices.provisioning_state = 'unassigned' then 'provisioned'
             else devices.provisioning_state
           end,
           last_event_received_at = now()
       returning
         id,
         last_state,
         last_seen_at,
         last_delta,
         updated_at,
         hardware_id,
         boot_id,
         firmware_version,
         machine_label,
         site_id,
         provisioning_state,
         update_status,
         last_heartbeat_at,
         last_event_received_at`,
      [
        payload.deviceId,
        payload.state,
        payload.timestamp,
        delta,
        payload.hardwareId ?? null,
        payload.bootId ?? null,
        payload.firmwareVersion ?? "unknown",
      ],
    );

    const insertedEvent = await client.query<MotionEventRow>(
      `insert into motion_events (
         device_id,
         state,
         delta,
         event_timestamp,
         boot_id,
         firmware_version,
         hardware_id
       )
       values ($1, $2, $3, $4, $5, $6, $7)
       returning
         id,
         device_id,
         state,
         delta,
         event_timestamp,
         received_at,
         boot_id,
         firmware_version,
         hardware_id`,
      [
        payload.deviceId,
        payload.state,
        delta,
        payload.timestamp,
        payload.bootId ?? null,
        payload.firmwareVersion ?? "unknown",
        payload.hardwareId ?? null,
      ],
    );

    await client.query("COMMIT");

    return {
      device: mapDeviceRow(upsertedDevice.rows[0]),
      event: mapMotionEventRow(insertedEvent.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordHeartbeat(payload: HeartbeatPayload): Promise<MotionStreamPayload> {
  const result = await getDb().query<DeviceRow>(
    `insert into devices (
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       provisioning_state,
       update_status,
       last_heartbeat_at
     )
     values ($1, 'still', $2, null, now(), $3, $4, $5, 'provisioned', 'idle', now())
     on conflict (id) do update
     set last_seen_at = excluded.last_seen_at,
         updated_at = now(),
         hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
         boot_id = coalesce(excluded.boot_id, devices.boot_id),
         firmware_version = excluded.firmware_version,
         provisioning_state = case
           when devices.provisioning_state = 'unassigned' then 'provisioned'
           else devices.provisioning_state
         end,
         last_heartbeat_at = now()
     returning
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state,
       update_status,
       last_heartbeat_at,
       last_event_received_at`,
    [
      payload.deviceId,
      payload.timestamp,
      payload.hardwareId ?? null,
      payload.bootId ?? null,
      payload.firmwareVersion ?? "unknown",
    ],
  );

  return {
    device: mapDeviceRow(result.rows[0]),
  };
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const result = await getDb().query<DeviceRow>(
    `select
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state,
       update_status,
       last_heartbeat_at,
       last_event_received_at
     from devices
     order by updated_at desc, id asc`,
  );

  return result.rows.map(mapDeviceRow);
}

export async function listRecentEvents(limit = 12): Promise<MotionEventSummary[]> {
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     order by received_at desc, id desc
     limit $1`,
    [limit],
  );

  return result.rows.map(mapMotionEventRow);
}

export async function updateDeviceAssignment(
  deviceId: string,
  input: DeviceAssignmentInput,
): Promise<DeviceSummary | null> {
  const fields = [];
  const values: Array<string | null> = [deviceId];
  let index = values.length;

  if (input.machineLabel !== undefined) {
    fields.push(`machine_label = $${++index}`);
    values.push(input.machineLabel ?? null);
  }

  if (input.siteId !== undefined) {
    fields.push(`site_id = $${++index}`);
    values.push(input.siteId ?? null);
  }

  if (input.hardwareId !== undefined) {
    fields.push(`hardware_id = $${++index}`);
    values.push(input.hardwareId ?? null);
  }

  if (input.provisioningState !== undefined) {
    fields.push(`provisioning_state = $${++index}`);
    values.push(input.provisioningState);
  }

  if (fields.length === 0) {
    const existing = await getDb().query<DeviceRow>(
      `select
         id,
         last_state,
         last_seen_at,
         last_delta,
         updated_at,
         hardware_id,
         boot_id,
         firmware_version,
         machine_label,
         site_id,
         provisioning_state,
         update_status,
         last_heartbeat_at,
         last_event_received_at
       from devices
       where id = $1`,
      [deviceId],
    );

    return existing.rows[0] ? mapDeviceRow(existing.rows[0]) : null;
  }

  fields.push("updated_at = now()");
  if (input.provisioningState === "provisioned") {
    fields.push("wifi_provisioned_at = coalesce(wifi_provisioned_at, now())");
  }

  const result = await getDb().query<DeviceRow>(
    `update devices
     set ${fields.join(", ")}
     where id = $1
     returning
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state,
       update_status,
       last_heartbeat_at,
       last_event_received_at`,
    values,
  );

  return result.rows[0] ? mapDeviceRow(result.rows[0]) : null;
}

export async function createFirmwareRelease(
  input: FirmwareReleaseInput,
): Promise<FirmwareReleaseSummary> {
  const result = await getDb().query<FirmwareReleaseRow>(
    `insert into firmware_releases (
       version,
       git_sha,
       asset_url,
       sha256,
       md5,
       size_bytes,
       rollout_state
     )
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (version) do update
     set git_sha = excluded.git_sha,
         asset_url = excluded.asset_url,
         sha256 = excluded.sha256,
         md5 = excluded.md5,
         size_bytes = excluded.size_bytes,
         rollout_state = excluded.rollout_state
     returning version, git_sha, asset_url, sha256, md5, size_bytes, rollout_state, created_at`,
    [
      input.version,
      input.gitSha,
      input.assetUrl,
      input.sha256,
      input.md5 ?? null,
      input.sizeBytes,
      input.rolloutState,
    ],
  );

  return mapFirmwareReleaseRow(result.rows[0]);
}

export async function listFirmwareReleases(): Promise<FirmwareReleaseSummary[]> {
  const result = await getDb().query<FirmwareReleaseRow>(
    `select version, git_sha, asset_url, sha256, md5, size_bytes, rollout_state, created_at
     from firmware_releases
     order by created_at desc, version desc`,
  );

  return result.rows.map(mapFirmwareReleaseRow);
}

export async function checkForFirmwareUpdate(
  input: FirmwareCheckInput,
): Promise<{
  device: DeviceSummary | null;
  release: FirmwareReleaseSummary | null;
  updateAvailable: boolean;
}> {
  const [deviceResult, releaseResult] = await Promise.all([
    getDb().query<DeviceRow>(
      `select
         id,
         last_state,
         last_seen_at,
         last_delta,
         updated_at,
         hardware_id,
         boot_id,
         firmware_version,
         machine_label,
         site_id,
         provisioning_state,
         update_status,
         last_heartbeat_at,
         last_event_received_at
       from devices
       where id = $1`,
      [input.deviceId],
    ),
    getDb().query<FirmwareReleaseRow>(
      `select version, git_sha, asset_url, sha256, md5, size_bytes, rollout_state, created_at
       from firmware_releases
       where rollout_state = 'active'
       order by created_at desc
       limit 1`,
    ),
  ]);

  const device = deviceResult.rows[0] ? mapDeviceRow(deviceResult.rows[0]) : null;
  const release = releaseResult.rows[0] ? mapFirmwareReleaseRow(releaseResult.rows[0]) : null;
  const currentVersion = input.firmwareVersion ?? device?.firmwareVersion ?? null;
  const updateAvailable = Boolean(release && release.version !== currentVersion);
  let nextDevice = device;

  if (updateAvailable && device) {
    await getDb().query(
      `update devices
       set update_status = 'available',
           updated_at = now()
       where id = $1`,
      [input.deviceId],
    );

    nextDevice = {
      ...device,
      updateStatus: "available",
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    device: nextDevice,
    release,
    updateAvailable,
  };
}

export async function recordFirmwareReport(
  deviceId: string,
  status: UpdateStatus,
  targetVersion?: string,
): Promise<DeviceSummary | null> {
  const result = await getDb().query<DeviceRow>(
    `update devices
     set update_status = $2,
         firmware_version = coalesce($3, firmware_version),
         updated_at = now()
     where id = $1
     returning
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state,
       update_status,
       last_heartbeat_at,
       last_event_received_at`,
    [deviceId, status, targetVersion ?? null],
  );

  return result.rows[0] ? mapDeviceRow(result.rows[0]) : null;
}
