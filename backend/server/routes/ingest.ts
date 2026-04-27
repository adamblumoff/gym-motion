import type http from "node:http";

import {
  formatZodError,
  parseHeartbeatPayload,
  parseIngestPayload,
  recordHeartbeat,
  recordMotionEvent,
} from "../../data";

import { json, readJsonBody } from "../http";

type EmitApiEvent = (event: unknown) => void;

export async function handleIngestRoutes(args: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pathname: string;
  method: string;
  emit?: EmitApiEvent;
}) {
  const { request, response, pathname, method, emit = () => {} } = args;

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

  return false;
}
