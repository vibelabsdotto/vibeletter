import { and, eq, isNotNull, sql } from "drizzle-orm";
import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import { isSendingEnabled } from "@/lib/config";
import { db, connectDb } from "@/db";
import { contacts, newsletters } from "@/db/schema";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";

export const metadata = { title: "Newsletter" };

export default async function NewsletterPage({ params }) {
	const { id } = await params;
	const isNew = id === "new";
	if (!isNew && !isValidObjectId(id)) notFound();

	await connectDb();
	const [newsletter, domains, cleanupTotals] = await Promise.all([
		isNew ? null : db.select().from(newsletters).where(eq(newsletters._id, id)).get(),
		listSesDomains(),
		isNew ? null : getCleanupTotals(id),
	]);
	if (!isNew && !newsletter) notFound();

	const verifiedDomains = Array.isArray(domains)
		? domains.filter(({ verified }) => verified).map(({ domain }) => domain)
		: null;

	return (
		<>
			<HeaderPage
				title={isNew ? "New newsletter" : newsletter.name}
				backHref="/newsletters"
				icon={newsletter && <AvatarNewsletter newsletter={newsletter} size={32} />}
			/>
			<FormNewsletter
				newsletter={newsletter ? serialize(newsletter) : null}
				verifiedDomains={verifiedDomains}
				isSendingEnabled={isSendingEnabled()}
				testEmail={process.env.ADMIN_EMAIL}
				cleanupTotals={cleanupTotals}
			/>
		</>
	);
}

async function getCleanupTotals(newsletterId) {
	const life = sql`max(coalesce(${contacts.lastEngagedAt}, 0), coalesce(${contacts.lastOpenAt}, 0), coalesce(${contacts.lastClickAt}, 0), coalesce(${contacts.confirmedAt}, 0), coalesce(${contacts.subscribedAt}, ${contacts.createdAt}, 0))`;
	const totals = db.select({
		waiting: sql`coalesce(sum(case when ${contacts.status} = 'active' and ${contacts.lastChanceAt} >= ${life} then 1 else 0 end), 0)`.mapWith(Number),
		kept: sql`coalesce(sum(case when ${contacts.status} = 'active' and ${contacts.lastChanceAt} < ${life} then 1 else 0 end), 0)`.mapWith(Number),
		dormant: sql`coalesce(sum(case when ${contacts.status} = 'dormant' then 1 else 0 end), 0)`.mapWith(Number),
	}).from(contacts).where(and(eq(contacts.newsletterId, newsletterId), isNotNull(contacts.lastChanceAt))).get();
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
