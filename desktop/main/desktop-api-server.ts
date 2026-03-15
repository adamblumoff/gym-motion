import http from "node:http";

import {
  checkForFirmwareUpdate,
  createOrUpdateDeviceRegistration,
  formatZodError,
  getDeviceSyncState,
  listDeviceActivity,
  listDeviceLogs,
  listDevices,
  listRecentEvents,
  parseBackfillBatch,
  parseDeviceAssignment,
  parseDeviceLog,
  parseDeviceRegistration,
  parseFirmwareReport,
  parseHeartbeatPayload,
  parseIngestPayload,
  purgeDeviceData,
  recordBackfillBatch,
  recordDeviceLog,
  recordFirmwareReport,
  recordHeartbeat,
  recordMotionEvent,
  updateDeviceAssignment,
} from "../../backend/data";
import {
  createPresignedReadUrl,
  hasBucketConfig,
  isExternalAssetUrl,
} from "../../backend/storage-bucket";

export type DesktopDataEvent =
  | {
      type: "motion-update";
      payload: Awaited<ReturnType<typeof recordMotionEvent>>;
    }
  | {
      type: "device-log";
      payload: Awaited<ReturnType<typeof recordDeviceLog>>;
    }
  | {
      type: "device-updated";
      payload:
        | Awaited<ReturnType<typeof createOrUpdateDeviceRegistration>>
        | NonNullable<Awaited<ReturnType<typeof updateDeviceAssignment>>>
        | NonNullable<Awaited<ReturnType<typeof recordFirmwareReport>>>
        | Awaited<ReturnType<typeof recordHeartbeat>>["device"];
    }
  | {
      type: "backfill-recorded";
      payload: Awaited<ReturnType<typeof recordBackfillBatch>>;
      deviceId: string;
    };

type ServerHandle = {
  apiBaseUrl: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onEvent: (listener: (event: DesktopDataEvent) => void) => () => void;
};

function json(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function notFound(response: http.ServerResponse) {
  json(response, 404, { ok: false, error: "Not found." });
}

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createDesktopApiServer(): ServerHandle {
  const listeners = new Set<(event: DesktopDataEvent) => void>();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error("[desktop-api] request failed", error);
      json(response, 500, { ok: false, error: "Desktop API failed." });
    });
  });
  let apiBaseUrl = "http://127.0.0.1:0";

  function emit(event: DesktopDataEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", apiBaseUrl);
    const pathname = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/devices") {
      json(response, 200, { devices: await listDevices() });
      return;
    }

    if (method === "POST" && pathname === "/api/devices") {
      const payload = await readJsonBody(request);
      const parsed = parseDeviceRegistration(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const device = await createOrUpdateDeviceRegistration(parsed.data);
      emit({ type: "device-updated", payload: device });
      json(response, 200, { ok: true, device });
      return;
    }

    if (pathname.startsWith("/api/devices/")) {
      const deviceId = decodeURIComponent(pathname.replace("/api/devices/", ""));

      if (method === "PATCH") {
        const payload = await readJsonBody(request);
        const parsed = parseDeviceAssignment(payload);

        if (!parsed.success) {
          json(response, 400, { ok: false, error: formatZodError(parsed.error) });
          return;
        }

        const device = await updateDeviceAssignment(deviceId, parsed.data);

        if (!device) {
          json(response, 404, { ok: false, error: "Device not found." });
          return;
        }

        emit({ type: "device-updated", payload: device });
        json(response, 200, { ok: true, device });
        return;
      }

      if (method === "DELETE") {
        const result = await purgeDeviceData(deviceId);

        if (result.deletedDevices === 0) {
          json(response, 404, { ok: false, error: "Device not found." });
          return;
        }

        json(response, 200, { ok: true, result });
        return;
      }
    }

    if (method === "GET" && pathname === "/api/events") {
      const limit = Number(url.searchParams.get("limit") ?? "12");
      json(response, 200, { events: await listRecentEvents(limit) });
      return;
    }

    if (method === "GET" && pathname === "/api/device-logs") {
      const deviceId = url.searchParams.get("deviceId");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      json(response, 200, { logs: await listDeviceLogs({ deviceId, limit }) });
      return;
    }

    if (method === "POST" && pathname === "/api/device-logs") {
      const payload = await readJsonBody(request);
      const parsed = parseDeviceLog(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const log = await recordDeviceLog(parsed.data);
      emit({ type: "device-log", payload: log });
      json(response, 200, { ok: true, log });
      return;
    }

    if (method === "GET" && pathname === "/api/device-activity") {
      const deviceId = url.searchParams.get("deviceId");
      const limit = Number(url.searchParams.get("limit") ?? "100");

      if (!deviceId) {
        json(response, 400, { ok: false, error: "deviceId is required." });
        return;
      }

      json(response, 200, { activities: await listDeviceActivity({ deviceId, limit }) });
      return;
    }

    if (method === "POST" && pathname === "/api/ingest") {
      const payload = await readJsonBody(request);
      const parsed = parseIngestPayload(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const motionUpdate = await recordMotionEvent(parsed.data);
      emit({ type: "motion-update", payload: motionUpdate });
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/heartbeat") {
      const payload = await readJsonBody(request);
      const parsed = parseHeartbeatPayload(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const deviceUpdate = await recordHeartbeat(parsed.data);
      emit({ type: "device-updated", payload: deviceUpdate.device });
      json(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/device-sync/")) {
      const deviceId = decodeURIComponent(pathname.replace("/api/device-sync/", ""));
      json(response, 200, { ok: true, syncState: await getDeviceSyncState(deviceId) });
      return;
    }

    if (method === "POST" && pathname === "/api/device-backfill") {
      const payload = await readJsonBody(request);
      const parsed = parseBackfillBatch(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const result = await recordBackfillBatch(parsed.data);
      emit({
        type: "backfill-recorded",
        payload: result,
        deviceId: parsed.data.deviceId,
      });
      json(response, 200, { ok: true, ...result });
      return;
    }

    if (method === "GET" && pathname === "/api/firmware/check") {
      const deviceId = url.searchParams.get("deviceId");
      const firmwareVersion = url.searchParams.get("firmwareVersion");

      if (!deviceId) {
        json(response, 400, { ok: false, error: "deviceId is required." });
        return;
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
      return;
    }

    if (method === "POST" && pathname === "/api/firmware/report") {
      const payload = await readJsonBody(request);
      const parsed = parseFirmwareReport(payload);

      if (!parsed.success) {
        json(response, 400, { ok: false, error: formatZodError(parsed.error) });
        return;
      }

      const device = await recordFirmwareReport(
        parsed.data.deviceId,
        parsed.data.status,
        parsed.data.targetVersion,
        parsed.data.detail,
      );

      if (!device) {
        json(response, 404, { ok: false, error: "Device not found." });
        return;
      }

      emit({ type: "device-updated", payload: device });
      json(response, 200, { ok: true, device });
      return;
    }

    notFound(response);
  }

  return {
    get apiBaseUrl() {
      return apiBaseUrl;
    },
    async start() {
      if (server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Desktop API failed to bind to a local port.");
      }

      apiBaseUrl = `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
