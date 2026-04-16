import { desc, eq, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db";
import type {
  DeviceSummary,
  FirmwareReleaseInput,
  FirmwareReleaseSummary,
  UpdateStatus,
} from "../motion";
import { devices, firmwareReleases } from "../schema";
import {
  type FirmwareCheckInput,
  mapDeviceRecord,
  mapFirmwareReleaseRecord,
} from "./shared";

export async function createFirmwareRelease(
  input: FirmwareReleaseInput,
): Promise<FirmwareReleaseSummary> {
  const [record] = await getDrizzleDb()
    .insert(firmwareReleases)
    .values({
      version: input.version,
      gitSha: input.gitSha,
      assetUrl: input.assetUrl,
      sha256: input.sha256,
      md5: input.md5 ?? null,
      sizeBytes: input.sizeBytes,
      rolloutState: input.rolloutState,
    })
    .onConflictDoUpdate({
      target: firmwareReleases.version,
      set: {
        gitSha: sql`excluded.git_sha`,
        assetUrl: sql`excluded.asset_url`,
        sha256: sql`excluded.sha256`,
        md5: sql`excluded.md5`,
        sizeBytes: sql`excluded.size_bytes`,
        rolloutState: sql`excluded.rollout_state`,
      },
    })
    .returning();

  return mapFirmwareReleaseRecord(record);
}

export async function listFirmwareReleases(): Promise<FirmwareReleaseSummary[]> {
  const records = await getDrizzleDb().query.firmwareReleases.findMany({
    orderBy: [desc(firmwareReleases.createdAt), desc(firmwareReleases.version)],
  });

  return records.map(mapFirmwareReleaseRecord);
}

export async function checkForFirmwareUpdate(
  input: FirmwareCheckInput,
): Promise<{
  device: DeviceSummary | null;
  release: FirmwareReleaseSummary | null;
  updateAvailable: boolean;
}> {
  const [deviceRecord, releaseRecord] = await Promise.all([
    getDrizzleDb().query.devices.findFirst({
      where: eq(devices.id, input.deviceId),
    }),
    getDrizzleDb().query.firmwareReleases.findFirst({
      where: eq(firmwareReleases.rolloutState, "active"),
      orderBy: [desc(firmwareReleases.createdAt)],
    }),
  ]);

  const device = deviceRecord ? mapDeviceRecord(deviceRecord) : null;
  const release = releaseRecord ? mapFirmwareReleaseRecord(releaseRecord) : null;
  const currentVersion = input.firmwareVersion ?? device?.firmwareVersion ?? null;
  const updateAvailable = Boolean(release && release.version !== currentVersion);
  let nextDevice = device;

  if (updateAvailable && device && release) {
    await getDrizzleDb()
      .update(devices)
      .set({
        updateStatus: "available",
        updateTargetVersion: release.version,
        updateDetail: null,
        updateReportedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(devices.id, input.deviceId));

    const updatedAt = new Date().toISOString();
    nextDevice = {
      ...device,
      updateStatus: "available",
      updateTargetVersion: release.version,
      updateDetail: null,
      updateUpdatedAt: updatedAt,
      updatedAt,
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
  detail?: string,
): Promise<DeviceSummary | null> {
  const [record] = await getDrizzleDb()
    .update(devices)
    .set({
      updateStatus: status,
      firmwareVersion:
        status === "applied" || status === "booted"
          ? sql`coalesce(${targetVersion ?? null}, ${devices.firmwareVersion})`
          : sql`${devices.firmwareVersion}`,
      updateTargetVersion:
        status === "idle"
          ? null
          : targetVersion !== undefined && targetVersion !== null
            ? targetVersion
            : sql`${devices.updateTargetVersion}`,
      updateDetail:
        detail !== undefined && detail !== null
          ? detail
          : ["idle", "available", "downloading", "applied", "booted"].includes(status)
            ? null
            : sql`${devices.updateDetail}`,
      updateReportedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(devices.id, deviceId))
    .returning();

  return record ? mapDeviceRecord(record) : null;
}
