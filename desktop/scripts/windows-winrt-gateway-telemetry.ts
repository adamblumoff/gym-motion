import type { TelemetryPayload } from "../../backend/runtime/gateway-runtime-server/runtime-types.js";
import type {
  GatewayDeviceContext,
  GatewayLogFn,
  GatewayRuntimeServer,
  GatewayTelemetryEvent,
} from "./windows-winrt-gateway-types.js";
import { createDeviceContext, describeNode } from "./windows-winrt-gateway-node.js";

type TelemetryHandlerDeps = {
  runtimeServer: Pick<GatewayRuntimeServer, "noteTelemetry">;
  deviceContexts: Map<string, GatewayDeviceContext>;
  emitGatewayState: () => void;
  emitRuntimeDeviceUpdated: (deviceId: string | null | undefined) => void;
  emitPersistMessage: (type: "persist-motion", deviceId: string, payload: unknown) => void;
  queueLiveDeviceTask: (deviceId: string, work: () => Promise<void>) => Promise<void>;
  log: GatewayLogFn;
  debug: GatewayLogFn;
};

type TelemetryMessagePayload = TelemetryPayload & {
  snapshot?: boolean;
};

type ParsedTelemetryEnvelope = {
  rawPayload: string | null;
  payload: TelemetryMessagePayload | null;
  payloadDeviceId: string | null;
  error: unknown;
};

function readTelemetryRawPayload(event: GatewayTelemetryEvent) {
  const rawPayload = event.payload_text ?? event.payloadText ?? null;
  return typeof rawPayload === "string" && rawPayload.length > 0 ? rawPayload : null;
}

export function parseTelemetryPayload(event: GatewayTelemetryEvent): ParsedTelemetryEnvelope {
  const rawPayload = readTelemetryRawPayload(event);

  if (!rawPayload) {
    return {
      rawPayload: null,
      payload: null,
      payloadDeviceId: null,
      error: null,
    };
  }

  try {
    const payload = JSON.parse(rawPayload);
    return {
      rawPayload,
      payload,
      payloadDeviceId: typeof payload?.deviceId === "string" ? payload.deviceId : null,
      error: null,
    };
  } catch (error) {
    return {
      rawPayload,
      payload: null,
      payloadDeviceId: null,
      error,
    };
  }
}

export function createTelemetryEventHandler({
  runtimeServer,
  deviceContexts,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  emitPersistMessage,
  queueLiveDeviceTask,
  log,
  debug,
}: TelemetryHandlerDeps) {
  async function forwardTelemetryNow(event: GatewayTelemetryEvent, payload: TelemetryMessagePayload) {
    if (!payload?.deviceId || !payload?.state || !payload?.timestamp) {
      debug("ignored telemetry payload missing required fields", payload);
      return;
    }

    const node = describeNode(event.node ?? {});
    const context = deviceContexts.get(payload.deviceId) ?? createDeviceContext(payload.deviceId);
    const previousState = context.lastState;

    context.firmwareVersion = payload.firmwareVersion ?? context.firmwareVersion ?? "unknown";
    context.bootId = payload.bootId ?? context.bootId ?? null;
    context.hardwareId = payload.hardwareId ?? context.hardwareId ?? null;
    context.peripheralId = node.peripheralId ?? context.peripheralId ?? null;
    context.address = node.address ?? context.address ?? null;
    context.advertisedName = node.localName ?? context.advertisedName ?? null;
    context.rssi = node.rssi ?? context.rssi ?? null;
    deviceContexts.set(payload.deviceId, context);

    await runtimeServer.noteTelemetry(payload, node);
    emitGatewayState();
    emitRuntimeDeviceUpdated(payload.deviceId);

    if (payload.snapshot === true) {
      context.lastState = payload.state;
      return;
    }

    if (previousState === payload.state) {
      context.lastState = payload.state;
      return;
    }

    emitPersistMessage("persist-motion", payload.deviceId, {
      deviceId: payload.deviceId,
      state: payload.state,
      timestamp: payload.timestamp,
      delta: payload.delta ?? null,
      sequence: payload.sequence,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastState = payload.state;
  }

  return function handleTelemetryEvent(event) {
    const envelope = parseTelemetryPayload(event);

    if (envelope.error) {
      log("failed to parse telemetry payload", {
        error: envelope.error instanceof Error ? envelope.error.message : String(envelope.error),
        rawPayload: envelope.rawPayload,
      });
      return;
    }

    if (!envelope.payload) {
      return;
    }

    if (!envelope.payloadDeviceId) {
      void forwardTelemetryNow(event, envelope.payload);
      return;
    }

    void queueLiveDeviceTask(envelope.payloadDeviceId, () =>
      forwardTelemetryNow(event, envelope.payload),
    );
  };
}
