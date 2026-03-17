import type { Dispatch, SetStateAction } from "react";

import type { ApprovedNodeRule } from "@core/contracts";
import type { ThemeState } from "@core/services";

import { applyThemeState } from "../../lib/theme";
import {
  applySetupState,
  replaceSnapshot,
  replaceThemeState,
} from "./reducer";
import type { DesktopAppState } from "./state";

export function createDesktopAppActions(
  setState: Dispatch<SetStateAction<DesktopAppState>>,
) {
  return {
    async setThemePreference(preference: ThemeState["preference"]) {
      const themeState = await window.gymMotionDesktop.setThemePreference(preference);
      applyThemeState(themeState);
      setState((current) => replaceThemeState(current, themeState));
    },
    async restartGatewayRuntime() {
      const snapshot = await window.gymMotionDesktop.restartGatewayRuntime();
      setState((current) => replaceSnapshot(current, snapshot));
    },
    async startManualScan() {
      const setup = await window.gymMotionDesktop.startManualScan();
      setState((current) => applySetupState(current, setup));
      return setup;
    },
    async pairDiscoveredNode(candidateId: string) {
      const setup = await window.gymMotionDesktop.pairDiscoveredNode(candidateId);
      setState((current) => applySetupState(current, setup));
      return setup;
    },
    async pairManualCandidate(candidateId: string) {
      const setup = await window.gymMotionDesktop.pairManualCandidate(candidateId);
      setState((current) => applySetupState(current, setup));
      return setup;
    },
    async forgetNode(nodeId: string) {
      const setup = await window.gymMotionDesktop.forgetNode(nodeId);
      setState((current) => applySetupState(current, setup));
      return setup;
    },
    async recoverApprovedNode(ruleId: string) {
      await window.gymMotionDesktop.recoverApprovedNode(ruleId);
    },
    async resumeReconnectForNode(nodeId: string) {
      await window.gymMotionDesktop.resumeReconnectForNode(nodeId);
    },
    async resumeApprovedNodeReconnect(ruleId: string) {
      await window.gymMotionDesktop.resumeApprovedNodeReconnect(ruleId);
    },
    async setAllowedNodes(nodes: ApprovedNodeRule[]) {
      const setup = await window.gymMotionDesktop.setAllowedNodes(nodes);
      setState((current) => applySetupState(current, setup));
      return setup;
    },
  };
}
