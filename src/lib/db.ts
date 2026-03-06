import { Pool } from "pg";

declare global {
  var pgPool: Pool | undefined;
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_PUBLIC_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_PUBLIC_URL is required.");
  }

  return databaseUrl;
}

export function getDb() {
  if (!globalThis.pgPool) {
    globalThis.pgPool = new Pool({
      connectionString: getDatabaseUrl(),
    });
  }

  return globalThis.pgPool;
}
