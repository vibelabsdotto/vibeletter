import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as schema from "./schema";
import { authSchema } from "./auth-schema";

const configuredPath = process.env.DATABASE_PATH?.trim();
if (configuredPath && !isAbsolute(configuredPath)) {
  throw new Error("DATABASE_PATH must be an absolute filesystem path");
}
// npm workspace commands and Next standalone run with cwd apps/web. Runtime filesystem paths
// must not be new URL assets: Turbopack would trace database contents and cannot import a directory.
// Configured paths must stay runtime-only too: tracing a live WAL file causes an HMR reload loop.
export const databasePath = resolve(/* turbopackIgnore: true */ configuredPath || resolve(/* turbopackIgnore: true */ process.cwd(), "../../data/vibeletter.db"));
export const migrationsFolder = resolve(process.cwd(), "drizzle");

// Next development reloads reuse the same connection, not a growing pool of SQLite handles.
type Connection = ReturnType<typeof openConnection>;
const cache = globalThis as typeof globalThis & { vibeletterSqliteConnections?: Map<string, Connection> };
// Concurrent first opens (parallel `next build` workers on a fresh file) can all request the
// exclusive WAL switch. SQLite then returns SQLITE_BUSY without waiting, so retry briefly.
function enableWal(connection: Database.Database) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (connection.pragma("journal_mode", { simple: true }) !== "wal") connection.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || attempt >= 100) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 40);
    }
  }
}
function openConnection() {
  mkdirSync(dirname(databasePath), { recursive: true });
  const connection = new Database(databasePath);
  connection.pragma("busy_timeout = 5000");
  enableWal(connection);
  connection.pragma("foreign_keys = ON");
  return { sqlite: connection, db: drizzle(connection, { schema: { ...schema, ...authSchema } }) };
}
cache.vibeletterSqliteConnections ??= new Map();
let connection = cache.vibeletterSqliteConnections.get(databasePath);
if (!connection?.sqlite.open) {
  connection = openConnection();
  cache.vibeletterSqliteConnections.set(databasePath, connection);
}
export const sqlite = connection.sqlite;
export const db = connection.db;

// Explicit operator migration only. Readers must not create or upgrade tables.
export async function connectDb() {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const present = new Set(tables.map(row => row.name));
  const required = ["newsletters", "campaigns", "contacts", "messages", "events", "suppressions", "api_keys", "alerts", "auth_user", "auth_session", "auth_account", "auth_verification", "rate_limit_buckets", "__drizzle_migrations"];
  if (required.some(name => !present.has(name))) {
    throw new Error("Database is not migrated. Run npm run db:migrate --workspace=apps/web before starting VibeLetter.");
  }
  const migrations = readMigrationFiles({ migrationsFolder });
  const latest = migrations.at(-1);
  if (latest) {
    const applied = sqlite.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { hash: string; created_at: number } | undefined;
    if (!applied || applied.created_at < latest.folderMillis || applied.hash !== latest.hash) {
      throw new Error("Database has pending or mismatched migrations. Run npm run db:migrate --workspace=apps/web.");
    }
  }
  return db;
}
