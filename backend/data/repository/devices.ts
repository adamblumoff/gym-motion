import { getDb } from "../db";
import type {
  DeviceAssignmentInput,
  DeviceCleanupResult,
  DeviceRegistrationInput,
  DeviceSummary,
} from "../motion";
import { DEVICE_SELECT_COLUMNS, type DeviceRow, mapDeviceRow } from "./shared";

export async function createOrUpdateDeviceRegistration(
  input: DeviceRegistrationInput,
): Promise<DeviceSummary> {
  const result = await getDb().query<DeviceRow>(
    `insert into devices (
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state
     )
     values ($1, 'still', 0, null, now(), $2, 'unknown', $3, $4, $5)
     on conflict (id) do update
     set updated_at = now(),
         hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
         machine_label = coalesce(excluded.machine_label, devices.machine_label),
         site_id = coalesce(excluded.site_id, devices.site_id),
         provisioning_state = excluded.provisioning_state
     returning
       ${DEVICE_SELECT_COLUMNS}`,
    [
      input.deviceId,
      input.hardwareId ?? null,
      input.machineLabel ?? null,
      input.siteId ?? null,
      input.provisioningState,
    ],
  );

  return mapDeviceRow(result.rows[0]);
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
         ${DEVICE_SELECT_COLUMNS}
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
       ${DEVICE_SELECT_COLUMNS}`,
    values,
  );

  return result.rows[0] ? mapDeviceRow(result.rows[0]) : null;
}

export async function purgeDeviceData(deviceId: string): Promise<DeviceCleanupResult> {
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    const deletedEvents = await client.query<{ count: string }>(
      `delete from motion_events
       where device_id = $1
       returning 1 as count`,
      [deviceId],
    );

    await client.query(
      `delete from device_logs
       where device_id = $1`,
      [deviceId],
    );

    const deletedDevices = await client.query<{ count: string }>(
      `delete from devices
       where id = $1
       returning 1 as count`,
      [deviceId],
    );

    await client.query("COMMIT");

    return {
      deviceId,
      deletedEvents: deletedEvents.rowCount ?? 0,
      deletedDevices: deletedDevices.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
