import { readFile } from "node:fs/promises";

import { getDb } from "@/lib/db";

async function main() {
  const sql = await readFile(new URL("../sql/001_init.sql", import.meta.url), {
    encoding: "utf8",
  });

  const db = getDb();

  await db.query(sql);
  await db.end();

  console.log("Database schema is ready.");
}

main().catch((error) => {
  console.error("Failed to apply schema.", error);
  process.exit(1);
});
