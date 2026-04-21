import { getDb, rebuildMotionRollups } from "../backend/data";
import { loadRepoEnv } from "./load-env";

loadRepoEnv();

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
