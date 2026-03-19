export function createGatewayRuntimeServer(options: {
  apiBaseUrl: string;
  runtimeHost: string;
  runtimePort: number;
  knownNodesPath?: string;
  onControlCommand?: ((command: unknown) => unknown | Promise<unknown>) | null;
  verbose?: boolean;
}): {
  start(): Promise<void>;
  stop(): Promise<void>;
  setAdapterState(state: string): void;
  setGatewayIssue(issue: string | null): void;
  setAvailableAdapters(adapters: unknown[]): void;
  setScanState(scanState: string, scanReason?: string | null): void;
  setManualScanState(config: {
    state?: string;
    pairingCandidateId?: string | null;
    error?: string | null;
    clearCandidates?: boolean;
  }): void;
  upsertManualScanCandidate(candidate: unknown): void;
  getManualScanPayload(): unknown;
  getGatewayState(): Record<string, unknown>;
  getAvailableAdapters(): unknown[];
  getRuntimeNode(deviceId: string): Record<string, unknown> | null;
  getRuntimeNodes(): Array<Record<string, unknown>>;
  resolveKnownDeviceId(input: unknown): string | null;
  noteDiscovery(input: Record<string, unknown>): void;
  noteConnecting(input: Record<string, unknown>): unknown;
  noteConnected(input: Record<string, unknown>): unknown;
  noteTelemetry(payload: Record<string, unknown>, peripheralInfo?: Record<string, unknown>): Promise<unknown>;
  noteDisconnected(input: Record<string, unknown>): unknown;
  clearReconnectDecision(input: Record<string, unknown>): unknown;
  restoreApprovedDevice(input: Record<string, unknown>): unknown;
  forgetDevice(input: Record<string, unknown>): unknown;
  noteOtaStatus(deviceId: string, patch: Record<string, unknown>): void;
};
