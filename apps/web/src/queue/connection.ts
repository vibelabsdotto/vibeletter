import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildDBClient, migrateDB } from "liteque";
import { databasePath } from "@/db";

export type QueueDatabase = ReturnType<typeof buildDBClient>;
let connection: QueueDatabase | undefined;

export function getQueueDatabasePath(): string {
	const configured = process.env.QUEUE_DATABASE_PATH;
	if (configured && !isAbsolute(configured)) throw new Error("QUEUE_DATABASE_PATH must be an absolute filesystem path");
	const queuePath = configured || resolve(dirname(databasePath), "queue.db");
	// Runtime volume paths are never assets to bundle into the standalone image.
	if (resolve(/* turbopackIgnore: true */ queuePath) === resolve(/* turbopackIgnore: true */ databasePath)) throw new Error("Queue and app databases must use different files");
	return queuePath;
}

/** Package migrations run only from the explicit queue:migrate operator command. */
export function openQueueDatabase(migrate = false): QueueDatabase {
	const path = getQueueDatabasePath();
	mkdirSync(dirname(path), { recursive: true });
	const db = buildDBClient(path, { runMigrations: false, walEnabled: true });
	db.$client.pragma("synchronous = FULL");
	db.$client.pragma("busy_timeout = 5000");
	try {
		if (migrate) migrateDB(db);
		const columns = db.$client.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
		const names = new Set(columns.map(({ name }) => name));
		for (const name of ["id", "queue", "payload", "status", "availableAt", "expireAt", "allocationId", "numRunsLeft", "maxNumRuns", "idempotencyKey", "priority"]) {
			if (!names.has(name)) throw new Error("Queue database is not ready. Run npm run queue:migrate before starting web or worker.");
		}
		return db;
	} catch (error) {
		db.$client.close();
		throw error;
	}
}

export function getQueueDatabase(): QueueDatabase {
	connection ??= openQueueDatabase();
	return connection;
}

export function closeQueueDatabase(): void {
	connection?.$client.close();
	connection = undefined;
}
