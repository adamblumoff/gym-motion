import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, types } from "pg";
import type { DrizzleDbSchema } from "./schema";
import { schema } from "./schema";

declare global {
  var pgPool: Pool | undefined;
  var pgTypesConfigured: boolean | undefined;
  var drizzleDb: NodePgDatabase<DrizzleDbSchema> | undefined;
}

const PG_TIMESTAMP_OID = 1114;
const PG_TIMESTAMPTZ_OID = 1184;

function parseTimestampWithoutTimezone(value: string) {
  return new Date(value.replace(" ", "T") + "Z");
}

function configurePgTypes() {
  if (globalThis.pgTypesConfigured) {
    return;
  }

  // The database stores server-received times in UTC.
  types.setTypeParser(PG_TIMESTAMP_OID, parseTimestampWithoutTimezone);
  types.setTypeParser(PG_TIMESTAMPTZ_OID, (value: string) => new Date(value));

  globalThis.pgTypesConfigured = true;
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_PUBLIC_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_PUBLIC_URL is required.");
  }

  return databaseUrl;
}

export function getDb() {
  configurePgTypes();

  if (!globalThis.pgPool) {
    globalThis.pgPool = new Pool({
      connectionString: getDatabaseUrl(),
    });
  }

  return globalThis.pgPool;
}

export function getDrizzleDb() {
  configurePgTypes();

  if (!globalThis.drizzleDb) {
    globalThis.drizzleDb = drizzle(getDb(), { schema });
  }

  return globalThis.drizzleDb;
}
