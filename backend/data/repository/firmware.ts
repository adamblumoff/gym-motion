import { getDb } from "../db";
import type {
  DeviceSummary,
  FirmwareReleaseInput,
  FirmwareReleaseSummary,
  UpdateStatus,
} from "../motion";
import {
  DEVICE_SELECT_COLUMNS,
  type DeviceRow,
  type FirmwareCheckInput,
  type FirmwareReleaseRow,
  mapDeviceRow,
  mapFirmwareReleaseRow,
} from "./shared";

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
         ${DEVICE_SELECT_COLUMNS}
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

  if (updateAvailable && device && release) {
    await getDb().query(
      `update devices
       set update_status = 'available',
           update_target_version = $2,
           update_detail = null,
           update_reported_at = now(),
           updated_at = now()
       where id = $1`,
      [input.deviceId, release.version],
    );

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
  const result = await getDb().query<DeviceRow>(
    `update devices
     set update_status = $2,
         firmware_version = case
           when $2 in ('applied', 'booted') and $3::text is not null then $3::text
           else firmware_version
         end,
         update_target_version = case
           when $2 = 'idle' then null
           when $3::text is not null then $3::text
           else update_target_version
         end,
         update_detail = case
           when $4::text is not null then $4::text
           when $2 in ('idle', 'available', 'downloading', 'applied', 'booted') then null
           else update_detail
         end,
         update_reported_at = now(),
         updated_at = now()
     where id = $1
     returning
       ${DEVICE_SELECT_COLUMNS}`,
    [deviceId, status, targetVersion ?? null, detail ?? null],
  );

  return result.rows[0] ? mapDeviceRow(result.rows[0]) : null;
}
