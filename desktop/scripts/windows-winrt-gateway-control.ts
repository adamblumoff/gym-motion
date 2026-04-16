import type { ApprovedNodeRule, DeviceSummary } from "@core/contracts";
import type {
  GatewayControlCommand,
  GatewayControlCommandResult,
} from "../main/managed-gateway-runtime/gateway-child-ipc.js";
import type { GatewayRuntimeServer } from "./windows-winrt-gateway-types.js";
import { approvedNodeRulesReferToSamePhysicalNode } from "./windows-winrt-gateway-node.js";

type ControlHandlerDeps = {
  runtimeServer: Pick<GatewayRuntimeServer, "restoreApprovedDevice" | "forgetDevice">;
  getApprovedNodeRules: () => ApprovedNodeRule[];
  setApprovedNodeRules: (rules: ApprovedNodeRule[]) => void;
  setLatestDevicesMetadata: (devices: DeviceSummary[]) => void;
  syncAllowedNodes: () => void;
  sendCommand: (type: string, payload?: Record<string, unknown>) => void;
  emitGatewayState: () => void;
  emitRuntimeDeviceUpdated: (deviceId: string | null | undefined) => void;
  requireSidecar: (action: string) => void;
};

export function createDesktopControlCommandHandler(deps: ControlHandlerDeps) {
  return async function handleDesktopControlCommand<TCommand extends GatewayControlCommand>(
    command: TCommand,
  ): Promise<GatewayControlCommandResult<TCommand>> {
    if (command.type === "set_devices_metadata") {
      deps.setLatestDevicesMetadata(command.devices);

      for (const device of command.devices) {
        deps.emitRuntimeDeviceUpdated(device.id);
      }
      deps.emitGatewayState();

      return {
        deviceCount: command.devices.length,
      } as GatewayControlCommandResult<TCommand>;
    }

    if (command.type !== "set_allowed_nodes") {
      throw new Error(`Unsupported control command: ${String(command.type ?? "unknown")}`);
    }

    deps.requireSidecar("update approved nodes");

    const currentApprovedNodeRules = deps.getApprovedNodeRules();
    const nextApprovedNodeRules = command.nodes;
    const nextRuleIds = new Set(nextApprovedNodeRules.map((node) => node.id));
    const removedRules = currentApprovedNodeRules.filter((node) => !nextRuleIds.has(node.id));
    const forgottenRules = removedRules.filter(
      (removedRule) =>
        !nextApprovedNodeRules.some((nextRule) =>
          approvedNodeRulesReferToSamePhysicalNode(removedRule, nextRule),
        ),
    );

    for (const rule of nextApprovedNodeRules) {
      deps.runtimeServer.restoreApprovedDevice({
        deviceId: rule.knownDeviceId ?? null,
        knownDeviceId: rule.knownDeviceId ?? null,
        peripheralId: rule.peripheralId ?? null,
        address: rule.address ?? null,
        localName: rule.localName ?? null,
      });
    }

    for (const rule of forgottenRules) {
      deps.runtimeServer.forgetDevice({
        deviceId: rule.knownDeviceId ?? null,
        knownDeviceId: rule.knownDeviceId ?? null,
        peripheralId: rule.peripheralId ?? null,
        address: rule.address ?? null,
        localName: rule.localName ?? null,
      });
    }

    deps.setApprovedNodeRules(nextApprovedNodeRules);
    deps.syncAllowedNodes();
    deps.sendCommand("refresh_scan_policy");
    deps.emitGatewayState();

    return {
      approvedCount: nextApprovedNodeRules.length,
      removedCount: removedRules.length,
      forgottenCount: forgottenRules.length,
    } as GatewayControlCommandResult<TCommand>;
  };
}
