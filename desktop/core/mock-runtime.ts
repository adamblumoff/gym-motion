import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type {
  DesktopEnvironment,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MotionEventSummary,
  MotionState,
} from "./contracts";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
} from "./contracts";

type RuntimeHandle = {
  start: () => void;
  stop: () => void;
  getSnapshot: () => DesktopSnapshot;
  setEnvironment: (environment: DesktopEnvironment) => DesktopSnapshot;
  triggerDemoBurst: () => void;
  onUpdated: (listener: (snapshot: DesktopSnapshot) => void) => () => void;
};

function nowIso() {
  return new Date().toISOString();
}

function createGateway(sessionId: string): GatewayStatusSummary {
  return {
    hostname: "gym-motion-desktop",
    mode: "desktop-mock-gateway",
    sessionId,
    adapterState: "poweredOn",
    scanState: "scanning",
    connectedNodeCount: 2,
    reconnectingNodeCount: 0,
    knownNodeCount: 3,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastAdvertisementAt: nowIso(),
  };
}

function createDevice(
  id: string,
  machineLabel: string,
  siteId: string,
  state: MotionState,
  gatewayConnectionState: GatewayRuntimeDeviceSummary["gatewayConnectionState"],
  lastRssi: number,
): GatewayRuntimeDeviceSummary {
  const updatedAt = nowIso();

  return {
    id,
    lastState: state,
    lastSeenAt: Date.now(),
    lastDelta: state === "moving" ? 18 : 0,
    updatedAt,
    hardwareId: `${id}-hw`,
    bootId: `${id}-boot`,
    firmwareVersion: "0.8.0-desktop-preview",
    machineLabel,
    siteId,
    provisioningState: "provisioned",
    updateStatus: "idle",
    updateTargetVersion: null,
    updateDetail: null,
    updateUpdatedAt: null,
    lastHeartbeatAt: updatedAt,
    lastEventReceivedAt: updatedAt,
    healthStatus: "online",
    gatewayConnectionState,
    peripheralId: `${id}-peripheral`,
    gatewayLastAdvertisementAt: updatedAt,
    gatewayLastConnectedAt: updatedAt,
    gatewayLastDisconnectedAt: null,
    gatewayLastTelemetryAt: updatedAt,
    gatewayDisconnectReason: null,
    advertisedName: `GymMotion-${id}`,
    lastRssi,
    otaStatus: "idle",
    otaTargetVersion: null,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: null,
    otaLastStatusMessage: null,
    otaUpdatedAt: updatedAt,
  };
}

function createMotionEvent(device: GatewayRuntimeDeviceSummary, id: number): MotionEventSummary {
  return {
    id,
    deviceId: device.id,
    sequence: id,
    state: device.lastState,
    delta: device.lastDelta,
    eventTimestamp: Date.now(),
    receivedAt: nowIso(),
    bootId: device.bootId,
    firmwareVersion: device.firmwareVersion,
    hardwareId: device.hardwareId,
  };
}

function createActivityFromEvent(event: MotionEventSummary): DeviceActivitySummary {
  return {
    id: `motion-${event.id}`,
    deviceId: event.deviceId,
    sequence: event.sequence,
    kind: "motion",
    title: event.state.toUpperCase(),
    message: `Gateway recorded ${event.state} for ${event.deviceId}.`,
    state: event.state,
    level: null,
    code: "motion.state",
    delta: event.delta,
    eventTimestamp: event.eventTimestamp,
    receivedAt: event.receivedAt,
    bootId: event.bootId,
    firmwareVersion: event.firmwareVersion,
    hardwareId: event.hardwareId,
    metadata: event.delta === null ? null : { delta: event.delta },
  };
}

function createLog(device: GatewayRuntimeDeviceSummary, id: number, message: string): DeviceLogSummary {
  return {
    id,
    deviceId: device.id,
    sequence: id,
    level: "info",
    code: "gateway.mock",
    message,
    bootId: device.bootId,
    firmwareVersion: device.firmwareVersion,
    hardwareId: device.hardwareId,
    deviceTimestamp: Date.now(),
    metadata: {
      source: "mock-runtime",
      session: "desktop-preview",
    },
    receivedAt: nowIso(),
  };
}

