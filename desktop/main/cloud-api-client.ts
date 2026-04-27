import type {
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceAnalyticsSnapshot,
  DeviceLogSummary,
  DeviceSummary,
  GetDeviceAnalyticsInput,
  MotionEventSummary,
} from "@core/contracts";

const REQUEST_TIMEOUT_MS = 10_000;

export type DevicesResponse = {
  devices: DeviceSummary[];
};
type EventsResponse = {
  events: DesktopSnapshot["events"];
};
type ActivityResponse = {
  activities: DeviceActivitySummary[];
};
type DeviceAnalyticsResponse = {
  analytics: DeviceAnalyticsSnapshot;
};

export type ApiInvalidateEvent = {
  type?: string;
  payload?: unknown;
};

export type MotionUpdatePayload = {
  device: DeviceSummary;
  event?: MotionEventSummary;
};

async function fetchCloudJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-store",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

function parseInvalidateEvent(lines: string[]) {
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as ApiInvalidateEvent;
  } catch {
    return null;
  }
}

export function analyticsAffectedDeviceIds(event: ApiInvalidateEvent | null) {
  if (!event) {
    return [];
  }

  const deviceIds = new Set<string>();
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  const nestedDevice =
    payload?.device && typeof payload.device === "object"
      ? (payload.device as Record<string, unknown>)
      : null;
  const payloadDeviceId = payload?.deviceId;
  const nestedDeviceId = nestedDevice?.id;

  if (typeof payloadDeviceId === "string" && payloadDeviceId.length > 0) {
    deviceIds.add(payloadDeviceId);
  }

  if (typeof nestedDeviceId === "string" && nestedDeviceId.length > 0) {
    deviceIds.add(nestedDeviceId);
  }

  return [...deviceIds];
}

async function readEventStream(args: {
  baseUrl: string;
  signal: AbortSignal;
  onInvalidate: (event: ApiInvalidateEvent | null) => void;
}) {
  const response = await fetch(new URL("/api/stream", args.baseUrl), {
    cache: "no-store",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
    },
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(`/api/stream -> ${response.status}`);
  }

  if (!response.body) {
    throw new Error("/api/stream did not provide a response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!args.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
      const boundary = normalizedBuffer.indexOf("\n\n");
      if (boundary < 0) {
        buffer = normalizedBuffer;
        break;
      }

      const rawEvent = normalizedBuffer.slice(0, boundary);
      buffer = normalizedBuffer.slice(boundary + 2);
      const lines = rawEvent
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const eventType =
        lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ??
        "message";

      if (eventType === "invalidate") {
        args.onInvalidate(parseInvalidateEvent(lines));
      }
    }
  }
}

export function createCloudApiClient(baseUrl: string) {
  return {
    getDevices: () => fetchCloudJson<DevicesResponse>(baseUrl, "/api/devices"),
    getEvents: () => fetchCloudJson<EventsResponse>(baseUrl, "/api/events?limit=14"),
    getActivity: () => fetchCloudJson<ActivityResponse>(baseUrl, "/api/activity?limit=30"),
    getDeviceAnalytics: (input: GetDeviceAnalyticsInput) =>
      fetchCloudJson<DeviceAnalyticsResponse>(
        baseUrl,
        `/api/device-analytics?deviceId=${encodeURIComponent(input.deviceId)}&window=${encodeURIComponent(
          input.window,
        )}`,
      ),
    getDeviceActivity: (deviceId: string, limit?: number) =>
      fetchCloudJson<ActivityResponse>(
        baseUrl,
        `/api/device-activity?deviceId=${encodeURIComponent(deviceId)}&limit=${limit ?? 60}`,
      ),
    readEventStream: (signal: AbortSignal, onInvalidate: (event: ApiInvalidateEvent | null) => void) =>
      readEventStream({ baseUrl, signal, onInvalidate }),
  };
}

export function isDeviceSummary(value: unknown): value is DeviceSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as DeviceSummary).id === "string" &&
      typeof (value as DeviceSummary).updatedAt === "string" &&
      typeof (value as DeviceSummary).healthStatus === "string",
  );
}

function isMotionEventSummary(value: unknown): value is MotionEventSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as MotionEventSummary).id === "number" &&
      typeof (value as MotionEventSummary).deviceId === "string" &&
      typeof (value as MotionEventSummary).receivedAt === "string",
  );
}

export function isDeviceLogSummary(value: unknown): value is DeviceLogSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as DeviceLogSummary).id === "number" &&
      typeof (value as DeviceLogSummary).deviceId === "string" &&
      typeof (value as DeviceLogSummary).receivedAt === "string",
  );
}

export function isMotionUpdatePayload(value: unknown): value is MotionUpdatePayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<MotionUpdatePayload>;
  return isDeviceSummary(payload.device) && (
    payload.event === undefined || isMotionEventSummary(payload.event)
  );
}
