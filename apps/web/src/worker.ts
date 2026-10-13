import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfigProblems } from "@/lib/config";

export async function startWorker(): Promise<void> {
	const problems = getConfigProblems();
	if (process.env.NODE_ENV === "production" && process.env.DEV_LOGIN_ENABLED === "true") problems.push("DEV_LOGIN_ENABLED is forbidden in production");
	if (problems.length) throw new Error(`Invalid worker configuration: ${problems.join(" ")}`);
	// Validate before importing the eager SQLite singleton, not merely before connectDb().
	const { connectDb, sqlite } = await import("@/db");
	const { closeQueueDatabase } = await import("@/queue/connection");
	try {
		await connectDb();
		const { createQueueRunner, reconcileQueue } = await import("@/queue/runner");
		const repaired = await reconcileQueue({ recoverInterrupted: true });
		let stopping = false;
		const runner = createQueueRunner({ isStopping: () => stopping });
		let reconciliation: Promise<unknown> | undefined;
		const stop = () => {
			if (stopping) return;
			stopping = true;
			clearInterval(timer);
			runner.stop();
			console.info("[worker] stopping; waiting for in-flight delivery");
		};
		const timer = setInterval(() => {
			if (stopping || reconciliation) return;
			reconciliation = reconcileQueue().catch((error: unknown) => {
				console.error("[worker] reconciliation failed:", error instanceof Error ? error.message : "storage error");
			}).finally(() => { reconciliation = undefined; });
		}, 30_000);
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		console.info("[worker] durable SQLite queue ready", repaired);
		try {
			// stop() is synchronous in liteque 0.10; run() drains the active jobs before resolving.
			await runner.run();
		} finally {
			stop();
			await reconciliation;
			process.removeListener("SIGTERM", stop);
			process.removeListener("SIGINT", stop);
			console.info("[worker] stopped");
		}
	} finally {
		closeQueueDatabase();
		if (sqlite.open) sqlite.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	startWorker().catch((error: unknown) => {
		console.error("[worker] startup/runtime failure:", error instanceof Error ? error.message : "unknown error");
		process.exitCode = 1;
	});
}
