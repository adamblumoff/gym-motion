import http from "node:http";

import {
  checkForFirmwareUpdate,
  formatZodError,
  parseFirmwareReport,
  recordFirmwareReport,
} from "../../data";
import {
  createPresignedReadUrl,
  hasBucketConfig,
  isExternalAssetUrl,
} from "../../storage-bucket";

import { json, readJsonBody } from "../http";

type EmitApiEvent = (event: unknown) => void;

export async function handleFirmwareRoutes(args: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  emit?: EmitApiEvent;
}) {
  const { request, response, pathname, method, url, emit = () => {} } = args;

  if (method === "GET" && pathname === "/api/firmware/check") {
    const deviceId = url.searchParams.get("deviceId");
    const firmwareVersion = url.searchParams.get("firmwareVersion");

    if (!deviceId) {
      json(response, 400, { ok: false, error: "deviceId is required." });
      return true;
    }

    const result = await checkForFirmwareUpdate({ deviceId, firmwareVersion });
    const resolvedAssetUrl =
      result.release && hasBucketConfig() && !isExternalAssetUrl(result.release.assetUrl)
        ? await createPresignedReadUrl(result.release.assetUrl)
        : result.release?.assetUrl ?? null;

    json(response, 200, {
      ok: true,
      updateAvailable: result.updateAvailable,
      device: result.device,
      version: result.release?.version ?? null,
      assetUrl: resolvedAssetUrl,
      sha256: result.release?.sha256 ?? null,
      md5: result.release?.md5 ?? null,
      sizeBytes: result.release?.sizeBytes ?? null,
      rolloutState: result.release?.rolloutState ?? null,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/firmware/report") {
    const payload = await readJsonBody(request);
    const parsed = parseFirmwareReport(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const device = await recordFirmwareReport(
      parsed.data.deviceId,
      parsed.data.status,
      parsed.data.targetVersion,
      parsed.data.detail,
    );

    if (!device) {
      json(response, 404, { ok: false, error: "Device not found." });
      return true;
    }

    emit({ type: "device-updated", payload: device });
    json(response, 200, { ok: true, device });
    return true;
  }

  return false;
}
