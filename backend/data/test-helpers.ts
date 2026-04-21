import { resetDatabaseWithMigrations } from "./migrations";

export function hasDatabaseTestEnv() {
  return Boolean(process.env.DATABASE_PUBLIC_URL);
}

export async function resetDatabaseSchema() {
  await resetDatabaseWithMigrations();
}

export async function closeDatabase() {
  const pool = globalThis.pgPool;
  globalThis.pgPool = undefined;
  globalThis.drizzleDb = undefined;

  if (pool) {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}
