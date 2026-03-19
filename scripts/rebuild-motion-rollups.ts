import { fileURLToPath } from "node:url";
import path from "node:path";

import dotenv from "dotenv";

import { getDb, rebuildMotionRollups } from "../backend/data";

const repoRoot = new URL("../", import.meta.url);
const rootEnvPath = path.join(fileURLToPath(repoRoot), ".env.local");

dotenv.config({ path: rootEnvPath });

async function main() {
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await rebuildMotionRollups(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await db.end();
  }

  console.log("Motion rollups rebuilt.");
}

main().catch((error) => {
  console.error("Failed to rebuild motion rollups.", error);
  process.exit(1);
});
