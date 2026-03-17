import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

let nextRequestId = 0;
const pendingRequests = new Map();
let responseListenerAttached = false;

function isPersistResultMessage(input) {
  return (
    typeof input === "object" &&
    input !== null &&
    input.type === "persist-result" &&
    typeof input.requestId === "string" &&
    typeof input.ok === "boolean"
  );
}

function ensureResponseListener(debug = () => {}) {
  if (responseListenerAttached || typeof process.on !== "function") {
    return;
  }

  process.on("message", (message) => {
    if (!isPersistResultMessage(message)) {
      return;
    }

    const pending = pendingRequests.get(message.requestId);

    if (!pending) {
      debug("received persist result for unknown request", message.requestId);
      return;
    }

    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeoutId);

    if (message.ok) {
      pending.resolve();
      return;
    }

    pending.reject(new Error(message.error ?? "Desktop persistence request failed."));
  });

  responseListenerAttached = true;
}

export function sendToDesktop(message, debug = () => {}) {
  if (typeof process.send !== "function") {
    debug("desktop IPC channel unavailable");
    return false;
  }

  try {
    process.send(message);
    return true;
  } catch (error) {
    debug(
      "failed to send desktop IPC message",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export function sendRequestToDesktop(message, options = {}) {
  const { debug = () => {}, timeoutMs = 15_000 } = options;

  if (typeof process.send !== "function") {
    debug("desktop IPC channel unavailable");
    return Promise.reject(new Error("Desktop IPC channel is unavailable."));
  }

  ensureResponseListener(debug);

  const requestId = `persist-${Date.now()}-${nextRequestId++}`;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Desktop persistence request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      process.send({ ...message, requestId });
    } catch (error) {
      pendingRequests.delete(requestId);
      clearTimeout(timeoutId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
