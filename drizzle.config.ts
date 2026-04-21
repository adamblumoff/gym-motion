import { defineConfig } from "drizzle-kit";
import { loadRepoEnv } from "./scripts/load-env";

loadRepoEnv();

const databaseUrl = process.env.DATABASE_PUBLIC_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_PUBLIC_URL is required for Drizzle.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./backend/data/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
