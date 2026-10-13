import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// The actual SQLite limiter must use a fresh migrated fixture, never the running app database.
const directory = mkdtempSync(join(tmpdir(), "vibeletter-rate-limit-"));
process.env.DATABASE_PATH = join(directory, "app.db");
const { db, sqlite, migrationsFolder } = await import("../db/index.ts");
migrate(db, { migrationsFolder });
const { isLimitedInMemory, isRateLimited } = await import("../lib/rate-limit.ts");
after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

const LOGIN = { name: "test-login", limit: 3, window: "15 m" };

async function countAllowed(options, attempts) {
	let allowed = 0;
	for (let attempt = 0; attempt < attempts; attempt += 1) if (!(await isRateLimited(options))) allowed += 1;
	return allowed;
}

test("SQLite limits apply per visitor and named budget", async () => {
	const results = [];
	for (let attempt = 0; attempt < 4; attempt += 1) results.push(await isRateLimited({ ...LOGIN, key: "203.0.113.7" }));
	assert.deepEqual(results, [false, false, false, true]);
	assert.equal(await isRateLimited({ ...LOGIN, key: "203.0.113.8" }), false, "other visitors keep their own count");
	assert.equal(await isRateLimited({ ...LOGIN, name: "test-other", key: "203.0.113.7" }), false, "and other limits");
});

test("a SQLite error or timeout denies requests instead of letting everything through", async (t) => {
	t.mock.method(console, "error", () => {});
	// Fault only the existing SQL I/O boundary; the production fail-closed decision stays real.
	const prepare = t.mock.method(sqlite, "prepare", () => { throw new Error("synthetic SQLite failure"); });
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.3" }, 5), 0);
	prepare.mock.mockImplementation(() => { throw new Error("synthetic SQLite timeout"); });
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.4" }, 5), 0);
});

test("the available SQLite budget decides whether requests are allowed", async () => {
	const budget = { ...LOGIN, limit: 5, key: "198.51.100.5" };
	assert.equal(await countAllowed(budget, 5), 5);
	assert.equal(await countAllowed(budget, 2), 0);
});

test("SQLite limits open again once the window has passed", () => {
	const limits = { name: "test-window", limit: 2, window: "10 m" };
	const start = Date.parse("2026-10-09T12:00:00Z");
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 1000), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 2000), true);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 10 * 60_000 + 1000), false);
});