function createActivityFromLog(log: DeviceLogSummary): DeviceActivitySummary {
  return {
    id: `log-${log.id}`,
    deviceId: log.deviceId,
    sequence: log.sequence,
    kind: "lifecycle",
    title: log.code,
    message: log.message,
    state: null,
    level: log.level,
    code: log.code,
    delta: null,
    eventTimestamp: log.deviceTimestamp,
    receivedAt: log.receivedAt,
    bootId: log.bootId,
    firmwareVersion: log.firmwareVersion,
    hardwareId: log.hardwareId,
    metadata: log.metadata,
  };
}

export function createMockRuntime(): RuntimeHandle {
  const emitter = new EventEmitter();
  const sessionId = randomUUID();
  const gateway = createGateway(sessionId);
  let environment: DesktopEnvironment = "local";
  let nextId = 100;
  let devices = [
    createDevice("stack-001", "Leg Press 2", "Dallas", "moving", "connected", -58),
    createDevice("stack-002", "Lat Pulldown 1", "Dallas", "still", "connected", -63),
    createDevice("stack-003", "Chest Press 4", "Austin", "still", "reconnecting", -74),
  ];
  let events = devices.slice(0, 2).map((device, index) => createMotionEvent(device, nextId + index));
  nextId += events.length;
  let logs = devices.slice(0, 2).map((device, index) =>
    createLog(device, nextId + index, `Desktop preview restored ${device.machineLabel}.`),
  );
  nextId += logs.length;
  let activities = [
    ...events.map(createActivityFromEvent),
    ...logs.map(createActivityFromLog),
  ].toSorted((left, right) => new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime());

  let timer: NodeJS.Timeout | null = null;

  function snapshot(): DesktopSnapshot {
    gateway.updatedAt = nowIso();
    gateway.lastAdvertisementAt = nowIso();
    gateway.connectedNodeCount = devices.filter((item) => item.gatewayConnectionState === "connected").length;
    gateway.reconnectingNodeCount = devices.filter(
      (item) => item.gatewayConnectionState === "reconnecting",
    ).length;
    gateway.knownNodeCount = devices.length;

    return {
      environment,
      liveStatus: environment === "local" ? "Gateway live" : "Production data mirror",
      trayHint: "Closing the window keeps the gateway alive in the tray.",
      gateway: { ...gateway },
      devices: [...devices],
      events: [...events],
      logs: [...logs],
      activities: [...activities],
    };
  }

  function emitUpdated() {
    emitter.emit("updated", snapshot());
  }

  function pushDemoUpdate() {
    const current = devices[0];
    const nextState: MotionState = current.lastState === "moving" ? "still" : "moving";
    const updatedAt = nowIso();
    const updatedDevice: GatewayRuntimeDeviceSummary = {
      ...current,
      lastState: nextState,
      lastDelta: nextState === "moving" ? 22 : 1,
      lastSeenAt: Date.now(),
      updatedAt,
      lastHeartbeatAt: updatedAt,
      lastEventReceivedAt: updatedAt,
      gatewayLastTelemetryAt: updatedAt,
      gatewayLastAdvertisementAt: updatedAt,
      healthStatus: "online",
      lastRssi: current.lastRssi === null ? -60 : current.lastRssi + 1,
    };

    devices = mergeGatewayDeviceUpdate(devices, updatedDevice);

    const event = createMotionEvent(updatedDevice, nextId++);
    events = mergeEventUpdate(events, event, 12);
    activities = mergeActivityUpdate(activities, createActivityFromEvent(event), 24);

    const log = createLog(
      updatedDevice,
      nextId++,
      nextState === "moving"
        ? `${updatedDevice.machineLabel} started moving in mock desktop runtime.`
        : `${updatedDevice.machineLabel} settled back to still.`,
    );
    logs = mergeLogUpdate(logs, log, 12);
    activities = mergeActivityUpdate(activities, createActivityFromLog(log), 24);

    emitUpdated();
  }

  return {
    start() {
      if (timer) {
        return;
      }

      timer = setInterval(pushDemoUpdate, 5000);
    },
    stop() {
      if (!timer) {
        return;
      }

      clearInterval(timer);
      timer = null;
    },
    getSnapshot() {
      return snapshot();
    },
    setEnvironment(nextEnvironment) {
      environment = nextEnvironment;
      emitUpdated();
      return snapshot();
    },
    triggerDemoBurst() {
      pushDemoUpdate();
    },
    onUpdated(listener) {
      emitter.on("updated", listener);
      return () => {
        emitter.off("updated", listener);
      };
    },
  };
}
