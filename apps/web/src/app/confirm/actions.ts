"use server";

import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { db, connectDb } from "@/db";
import { queueWelcomeEmail } from "@/lib/sending";
import { eq } from "drizzle-orm";
import { newsletters } from "@/db/schema";

export async function confirmSubscription(token: string) {
	const reference = verifyConfirmToken(token);
	// Old unbound links stay parseable for pure helper compatibility but authorize no action.
	if (!reference?.confirmationNonce) return { error: "invalid" };

	await connectDb();
	const { contact, confirmed } = await confirmContact({ ...reference, confirmationNonce: reference.confirmationNonce });
	if (contact?.status !== "active") return { error: "invalid" };

	if (confirmed && isSendingEnabled()) {
		const newsletter = db.select().from(newsletters).where(eq(newsletters._id, reference.newsletterId)).get();
		if (!newsletter) return { ok: true };
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		after(() =>
			queueWelcomeEmail({ newsletter, contact }).catch((error: unknown) =>
				console.error(`[confirm] Welcome email for ${contact._id} failed:`, error instanceof Error ? error.message : error)
			)
		);
	}
	return { ok: true };
}
