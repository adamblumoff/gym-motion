import type { DesktopSnapshot } from "@core/contracts";

import { applyApprovedNodeFilterToSnapshot } from "./runtime-cache-approved-filter";
import { createRuntimeCacheActivityStore } from "./runtime-cache-activity-store";
import { createRuntimeCacheOptimisticStore } from "./runtime-cache-optimistic-store";
import { createRuntimeCacheSnapshotStore } from "./runtime-cache-snapshot-store";
import type { RuntimeCache, RuntimeCacheOptions } from "./runtime-cache-types";

export type { RuntimeCache, RuntimeCacheOptions, RuntimeBatchPatchState } from "./runtime-cache-types";

export function createRuntimeCache(
  initialSnapshot: DesktopSnapshot,
  options: RuntimeCacheOptions = {},
): RuntimeCache {
  const snapshotStore = createRuntimeCacheSnapshotStore(initialSnapshot);
  const activityStore = createRuntimeCacheActivityStore({
    getMutableSnapshot: snapshotStore.getMutableSnapshot,
    eventLimit: options.eventLimit ?? 14,
    logLimit: options.logLimit ?? 18,
    activityLimit: options.activityLimit ?? 30,
    nodeActivityLimit: options.nodeActivityLimit ?? 30,
  });
  const optimisticStore = createRuntimeCacheOptimisticStore({
    getMutableSnapshot: snapshotStore.getMutableSnapshot,
    getDevice: snapshotStore.getDevice,
    upsertDevice: snapshotStore.upsertDevice,
    pushEvent: activityStore.pushEvent,
    pushLog: activityStore.pushLog,
    pushActivity: activityStore.pushActivity,
    trimPerDeviceActivities: activityStore.trimPerDeviceActivities,
  });

  activityStore.rebuildActivityIndex();

  return {
    getSnapshot: snapshotStore.getSnapshot,
    replaceSnapshot(nextSnapshot) {
      snapshotStore.replaceSnapshot(nextSnapshot);
      activityStore.rebuildActivityIndex();
    },
    updateGateway: snapshotStore.updateGateway,
    upsertDevice: snapshotStore.upsertDevice,
    getDevice: snapshotStore.getDevice,
    recordOptimisticMotion: optimisticStore.recordOptimisticMotion,
    recordOptimisticLog: optimisticStore.recordOptimisticLog,
    clearOptimisticMessage: optimisticStore.clearOptimisticMessage,
    pushEvent: activityStore.pushEvent,
    pushLog: activityStore.pushLog,
    pushActivity: activityStore.pushActivity,
    applyApprovedNodeFilter(approvedNodes) {
      return applyApprovedNodeFilterToSnapshot(
        snapshotStore.getMutableSnapshot(),
        approvedNodes,
        activityStore.rebuildActivityIndex,
      );
    },
  };
}
