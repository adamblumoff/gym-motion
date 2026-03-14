import { getDb } from "@/lib/db";

const TIMESTAMP_COLUMNS = [
  { table: "devices", column: "updated_at" },
  { table: "devices", column: "last_event_received_at" },
  { table: "devices", column: "last_heartbeat_at" },
  { table: "devices", column: "wifi_provisioned_at" },
  { table: "motion_events", column: "received_at" },
  { table: "firmware_releases", column: "created_at" },
  { table: "device_logs", column: "received_at" },
] as const;

async function main() {
  const db = getDb();

  try {
    await db.query("begin");

    for (const target of TIMESTAMP_COLUMNS) {
      const result = await db.query<{ data_type: string }>(
        `select data_type
         from information_schema.columns
         where table_schema = 'public'
           and table_name = $1
           and column_name = $2`,
        [target.table, target.column],
      );

      const dataType = result.rows[0]?.data_type;

      if (dataType === "timestamp without time zone") {
        await db.query(
          `alter table ${target.table}
           alter column ${target.column}
           type timestamptz
           using ${target.column} at time zone 'UTC'`,
        );
      }
    }

    await db.query("commit");
    console.log("Timestamp columns are timezone-aware.");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Failed to migrate timestamp columns.", error);
  process.exit(1);
});
