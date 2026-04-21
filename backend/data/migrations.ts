import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getDrizzleDb } from "./db";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");
const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const APP_TABLE_NAMES = [
  "device_logs",
  "device_sync_state",
  "devices",
  "firmware_history_sync_state",
  "firmware_releases",
  "motion_events",
  "motion_rollups_daily",
  "motion_rollups_hourly",
] as const;

async function ensureDrizzleMigrationTable() {
  const db = getDb();
  await db.query(`create schema if not exists "${DRIZZLE_SCHEMA}"`);
  await db.query(`
    create table if not exists "${DRIZZLE_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
}

async function latestRecordedMigrationMillis() {
  const db = getDb();
  const result = await db.query<{ created_at: string | number }>(`
    select created_at
    from "${DRIZZLE_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}"
    order by created_at desc
    limit 1
  `);

  const value = result.rows[0]?.created_at;
  return value == null ? null : Number(value);
}

async function countExistingAppTables() {
  const db = getDb();
  const result = await db.query<{ count: string }>(
    `
      select count(*)::text as count
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
    `,
    [APP_TABLE_NAMES],
  );

  return Number(result.rows[0]?.count ?? "0");
}

async function baselineExistingSchema() {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query("begin");
    for (const migration of migrations) {
      await client.query(
        `
          insert into "${DRIZZLE_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}" ("hash", "created_at")
          values ($1, $2)
        `,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function applyDatabaseMigrations() {
  await ensureDrizzleMigrationTable();

  const latestMigrationMillis = await latestRecordedMigrationMillis();
  if (latestMigrationMillis != null) {
    await migrate(getDrizzleDb(), { migrationsFolder: MIGRATIONS_FOLDER });
    return "migrated";
  }

  const existingTableCount = await countExistingAppTables();
  if (existingTableCount === 0) {
    await migrate(getDrizzleDb(), { migrationsFolder: MIGRATIONS_FOLDER });
    return "migrated";
  }

  if (existingTableCount !== APP_TABLE_NAMES.length) {
    throw new Error(
      `Refusing to baseline a partial schema: found ${existingTableCount} of ${APP_TABLE_NAMES.length} expected app tables.`,
    );
  }

  await baselineExistingSchema();
  return "baselined";
}

export async function resetDatabaseWithMigrations() {
  const db = getDb();
  await db.query("drop schema if exists public cascade;");
  await db.query("create schema public;");
  await db.query("grant all on schema public to current_user;");
  await db.query("grant all on schema public to public;");
  await db.query(`drop schema if exists "${DRIZZLE_SCHEMA}" cascade;`);
  await applyDatabaseMigrations();
}
