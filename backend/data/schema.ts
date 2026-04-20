import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    lastState: text("last_state").notNull().default("still"),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull().default(0),
    lastDelta: integer("last_delta"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    hardwareId: text("hardware_id"),
    bootId: text("boot_id"),
    firmwareVersion: text("firmware_version").notNull().default("unknown"),
    machineLabel: text("machine_label"),
    siteId: text("site_id"),
    lastGatewayId: text("last_gateway_id"),
    lastGatewaySeenAt: timestamp("last_gateway_seen_at", {
      withTimezone: true,
      mode: "date",
    }),
    provisioningState: text("provisioning_state").notNull().default("unassigned"),
    updateStatus: text("update_status").notNull().default("idle"),
    updateTargetVersion: text("update_target_version"),
    updateDetail: text("update_detail"),
    updateReportedAt: timestamp("update_reported_at", { withTimezone: true, mode: "date" }),
    lastEventReceivedAt: timestamp("last_event_received_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true, mode: "date" }),
    wifiProvisionedAt: timestamp("wifi_provisioned_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("devices_updated_at_idx").on(table.updatedAt),
    index("devices_site_id_idx").on(table.siteId, table.machineLabel),
    index("devices_last_gateway_id_idx").on(table.lastGatewayId, table.lastGatewaySeenAt),
  ],
);

export const motionEvents = pgTable(
  "motion_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }),
    state: text("state").notNull(),
    delta: integer("delta"),
    eventTimestamp: bigint("event_timestamp", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    gatewayId: text("gateway_id"),
    bootId: text("boot_id"),
    firmwareVersion: text("firmware_version"),
    hardwareId: text("hardware_id"),
  },
  (table) => [
    index("motion_events_device_id_idx").on(table.deviceId, table.receivedAt),
    index("motion_events_device_event_timestamp_idx").on(table.deviceId, table.eventTimestamp),
    index("motion_events_gateway_id_idx").on(table.gatewayId, table.receivedAt),
    uniqueIndex("motion_events_device_boot_sequence_idx")
      .on(table.deviceId, sql`coalesce(${table.bootId}, '')`, table.sequence)
      .where(sql`${table.sequence} is not null`),
  ],
);

export const firmwareReleases = pgTable(
  "firmware_releases",
  {
    version: text("version").primaryKey(),
    gitSha: text("git_sha").notNull(),
    assetUrl: text("asset_url").notNull(),
    sha256: text("sha256").notNull(),
    md5: text("md5"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    rolloutState: text("rollout_state").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("firmware_releases_rollout_state_idx").on(table.rolloutState, table.createdAt)],
);

export const deviceLogs = pgTable(
  "device_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    deviceId: text("device_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }),
    level: text("level").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    bootId: text("boot_id"),
    firmwareVersion: text("firmware_version"),
    hardwareId: text("hardware_id"),
    deviceTimestamp: bigint("device_timestamp", { mode: "number" }),
    metadata: jsonb("metadata"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    gatewayId: text("gateway_id"),
  },
  (table) => [
    index("device_logs_device_id_idx").on(table.deviceId, table.receivedAt),
    index("device_logs_received_at_idx").on(table.receivedAt),
    index("device_logs_gateway_id_idx").on(table.gatewayId, table.receivedAt),
    uniqueIndex("device_logs_device_boot_sequence_idx")
      .on(table.deviceId, sql`coalesce(${table.bootId}, '')`, table.sequence)
      .where(sql`${table.sequence} is not null`),
  ],
);

export const deviceSyncState = pgTable(
  "device_sync_state",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    bootId: text("boot_id").notNull().default(""),
    lastAckedSequence: bigint("last_acked_sequence", { mode: "number" }).notNull().default(0),
    lastAckedBootId: text("last_acked_boot_id"),
    lastSyncCompletedAt: timestamp("last_sync_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastOverflowDetectedAt: timestamp("last_overflow_detected_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.bootId] })],
);

export const motionRollupsHourly = pgTable(
  "motion_rollups_hourly",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    bucketStart: bigint("bucket_start", { mode: "number" }).notNull(),
    movementCount: integer("movement_count").notNull(),
    movingSeconds: integer("moving_seconds").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.bucketStart] }),
    index("motion_rollups_hourly_bucket_idx").on(table.bucketStart),
  ],
);

export const motionRollupsDaily = pgTable(
  "motion_rollups_daily",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    bucketStart: bigint("bucket_start", { mode: "number" }).notNull(),
    movementCount: integer("movement_count").notNull(),
    movingSeconds: integer("moving_seconds").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.bucketStart] }),
    index("motion_rollups_daily_bucket_idx").on(table.bucketStart),
  ],
);

export const firmwareHistorySyncState = pgTable("firmware_history_sync_state", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  lastAckedHistorySequence: bigint("last_acked_history_sequence", { mode: "number" })
    .notNull()
    .default(0),
  lastHistorySyncCompletedAt: timestamp("last_history_sync_completed_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastHistoryOverflowDetectedAt: timestamp("last_history_overflow_detected_at", {
    withTimezone: true,
    mode: "date",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const schema = {
  devices,
  motionEvents,
  firmwareReleases,
  deviceLogs,
  deviceSyncState,
  motionRollupsHourly,
  motionRollupsDaily,
  firmwareHistorySyncState,
};

export type DrizzleDbSchema = typeof schema;
