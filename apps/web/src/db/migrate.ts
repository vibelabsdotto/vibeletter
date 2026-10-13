import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite, databasePath, migrationsFolder, connectDb } from "./index";

try {
  migrate(db, { migrationsFolder });
  const violations = sqlite.pragma("foreign_key_check");
  if (Array.isArray(violations) && violations.length) throw new Error("Migration finished with foreign-key violations");
  await connectDb();
  console.log(`VibeLetter database migrated: ${databasePath}`);
} finally {
  sqlite.close();
}
