import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
const configuredPath = process.env.DATABASE_PATH?.trim();
if (configuredPath && !isAbsolute(configuredPath)) throw new Error("DATABASE_PATH must be an absolute filesystem path");
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: configuredPath || fileURLToPath(new URL("../../data/vibeletter.db", import.meta.url)) },
  strict: true,
  verbose: true,
});
