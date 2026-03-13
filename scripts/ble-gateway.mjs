import crypto from "node:crypto";
import process from "node:process";

import noble from "@abandonware/noble";

const SERVICE_UUID = normalizeUuid(
  process.env.BLE_RUNTIME_SERVICE_UUID ??
    "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001",
);
const TELEMETRY_UUID = normalizeUuid(
  process.env.BLE_TELEMETRY_UUID ?? "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002",
);
const CONTROL_UUID = normalizeUuid(
  process.env.BLE_CONTROL_UUID ?? "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003",
);
const STATUS_UUID = normalizeUuid(
  process.env.BLE_STATUS_UUID ?? "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004",
);
const OTA_DATA_UUID = normalizeUuid(
  process.env.BLE_OTA_DATA_UUID ?? "4b2f41d1-6f1b-4d3a-92e5-7db4891f7005",
);

const config = {
  apiBaseUrl: (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  deviceNamePrefix: process.env.BLE_DEVICE_NAME_PREFIX ?? "GymMotion-",
  verbose: process.env.GATEWAY_VERBOSE === "1",
  heartbeatMinIntervalMs: Number(process.env.GATEWAY_HEARTBEAT_DEDUPE_MS ?? 10_000),
  firmwareCheckIntervalMs: Number(process.env.GATEWAY_FIRMWARE_CHECK_MS ?? 60_000),
  otaChunkSize: Number(process.env.GATEWAY_OTA_CHUNK_SIZE ?? 128),
};

const peripherals = new Map();
const deviceContexts = new Map();
let scanningStarted = false;

const CONNECT_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 8_000;

function normalizeUuid(value) {
  return value.replaceAll("-", "").toLowerCase();
}

function log(message, details) {
  if (details !== undefined) {
    console.log(`[gateway] ${message}`, details);
    return;
  }

  console.log(`[gateway] ${message}`);
}

function debug(message, details) {
  if (!config.verbose) {
    return;
  }

  log(message, details);
}

function wrapCallback(fn) {
  return new Promise((resolve, reject) => {
    fn((error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

async function withTimeout(label, timeoutMs, promise) {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function startScanning(serviceUuids, allowDuplicates) {
  log(
    `starting BLE scan for service ${serviceUuids.join(",")} (allowDuplicates=${allowDuplicates})`,
  );

  await new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      noble.removeListener("scanStart", handleScanStart);
      noble.removeListener("warning", handleWarning);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const handleScanStart = () => {
      debug("scanStart event received");
      finish();
    };

    const handleWarning = (message) => {
      if (!String(message).toLowerCase().includes("scan")) {
        return;
      }

      finish(new Error(String(message)));
    };

    noble.once("scanStart", handleScanStart);
    noble.on("warning", handleWarning);

    timeoutId = setTimeout(() => {
      debug("scanStart event did not arrive; assuming scan request was accepted");
      finish();
    }, 2000);

    try {
      noble.startScanning(serviceUuids, allowDuplicates, (error) => {
        if (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function stopScanning() {
  await new Promise((resolve, reject) => {
    noble.stopScanning((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function postJson(path, body) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} -> ${response.status}: ${text}`);
  }

  return response.json();
}

async function getJson(path) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    headers: {
      "Cache-Control": "no-store",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} -> ${response.status}: ${text}`);
  }

  return response.json();
}

async function connectPeripheral(peripheral) {
  await withTimeout(
    `connect ${peripheral.advertisement?.localName ?? peripheral.id}`,
    CONNECT_TIMEOUT_MS,
    wrapCallback((callback) => peripheral.connect(callback)),
  );
}

async function disconnectPeripheral(peripheral) {
  if (!peripheral.state || peripheral.state === "disconnected") {
    return;
  }

  await wrapCallback((callback) => peripheral.disconnect(callback));
}

async function discoverRuntimeCharacteristics(peripheral) {
  const discovered = await withTimeout(
    `discover runtime characteristics for ${peripheral.advertisement?.localName ?? peripheral.id}`,
    DISCOVERY_TIMEOUT_MS,
    new Promise((resolve, reject) =>
      peripheral.discoverSomeServicesAndCharacteristics(
        [SERVICE_UUID],
        [TELEMETRY_UUID, CONTROL_UUID, STATUS_UUID, OTA_DATA_UUID],
        (error, services, characteristics) => {
          if (error) {
            reject(error);
            return;
          }

          resolve({ services, characteristics });
        },
      ),
    ),
  );

  return discovered.characteristics.reduce((result, characteristic) => {
    result[characteristic.uuid] = characteristic;
    return result;
  }, {});
}

function mapCharacteristics(characteristics) {
  return characteristics.reduce((result, characteristic) => {
    result[characteristic.uuid] = characteristic;
    return result;
  }, {});
}

async function discoverAllServicesAndCharacteristics(peripheral) {
  return await withTimeout(
    `discover all services for ${peripheral.advertisement?.localName ?? peripheral.id}`,
    DISCOVERY_TIMEOUT_MS,
    new Promise((resolve, reject) =>
      peripheral.discoverAllServicesAndCharacteristics(
        (error, services, characteristics) => {
          if (error) {
            reject(error);
            return;
          }

          resolve({ services, characteristics });
        },
      ),
    ),
  );
}

async function loadRuntimeCharacteristics(peripheral, advertisedName) {
  try {
    return await discoverRuntimeCharacteristics(peripheral);
  } catch (error) {
    const discovered = await discoverAllServicesAndCharacteristics(peripheral);
    const services = discovered.services.map((service) => service.uuid);
    const characteristics = mapCharacteristics(discovered.characteristics);

    debug(
      `full GATT discovery for ${advertisedName || peripheral.id} after runtime lookup failed`,
      {
        services,
        characteristics: discovered.characteristics.map(
          (characteristic) => characteristic.uuid,
        ),
      },
    );

    if (!services.includes(SERVICE_UUID)) {
      throw error;
    }

    return characteristics;
  }
}

async function subscribe(characteristic, label) {
  await withTimeout(
    `subscribe ${label}`,
    SUBSCRIBE_TIMEOUT_MS,
    wrapCallback((callback) => characteristic.subscribe(callback)),
  );
}

async function writeCharacteristic(characteristic, value, withoutResponse = false) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  await wrapCallback((callback) =>
    characteristic.write(buffer, withoutResponse, callback),
  );
}

function createStatusWaiter(context, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      context.statusListeners.delete(listener);
      reject(new Error(`Timed out waiting for OTA status on ${context.deviceId}.`));
    }, timeoutMs);

    const listener = (status) => {
      if (!predicate(status)) {
        return;
      }

      clearTimeout(timeoutId);
      context.statusListeners.delete(listener);
      resolve(status);
    };

    context.statusListeners.add(listener);
  });
}

async function reportFirmwareStatus(deviceId, status, targetVersion, detail) {
  const payload = {
    deviceId,
    status,
  };

  if (targetVersion) {
    payload.targetVersion = targetVersion;
  }

  if (detail) {
    payload.detail = detail;
  }

  await postJson("/api/firmware/report", payload);
}

async function forwardTelemetry(payload) {
  let context = deviceContexts.get(payload.deviceId);

  if (!context) {
    context = {
      deviceId: payload.deviceId,
      firmwareVersion: payload.firmwareVersion ?? "unknown",
      lastState: null,
      lastHeartbeatForwardedAt: 0,
      lastFirmwareCheckAt: 0,
      updateInFlight: false,
      statusListeners: new Set(),
      controlCharacteristic: null,
      otaDataCharacteristic: null,
    };
    deviceContexts.set(payload.deviceId, context);
  }

  context.firmwareVersion = payload.firmwareVersion ?? context.firmwareVersion;

  const stateChanged = context.lastState !== payload.state;

  if (stateChanged) {
    await postJson("/api/ingest", {
      deviceId: payload.deviceId,
      state: payload.state,
      timestamp: payload.timestamp,
      delta: payload.delta ?? null,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastState = payload.state;
    context.lastHeartbeatForwardedAt = Date.now();
    log(`forwarded motion event for ${payload.deviceId}: ${payload.state}`);
  } else if (
    Date.now() - context.lastHeartbeatForwardedAt >= config.heartbeatMinIntervalMs
  ) {
    await postJson("/api/heartbeat", {
      deviceId: payload.deviceId,
      timestamp: payload.timestamp,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastHeartbeatForwardedAt = Date.now();
    debug(`forwarded heartbeat for ${payload.deviceId}`);
  }

  await maybePerformOta(context);
}

async function maybePerformOta(context) {
  if (
    context.updateInFlight ||
    !context.controlCharacteristic ||
    !context.otaDataCharacteristic ||
    Date.now() - context.lastFirmwareCheckAt < config.firmwareCheckIntervalMs
  ) {
    return;
  }

  context.lastFirmwareCheckAt = Date.now();

  const query = new URLSearchParams({
    deviceId: context.deviceId,
    firmwareVersion: context.firmwareVersion ?? "unknown",
  });
  const response = await getJson(`/api/firmware/check?${query.toString()}`);

  if (!response.updateAvailable || !response.assetUrl || !response.version) {
    return;
  }

  context.updateInFlight = true;
  log(`firmware update available for ${context.deviceId}: ${response.version}`);

  try {
    await reportFirmwareStatus(context.deviceId, "downloading", response.version);
    const firmwareBuffer = await downloadFirmware(response.assetUrl, response.sha256);
    await pushFirmwareOverBle(context, {
      version: response.version,
      firmwareBuffer,
      sha256: response.sha256,
      sizeBytes: response.sizeBytes ?? firmwareBuffer.length,
    });
    await reportFirmwareStatus(context.deviceId, "applied", response.version);
    log(`firmware applied for ${context.deviceId}: ${response.version}`);
  } catch (error) {
    console.error(`[gateway] OTA failed for ${context.deviceId}`, error);
    await reportFirmwareStatus(
      context.deviceId,
      "failed",
      response.version,
      error instanceof Error ? error.message : "gateway-ota-failed",
    );
  } finally {
    context.updateInFlight = false;
  }
}

async function downloadFirmware(assetUrl, expectedSha256) {
  const response = await fetch(assetUrl);

  if (!response.ok) {
    throw new Error(`firmware download failed: ${response.status}`);
  }

  const firmwareBuffer = Buffer.from(await response.arrayBuffer());

  if (expectedSha256) {
    const actualSha256 = crypto
      .createHash("sha256")
      .update(firmwareBuffer)
      .digest("hex");

    if (actualSha256 !== String(expectedSha256).toLowerCase()) {
      throw new Error("downloaded firmware sha256 mismatch");
    }
  }

  return firmwareBuffer;
}

async function pushFirmwareOverBle(context, release) {
  const readyWaiter = createStatusWaiter(
    context,
    (status) => status.type === "ota-status" && status.phase === "ready",
  );
  const appliedWaiter = createStatusWaiter(
    context,
    (status) => status.type === "ota-status" && status.phase === "applied",
    120_000,
  );

  await writeCharacteristic(
    context.controlCharacteristic,
    JSON.stringify({
      type: "ota-begin",
      version: release.version,
      size: release.sizeBytes,
      sha256: release.sha256 ?? null,
    }),
  );

  await readyWaiter;

  for (
    let offset = 0;
    offset < release.firmwareBuffer.length;
    offset += config.otaChunkSize
  ) {
    const chunk = release.firmwareBuffer.subarray(
      offset,
      offset + config.otaChunkSize,
    );
    await writeCharacteristic(context.otaDataCharacteristic, chunk);
    if (offset > 0 && offset % (config.otaChunkSize * 32) === 0) {
      debug(`sent ${offset}/${release.firmwareBuffer.length} bytes to ${context.deviceId}`);
    }
  }

  await writeCharacteristic(
    context.controlCharacteristic,
    JSON.stringify({
      type: "ota-end",
    }),
  );

  await appliedWaiter;
}

function handleStatusMessage(context, status) {
  debug(`status from ${context.deviceId ?? context.peripheralId}`, status);

  for (const listener of context.statusListeners) {
    listener(status);
  }
}

async function registerPeripheral(peripheral) {
  if (peripherals.has(peripheral.id)) {
    return;
  }

  const advertisedName = peripheral.advertisement?.localName ?? "";
  const serviceUuids = peripheral.advertisement?.serviceUuids ?? [];
  const hasRuntimeService = serviceUuids.includes(SERVICE_UUID);
  const nameMatchesPrefix =
    Boolean(config.deviceNamePrefix) &&
    Boolean(advertisedName) &&
    advertisedName.startsWith(config.deviceNamePrefix);

  if (config.deviceNamePrefix && advertisedName && !nameMatchesPrefix) {
    debug(`ignoring ${advertisedName}`);
    return;
  }

  if (!hasRuntimeService && !nameMatchesPrefix) {
    debug(`ignoring ${advertisedName || peripheral.id} without runtime service`, {
      serviceUuids,
    });
    return;
  }

  if (!hasRuntimeService && nameMatchesPrefix) {
    debug(
      `runtime service missing from advertisement for ${advertisedName}; trying direct GATT discovery`,
      { serviceUuids },
    );
  }

  const peripheralContext = {
    peripheral,
    connected: false,
  };
  peripherals.set(peripheral.id, peripheralContext);

  peripheral.on("disconnect", () => {
    log(`disconnected from ${advertisedName || peripheral.id}`);
    peripherals.delete(peripheral.id);
  });

  try {
    debug(`connecting to ${advertisedName || peripheral.id}`);
    await connectPeripheral(peripheral);
    const characteristics = await loadRuntimeCharacteristics(peripheral, advertisedName);
    const telemetryCharacteristic = characteristics[TELEMETRY_UUID];
    const controlCharacteristic = characteristics[CONTROL_UUID];
    const statusCharacteristic = characteristics[STATUS_UUID];
    const otaDataCharacteristic = characteristics[OTA_DATA_UUID];

    debug(`runtime characteristic selection for ${advertisedName || peripheral.id}`, {
      telemetry: telemetryCharacteristic?.uuid ?? null,
      telemetryProperties: telemetryCharacteristic?.properties ?? [],
      control: controlCharacteristic?.uuid ?? null,
      controlProperties: controlCharacteristic?.properties ?? [],
      status: statusCharacteristic?.uuid ?? null,
      statusProperties: statusCharacteristic?.properties ?? [],
      otaData: otaDataCharacteristic?.uuid ?? null,
      otaDataProperties: otaDataCharacteristic?.properties ?? [],
    });

    if (!telemetryCharacteristic || !controlCharacteristic || !statusCharacteristic || !otaDataCharacteristic) {
      throw new Error(
        `missing required runtime characteristics (advertised services: ${serviceUuids.join(",") || "none"})`,
      );
    }

    debug(`subscribing to telemetry for ${advertisedName || peripheral.id}`);
    await subscribe(telemetryCharacteristic, `${advertisedName || peripheral.id} telemetry`);
    debug(`subscribing to status for ${advertisedName || peripheral.id}`);
    await subscribe(statusCharacteristic, `${advertisedName || peripheral.id} status`);
    debug(`subscriptions ready for ${advertisedName || peripheral.id}`);

    peripheralContext.connected = true;

    telemetryCharacteristic.on("data", (buffer) => {
      try {
        const payload = JSON.parse(buffer.toString("utf8"));
        const context = deviceContexts.get(payload.deviceId) ?? {
          deviceId: payload.deviceId,
          firmwareVersion: payload.firmwareVersion ?? "unknown",
          lastState: null,
          lastHeartbeatForwardedAt: 0,
          lastFirmwareCheckAt: 0,
          updateInFlight: false,
          statusListeners: new Set(),
          controlCharacteristic,
          otaDataCharacteristic,
        };

        context.controlCharacteristic = controlCharacteristic;
        context.otaDataCharacteristic = otaDataCharacteristic;
        deviceContexts.set(payload.deviceId, context);
        void forwardTelemetry(payload);
      } catch (error) {
        console.error("[gateway] failed to parse telemetry", error);
      }
    });

    statusCharacteristic.on("data", (buffer) => {
      try {
        const payload = JSON.parse(buffer.toString("utf8"));
        const deviceId = payload.deviceId;

        if (!deviceId) {
          return;
        }

        const context = deviceContexts.get(deviceId);

        if (!context) {
          return;
        }

        handleStatusMessage(context, payload);
      } catch (error) {
        console.error("[gateway] failed to parse device status", error);
      }
    });

    log(`connected to ${advertisedName || peripheral.id}`);
  } catch (error) {
    console.error(`[gateway] failed to connect to ${advertisedName || peripheral.id}`, error);
    peripherals.delete(peripheral.id);
    await disconnectPeripheral(peripheral).catch(() => {});
  }
}

async function start() {
  noble.on("stateChange", async (state) => {
    log(`bluetooth adapter state: ${state}`);

    if (state === "poweredOn") {
      try {
        await startScanning([], true);
        scanningStarted = true;
        log("scanning for BLE peripherals; filtering for runtime service in-process");
      } catch (error) {
        console.error("[gateway] failed to start scanning", error);
      }
      return;
    }

    if (scanningStarted) {
      await stopScanning().catch((error) => {
        console.error("[gateway] failed to stop scanning", error);
      });
      scanningStarted = false;
    }
  });

  noble.on("scanStop", () => {
    debug("scanStop event received");
  });

  noble.on("warning", (message) => {
    console.warn("[gateway] noble warning:", message);
  });

  noble.on("discover", (peripheral) => {
    debug("discovered peripheral", {
      id: peripheral.id,
      address: peripheral.address,
      localName: peripheral.advertisement?.localName ?? null,
      serviceUuids: peripheral.advertisement?.serviceUuids ?? [],
      rssi: peripheral.rssi,
    });
    void registerPeripheral(peripheral);
  });

  process.on("SIGINT", async () => {
    log("shutting down");
    if (scanningStarted) {
      await stopScanning().catch(() => {});
    }

    await Promise.all(
      Array.from(peripherals.values()).map(({ peripheral }) =>
        disconnectPeripheral(peripheral).catch(() => {}),
      ),
    );

    process.exit(0);
  });
}

await start();
