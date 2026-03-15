import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";

import { getDb } from "@/lib/db";

const repoRoot = new URL("../../", import.meta.url);
const rootEnvPath = path.join(repoRoot.pathname, ".env.local");

dotenv.config({ path: rootEnvPath });

async function main() {
  const db = getDb();
  const sqlDir = new URL("../../sql/", import.meta.url);
  const filenames = (await readdir(sqlDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(new URL(filename, sqlDir), {
      encoding: "utf8",
    });
    await db.query(sql);
  }

  await db.end();

  console.log("Database schema is ready.");
}

main().catch((error) => {
  console.error("Failed to apply schema.", error);
  process.exit(1);
});
