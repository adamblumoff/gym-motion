import { Readable } from "node:stream";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataMocks = vi.hoisted(() => ({
  formatZodError: vi.fn(() => "Invalid payload."),
  parseHeartbeatPayload: vi.fn((payload: unknown) => ({ success: true, data: payload })),
  parseIngestPayload: vi.fn((payload: unknown) => ({ success: true, data: payload })),
  recordHeartbeat: vi.fn(),
  recordMotionEvent: vi.fn(),
}));

vi.mock("../../data", () => dataMocks);

import { handleIngestRoutes } from "./ingest";

type JsonResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
};

function createJsonRequest(payload: unknown) {
  return Readable.from([JSON.stringify(payload)]) as http.IncomingMessage;
}

function createJsonResponse() {
  const response = {
    body: "",
    headers: {},
    statusCode: 0,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body: string) {
      this.body = body;
      return this;
    },
  };

  return response as JsonResponse;
}

async function callIngestRoute(args: {
  pathname: string;
  payload: unknown;
  emit?: (event: unknown) => void;
}) {
  const response = createJsonResponse();
  const handled = await handleIngestRoutes({
    request: createJsonRequest(args.payload),
    response,
    pathname: args.pathname,
    method: "POST",
    emit: args.emit,
  });

  return {
    handled,
    response,
    body: JSON.parse(response.body) as unknown,
  };
}

describe("handleIngestRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dataMocks.formatZodError.mockReturnValue("Invalid payload.");
    dataMocks.parseHeartbeatPayload.mockImplementation((payload: unknown) => ({
      success: true,
      data: payload,
    }));
    dataMocks.parseIngestPayload.mockImplementation((payload: unknown) => ({
      success: true,
      data: payload,
    }));
  });

  it("records motion ingest payloads and emits a motion update", async () => {
    const payload = {
      deviceId: "stack-001",
      gatewayId: "zone-a",
      state: "moving",
      timestamp: 1000,
    };
    const motionUpdate = {
      device: { id: "stack-001" },
      event: { id: 10, deviceId: "stack-001" },
    };
    const emit = vi.fn();
    dataMocks.recordMotionEvent.mockResolvedValue(motionUpdate);

    const result = await callIngestRoute({
      pathname: "/api/ingest",
      payload,
      emit,
    });

    expect(result.handled).toBe(true);
    expect(result.response.statusCode).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(dataMocks.recordMotionEvent).toHaveBeenCalledWith(payload);
    expect(emit).toHaveBeenCalledWith({ type: "motion-update", payload: motionUpdate });
  });

  it("records heartbeat payloads and emits a device update", async () => {
    const payload = {
      deviceId: "stack-001",
      gatewayId: "zone-a",
      timestamp: 1000,
    };
    const heartbeatUpdate = {
      device: { id: "stack-001" },
    };
    const emit = vi.fn();
    dataMocks.recordHeartbeat.mockResolvedValue(heartbeatUpdate);

    const result = await callIngestRoute({
      pathname: "/api/heartbeat",
      payload,
      emit,
    });

    expect(result.handled).toBe(true);
    expect(result.response.statusCode).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(dataMocks.recordHeartbeat).toHaveBeenCalledWith(payload);
    expect(emit).toHaveBeenCalledWith({ type: "device-updated", payload: heartbeatUpdate.device });
  });

  it("rejects invalid ingest payloads without recording or emitting", async () => {
    const emit = vi.fn();
    dataMocks.parseIngestPayload.mockReturnValue({
      success: false,
      error: new Error("bad payload"),
    });

    const result = await callIngestRoute({
      pathname: "/api/ingest",
      payload: {},
      emit,
    });

    expect(result.response.statusCode).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Invalid payload." });
    expect(dataMocks.recordMotionEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
