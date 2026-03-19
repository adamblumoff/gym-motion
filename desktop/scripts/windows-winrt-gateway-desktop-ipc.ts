// @ts-nocheck
import process from "node:process";

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
