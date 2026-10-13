import { sqlite } from "@/db";
import { openQueueDatabase } from "./connection";

const database = openQueueDatabase(true);
try {
	console.info("Queue migrations applied using liteque's official migrateDB().");
} finally {
	database.$client.close();
	if (sqlite.open) sqlite.close();
}
