import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getDb } from "./db";

const SQL_DIR = path.join(process.cwd(), "sql");

export function hasDatabaseTestEnv() {
  return Boolean(process.env.DATABASE_PUBLIC_URL);
}

export async function resetDatabaseSchema() {
  const db = getDb();
  await db.query("drop schema if exists public cascade;");
  await db.query("create schema public;");
  await db.query("grant all on schema public to current_user;");
  await db.query("grant all on schema public to public;");
  const filenames = (await readdir(SQL_DIR))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(path.join(SQL_DIR, filename), "utf8");
    await db.query(sql);
  }
}

export async function closeDatabase() {
  const pool = globalThis.pgPool;
  globalThis.pgPool = undefined;

  if (pool) {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}
