import { applyDatabaseMigrations } from "../backend/data/migrations";
import { getDb } from "../backend/data/db";

async function main() {
  const result = await applyDatabaseMigrations();
  await getDb().end();
  console.log(`Database ${result}.`);
}

main().catch(async (error) => {
  console.error("Failed to apply database migrations.", error);
  await getDb().end().catch(() => {});
  process.exit(1);
});
