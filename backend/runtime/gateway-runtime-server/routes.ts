// @ts-nocheck
import { STREAM_PING_MS, formatSseEvent, jsonResponse } from "./utils.js";

export function createRequestHandler({
  gatewayState,
  getRuntimeIssue,
  getAvailableAdapters,
  streamClients,
  getDevicesPayload,
  getManualScanPayload,
  onControlCommand,
  touchGatewayState,
  broadcastGatewayStatus,
  readJsonRequest,
  listDiscoveries,
}) {
  return async function handleRequest(request, response) {
    const runtimeIssue = getRuntimeIssue();
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      touchGatewayState();
      jsonResponse(response, 200, {
        ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
        gateway: gatewayState,
        error: runtimeIssue ?? undefined,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      jsonResponse(response, 200, await getDevicesPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/discoveries") {
      jsonResponse(response, 200, {
        discoveries: listDiscoveries(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/manual-scan") {
      jsonResponse(response, 200, getManualScanPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/adapters") {
      jsonResponse(response, 200, {
        adapters: getAvailableAdapters(),
        error: runtimeIssue ?? undefined,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/control") {
      if (typeof onControlCommand !== "function") {
        jsonResponse(response, 404, {
          ok: false,
          error: "Control endpoint unavailable.",
        });
        return;
      }

      let command;
      try {
        command = await readJsonRequest(request);
      } catch (error) {
        jsonResponse(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Invalid control payload.",
        });
        return;
      }

      try {
        const result = await onControlCommand(command);
        jsonResponse(response, 200, {
          ok: true,
          ...(result && typeof result === "object" ? result : {}),
        });
      } catch (error) {
        jsonResponse(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "Control command failed.",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/stream") {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });

      const ping = setInterval(() => {
        response.write(": ping\n\n");
      }, STREAM_PING_MS);
      ping.unref?.();

      streamClients.add(response);
      response.write(formatSseEvent("connected", { ok: true }));
      response.write(
        formatSseEvent("gateway-status", {
          ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
          gateway: gatewayState,
          error: runtimeIssue ?? undefined,
        }),
      );

      const devicesPayload = await getDevicesPayload();
      for (const device of devicesPayload.devices) {
        response.write(formatSseEvent("gateway-device", { device }));
      }

      request.on("close", () => {
        clearInterval(ping);
        streamClients.delete(response);
        response.end();
      });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found." });
  };
}
