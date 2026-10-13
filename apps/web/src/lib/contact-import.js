import { STATUS_RANK } from "./csv-import.js";

function weakerStatuses(status) {
	return Object.keys(STATUS_RANK).filter((key) => STATUS_RANK[key] < STATUS_RANK[status]);
}

// One upsert per contact: new contacts take the file's status, existing ones keep theirs.
export function getContactWrites({ newsletterId, contacts, source }) {
	return contacts.map(({ email, status, subscribedAt, emailsReceived, openRate, clickRate }) => {
		const imported = Object.entries({ emailsReceived, openRate, clickRate }).filter(
			([, value]) => value !== undefined
		);
		return {
			updateOne: {
				filter: { newsletterId, email },
				update: {
					$setOnInsert: {
						status,
						source,
						subscribedAt: subscribedAt ?? new Date(),
						...(status === "unsubscribed" && { unsubscribedAt: new Date() }),
					},
					...(imported.length > 0 && {
						$set: Object.fromEntries(imported.map(([key, value]) => [`imported.${key}`, value])),
					}),
				},
				upsert: true,
			},
		};
	});
}

// Each status the rows move existing contacts to, with the weaker statuses it replaces. Nothing moves a
// contact to active, and pending has no rank, so a contact waiting to confirm stays as it is.
export function getStatusChanges(contacts) {
	return Object.entries(Object.groupBy(contacts, ({ status }) => status))
		.filter(([status]) => status !== "active")
		.map(([status, group]) => ({
			status,
			emails: group.map(({ email }) => email),
			replaces: weakerStatuses(status),
		}));
}

// Never deletes and never moves a contact back to a weaker status: an unsubscribe, bounce or
// complaint always wins.
export async function importContactRows(options) {
	const store = await import("./contact-import-store");
	return store.importContactRows(options);
}
