import { eq, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db";
import type {
  DeviceAssignmentInput,
  DeviceCleanupResult,
  DeviceRegistrationInput,
  DeviceSummary,
} from "../motion";
import { deviceLogs, devices, motionEvents } from "../schema";
import { mapDeviceRecord } from "./shared";

export async function createOrUpdateDeviceRegistration(
  input: DeviceRegistrationInput,
): Promise<DeviceSummary> {
  const [record] = await getDrizzleDb()
    .insert(devices)
    .values({
      id: input.deviceId,
      lastState: "still",
      lastSeenAt: 0,
      lastDelta: null,
      hardwareId: input.hardwareId ?? null,
      firmwareVersion: "unknown",
      machineLabel: input.machineLabel ?? null,
      siteId: input.siteId ?? null,
      provisioningState: input.provisioningState,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        updatedAt: new Date(),
        hardwareId: sql`coalesce(excluded.hardware_id, ${devices.hardwareId})`,
        machineLabel: sql`coalesce(excluded.machine_label, ${devices.machineLabel})`,
        siteId: sql`coalesce(excluded.site_id, ${devices.siteId})`,
        provisioningState: sql`excluded.provisioning_state`,
      },
    })
    .returning();

  return mapDeviceRecord(record);
}

export async function updateDeviceAssignment(
  deviceId: string,
  input: DeviceAssignmentInput,
): Promise<DeviceSummary | null> {
  if (
    input.machineLabel === undefined &&
    input.siteId === undefined &&
    input.hardwareId === undefined &&
    input.provisioningState === undefined
  ) {
    const existing = await getDrizzleDb().query.devices.findFirst({
      where: eq(devices.id, deviceId),
    });

    return existing ? mapDeviceRecord(existing) : null;
  }

  const updatePatch: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.machineLabel !== undefined) {
    updatePatch.machineLabel = input.machineLabel ?? null;
  }

  if (input.siteId !== undefined) {
    updatePatch.siteId = input.siteId ?? null;
  }

  if (input.hardwareId !== undefined) {
    updatePatch.hardwareId = input.hardwareId ?? null;
  }

  if (input.provisioningState !== undefined) {
    updatePatch.provisioningState = input.provisioningState;
  }

  if (input.provisioningState === "provisioned") {
    updatePatch.wifiProvisionedAt = sql`coalesce(${devices.wifiProvisionedAt}, now())`;
  }

  const [record] = await getDrizzleDb()
    .update(devices)
    .set(updatePatch as any)
    .where(eq(devices.id, deviceId))
    .returning();

  return record ? mapDeviceRecord(record) : null;
}

export async function getDevice(deviceId: string): Promise<DeviceSummary | null> {
  const record = await getDrizzleDb().query.devices.findFirst({
    where: eq(devices.id, deviceId),
  });

  return record ? mapDeviceRecord(record) : null;
}

export async function purgeDeviceData(deviceId: string): Promise<DeviceCleanupResult> {
  return getDrizzleDb().transaction(async (tx) => {
    const deletedEvents = await tx
      .delete(motionEvents)
      .where(eq(motionEvents.deviceId, deviceId))
      .returning({ count: sql<number>`1` });

    await tx.delete(deviceLogs).where(eq(deviceLogs.deviceId, deviceId));

    const deletedDevices = await tx
      .delete(devices)
      .where(eq(devices.id, deviceId))
      .returning({ count: sql<number>`1` });

    return {
      deviceId,
      deletedEvents: deletedEvents.length,
      deletedDevices: deletedDevices.length,
    };
  });
}
