export function windowsRescanMode(approvedNodeCount: number) {
  return approvedNodeCount > 0 ? "startup-policy" : "manual";
}
