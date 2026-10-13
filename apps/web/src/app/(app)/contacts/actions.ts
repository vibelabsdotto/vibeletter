"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, connectDb } from "@/db";
import { newsletters } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { importContactRows } from "@/lib/contact-import";
import { MAX_IMPORT_ROWS_PER_REQUEST } from "@/lib/csv-import";
import { OperatorError } from "@/lib/operator-api";
import { setContactStatus as changeContactStatus } from "@/lib/operator-services";
import { isObjectIdString } from "@/lib/validation";

type ImportRow = { email: string; status?: string; subscribedAt?: string | Date; emailsReceived?: number; openRate?: number; clickRate?: number };

export async function importContacts({ newsletterId, rows }: { newsletterId: string; rows: ImportRow[] }) {
	await requireSession();
	if (!isObjectIdString(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };
	await connectDb();
	if (!db.select({ _id: newsletters._id }).from(newsletters).where(eq(newsletters._id, newsletterId)).get()) {
		return { error: "Newsletter not found" };
	}
	const result = await importContactRows({ newsletterId, rows });
	revalidatePath("/contacts");
	return result;
}

export async function setContactStatus(id: string, status: string) {
	await requireSession();
	if (!isObjectIdString(id) || (status !== "active" && status !== "unsubscribed")) return { error: "Invalid request" };
	try {
		await changeContactStatus(id, { status });
		revalidatePath("/contacts");
		return { ok: true };
	} catch (error) {
		if (error instanceof OperatorError) return { error: error.message };
		throw error;
	}
}
