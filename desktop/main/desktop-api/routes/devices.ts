import http from "node:http";

import {
  createOrUpdateDeviceRegistration,
  formatZodError,
  getDeviceSyncState,
  listDeviceActivity,
  listDeviceLogs,
  listDevices,
  parseBackfillBatch,
  parseDeviceAssignment,
  parseDeviceLog,
  parseDeviceRegistration,
  parseHeartbeatPayload,
  parseIngestPayload,
  purgeDeviceData,
  recordBackfillBatch,
  recordDeviceLog,
  recordHeartbeat,
  recordMotionEvent,
  updateDeviceAssignment,
} from "../../../../backend/data";

import { json, readJsonBody } from "../http";

export async function handleDeviceRoutes(args: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  emit: (event: unknown) => void;
}) {
  const { request, response, pathname, method, url, emit } = args;

  if (method === "GET" && pathname === "/api/devices") {
    json(response, 200, { devices: await listDevices() });
    return true;
  }

  if (method === "POST" && pathname === "/api/devices") {
    const payload = await readJsonBody(request);
    const parsed = parseDeviceRegistration(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const device = await createOrUpdateDeviceRegistration(parsed.data);
    emit({ type: "device-updated", payload: device });
    json(response, 200, { ok: true, device });
    return true;
  }

  if (pathname.startsWith("/api/devices/")) {
    const deviceId = decodeURIComponent(pathname.replace("/api/devices/", ""));

    if (method === "PATCH") {
      const payload = await readJsonBody(request);
      const parsed = parseDeviceAssignment(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return true;
      }

      const device = await updateDeviceAssignment(deviceId, parsed.data);

      if (!device) {
        json(response, 404, { ok: false, error: "Device not found." });
        return true;
      }

      emit({ type: "device-updated", payload: device });
      json(response, 200, { ok: true, device });
      return true;
    }

    if (method === "DELETE") {
      const result = await purgeDeviceData(deviceId);

      if (result.deletedDevices === 0) {
        json(response, 404, { ok: false, error: "Device not found." });
        return true;
      }

      json(response, 200, { ok: true, result });
      return true;
    }
  }

  if (method === "GET" && pathname === "/api/device-logs") {
    const deviceId = url.searchParams.get("deviceId");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    json(response, 200, { logs: await listDeviceLogs({ deviceId, limit }) });
    return true;
  }

  if (method === "POST" && pathname === "/api/device-logs") {
    const payload = await readJsonBody(request);
    const parsed = parseDeviceLog(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const log = await recordDeviceLog(parsed.data);
    emit({ type: "device-log", payload: log });
    json(response, 200, { ok: true, log });
    return true;
  }

  if (method === "GET" && pathname === "/api/device-activity") {
    const deviceId = url.searchParams.get("deviceId");
    const limit = Number(url.searchParams.get("limit") ?? "100");

    if (!deviceId) {
      json(response, 400, { ok: false, error: "deviceId is required." });
      return true;
    }

    json(response, 200, { activities: await listDeviceActivity({ deviceId, limit }) });
    return true;
  }

  if (method === "POST" && pathname === "/api/ingest") {
    const payload = await readJsonBody(request);
    const parsed = parseIngestPayload(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const motionUpdate = await recordMotionEvent(parsed.data);
    emit({ type: "motion-update", payload: motionUpdate });
    json(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/heartbeat") {
    const payload = await readJsonBody(request);
    const parsed = parseHeartbeatPayload(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const deviceUpdate = await recordHeartbeat(parsed.data);
    emit({ type: "device-updated", payload: deviceUpdate.device });
    json(response, 200, { ok: true });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/device-sync/")) {
    const deviceId = decodeURIComponent(pathname.replace("/api/device-sync/", ""));
    json(response, 200, { ok: true, syncState: await getDeviceSyncState(deviceId) });
    return true;
  }

  if (method === "POST" && pathname === "/api/device-backfill") {
    const payload = await readJsonBody(request);
    const parsed = parseBackfillBatch(payload);

    if (!parsed.success) {
      json(response, 400, { ok: false, error: formatZodError(parsed.error) });
      return true;
    }

    const result = await recordBackfillBatch(parsed.data);
    emit({
      type: "backfill-recorded",
      payload: result,
      deviceId: parsed.data.deviceId,
    });
    json(response, 200, { ok: true, ...result });
    return true;
  }

  return false;
}
