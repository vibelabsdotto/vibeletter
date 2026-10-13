import "server-only";

import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { apiKeys, suppressions, contacts } from "@/db/schema";
import { generateApiKey } from "@/lib/api-key-tokens";
import { API_KEY_SCOPES } from "@/lib/api-keys";
import {
	OperatorError,
	readString,
	expectObject,
	assertKnownFields,
	parseId,
} from "@/lib/operator-api";
import { normalizeEmail } from "@/lib/validation";

type Page = Readonly<{ limit: number; offset: number }>;
type SuppressionReason = "bounce" | "complaint" | "manual";

const KNOWN_SCOPES = new Set<string>(API_KEY_SCOPES);

// Explicit projection: hashes never enter public list, detail or mutation results.
const publicApiKeyColumns = {
	_id: apiKeys._id,
	name: apiKeys.name,
	prefix: apiKeys.prefix,
	scopes: apiKeys.scopes,
	developmentOnly: apiKeys.developmentOnly,
	expiresAt: apiKeys.expiresAt,
	lastUsedAt: apiKeys.lastUsedAt,
	revokedAt: apiKeys.revokedAt,
	createdAt: apiKeys.createdAt,
	updatedAt: apiKeys.updatedAt,
};

function validatePage(page: Page): Page {
	if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
		throw new OperatorError(400, "invalid_pagination", "limit must be an integer between 1 and 100");
	}
	if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
		throw new OperatorError(400, "invalid_pagination", "offset must be a nonnegative integer");
	}
	return page;
}

function readScopes(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > KNOWN_SCOPES.size) {
		throw new OperatorError(400, "invalid_scopes", "scopes must be an explicit, nonempty array of known scopes");
	}
	const scopes: string[] = [];
	for (const scope of value) {
		if (typeof scope !== "string" || !KNOWN_SCOPES.has(scope) || scopes.includes(scope)) {
			throw new OperatorError(400, "invalid_scopes", "scopes must contain unique, known scope names");
		}
		scopes.push(scope);
	}
	return scopes;
}

function assertCanGrantScopes(actor: unknown, scopes: readonly string[]): void {
	if (typeof actor !== "object" || actor === null || Array.isArray(actor)) {
		throw new OperatorError(403, "forbidden", "An authenticated operator is required to create an API key");
	}
	const identity = actor as { kind?: unknown; type?: unknown; scopes?: unknown };
	// A bearer discriminator takes precedence over a session discriminator, failing closed.
	if (identity.kind === "api-key" || identity.type === "api-key") {
		const ownScopes = identity.scopes;
		if (
			!Array.isArray(ownScopes) ||
			!ownScopes.every((scope) => typeof scope === "string" && KNOWN_SCOPES.has(scope)) ||
			(!ownScopes.includes("*") && scopes.some((scope) => !ownScopes.includes(scope)))
		) {
			throw new OperatorError(403, "scope_escalation", "An API key cannot grant scopes it does not have");
		}
		return;
	}
	if (
		identity.kind === "session" ||
		identity.type === "session" ||
		identity.kind === "development" ||
		identity.type === "development"
	) {
		return;
	}
	throw new OperatorError(403, "forbidden", "Unrecognized operator identity");
}

function readExpiry(value: unknown): Date | null {
	if (value === undefined || value === null) return null;
	const text = readString(value, "expiresAt", { required: true, max: 40 });
	const parts = typeof text === "string"
		? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(text)
		: null;
	if (!parts || !text) {
		throw new OperatorError(400, "invalid_expiry", "expiresAt must be a future ISO date-time with a timezone, or null");
	}
	// Date parsing can roll an invalid calendar day into the following month.
	const day = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00.000Z`);
	const expiry = new Date(text);
	if (
		!Number.isFinite(day.getTime()) ||
		day.getUTCFullYear() !== Number(parts[1]) ||
		day.getUTCMonth() + 1 !== Number(parts[2]) ||
		day.getUTCDate() !== Number(parts[3]) ||
		Number(parts[4]) > 23 ||
		Number(parts[5]) > 59 ||
		Number(parts[6]) > 59 ||
		!Number.isFinite(expiry.getTime()) ||
		expiry.getTime() <= Date.now()
	) {
		throw new OperatorError(400, "invalid_expiry", "expiresAt must be a valid future date-time, or null");
	}
	return expiry;
}

function readReason(value: unknown): SuppressionReason {
	if (value !== "bounce" && value !== "complaint" && value !== "manual") {
		throw new OperatorError(400, "invalid_reason", "reason must be bounce, complaint or manual");
	}
	return value;
}

function readEmail(value: unknown): string {
	const email = normalizeEmail(value);
	if (!email) throw new OperatorError(400, "invalid_email", "email must be a valid email address");
	return email;
}

export async function listApiKeys(page: Page) {
	const { limit, offset } = validatePage(page);
	await connectDb();
	return db.transaction((tx) => {
		const items = tx.select(publicApiKeyColumns).from(apiKeys)
			.orderBy(desc(apiKeys.createdAt), desc(apiKeys._id)).limit(limit).offset(offset).all();
		const total = tx.select({ value: count() }).from(apiKeys).get()?.value ?? 0;
		return { items, total, limit, offset };
	});
}

export async function getApiKey(id: string) {
	const keyId = parseId(id);
	await connectDb();
	const saved = db.select(publicApiKeyColumns).from(apiKeys).where(eq(apiKeys._id, keyId)).get();
	if (!saved) throw new OperatorError(404, "not_found", "API key not found");
	return saved;
}

export async function createApiKey(body: unknown, actor: unknown) {
	const input = expectObject(body);
	assertKnownFields(input, ["name", "scopes", "expiresAt"]);
	const name = readString(input.name, "name", { required: true, max: 60 });
	if (!name) throw new OperatorError(400, "invalid_name", "name is required");
	const scopes = readScopes(input.scopes);
	assertCanGrantScopes(actor, scopes);
	const expiresAt = readExpiry(input.expiresAt);
	const identity = actor as {
		kind?: string; type?: string; expiresAt?: Date | null;
		developmentOnly?: boolean; session?: { developmentOnly?: boolean };
	};
	const isBearer = identity.kind === "api-key" || identity.type === "api-key";
	if (isBearer && identity.expiresAt && (!expiresAt || expiresAt.getTime() > new Date(identity.expiresAt).getTime())) {
		throw new OperatorError(403, "expiry_escalation", "A delegated API key cannot outlive its issuing key");
	}
	// Development CLI issuance stays supported, but cannot mint production authority.
	// A missing issuer flag fails closed; a dev bearer cannot shed its provenance.
	const developmentOnly = process.env.NODE_ENV !== "production" || (isBearer
		? identity.developmentOnly !== false
		: identity.kind === "development" || identity.type === "development" || identity.session?.developmentOnly !== false);
	await connectDb();
	return db.transaction((tx) => {
		const now = new Date();
		if (expiresAt && expiresAt.getTime() <= now.getTime()) {
			throw new OperatorError(400, "invalid_expiry", "expiresAt must be in the future");
		}
		const { key, prefix, hash } = generateApiKey();
		const _id = randomBytes(12).toString("hex");
		tx.insert(apiKeys).values({
			_id, name, scopes, expiresAt, prefix, hash, developmentOnly,
			lastUsedAt: null, revokedAt: null, createdAt: now, updatedAt: now,
		}).run();
		const saved = tx.select(publicApiKeyColumns).from(apiKeys).where(eq(apiKeys._id, _id)).get();
		if (!saved) throw new OperatorError(500, "write_failed", "Could not read back the created API key");
		// This is the only operation that returns the plaintext token.
		return { ...saved, key };
	}, { behavior: "immediate" });
}

export async function revokeApiKey(id: string) {
	const keyId = parseId(id);
	await connectDb();
	return db.transaction((tx) => {
		const existing = tx.select(publicApiKeyColumns).from(apiKeys).where(eq(apiKeys._id, keyId)).get();
		if (!existing) throw new OperatorError(404, "not_found", "API key not found");
		if (!existing.revokedAt) {
			const now = new Date();
			tx.update(apiKeys).set({ revokedAt: now, updatedAt: now }).where(eq(apiKeys._id, keyId)).run();
		}
		const saved = tx.select(publicApiKeyColumns).from(apiKeys).where(eq(apiKeys._id, keyId)).get();
		if (!saved?.revokedAt) throw new OperatorError(500, "write_failed", "Could not read back the revoked API key");
		return saved;
	}, { behavior: "immediate" });
}

export async function listSuppressions(page: Page, params: URLSearchParams) {
	const { limit, offset } = validatePage(page);
	const filters: SQL[] = [];
	for (const field of ["email", "reason"]) {
		if (params.getAll(field).length > 1) {
			throw new OperatorError(400, "invalid_filter", `${field} may be specified only once`);
		}
	}
	if (params.has("email")) filters.push(eq(suppressions.email, readEmail(params.get("email"))));
	if (params.has("reason")) filters.push(eq(suppressions.reason, readReason(params.get("reason"))));
	const where = and(...filters);
	await connectDb();
	return db.transaction((tx) => {
		const items = tx.select().from(suppressions).where(where)
			.orderBy(desc(suppressions.createdAt), desc(suppressions._id)).limit(limit).offset(offset).all();
		const total = tx.select({ value: count() }).from(suppressions).where(where).get()?.value ?? 0;
		return { items, total, limit, offset };
	});
}

export async function getSuppression(id: string) {
	const suppressionId = parseId(id);
	await connectDb();
	const saved = db.select().from(suppressions).where(eq(suppressions._id, suppressionId)).get();
	if (!saved) throw new OperatorError(404, "not_found", "Suppression not found");
	return saved;
}

export async function addSuppression(body: unknown) {
	const input = expectObject(body);
	assertKnownFields(input, ["email", "reason", "detail"]);
	const email = readEmail(input.email);
	const reason = readReason(input.reason);
	const detail = readString(input.detail, "detail", { max: 2_000 });
	await connectDb();
	return db.transaction((tx) => {
		const now = new Date();
		const existing = tx.select().from(suppressions).where(eq(suppressions.email, email)).get();
		const severity: Record<SuppressionReason, number> = { manual: 0, bounce: 1, complaint: 2 };
		const savedReason = existing && severity[existing.reason] > severity[reason] ? existing.reason : reason;
		const _id = existing?._id ?? randomBytes(12).toString("hex");
		if (existing) {
			// A later manual suppression or bounce must not erase a complaint.
			tx.update(suppressions).set({
				reason: savedReason,
				...(savedReason === reason && detail !== undefined ? { detail } : {}),
				updatedAt: now,
			}).where(eq(suppressions._id, _id)).run();
		} else {
			tx.insert(suppressions).values({
				_id, email, reason, detail: detail ?? null, createdAt: now, updatedAt: now,
			}).run();
		}

		// The suppression is global. No newsletter condition belongs in these updates.
		// Only move toward a suppressed status; never downgrade a complaint or reactivate anyone.
		if (savedReason !== "manual") {
			const status = savedReason === "complaint" ? "complained" : "bounced";
			const eligible = savedReason === "complaint"
				? ["active", "pending", "dormant", "unsubscribed", "bounced"] as const
				: ["active", "pending", "dormant", "unsubscribed"] as const;
			const affected = and(eq(contacts.email, email), inArray(contacts.status, [...eligible]));
			tx.update(contacts).set({ status, updatedAt: now }).where(affected).run();
			const unchanged = tx.select({ _id: contacts._id }).from(contacts).where(affected).get();
			if (unchanged) throw new OperatorError(500, "write_failed", "Could not read back the suppressed contact statuses");
		}
		const saved = tx.select().from(suppressions).where(eq(suppressions._id, _id)).get();
		if (!saved) throw new OperatorError(500, "write_failed", "Could not read back the saved suppression");
		return { ...saved, created: !existing };
	}, { behavior: "immediate" });
}

export async function removeSuppression(id: string, body: unknown) {
	const suppressionId = parseId(id);
	const input = expectObject(body);
	assertKnownFields(input, ["confirm"]);
	if (input.confirm !== true) {
		throw new OperatorError(400, "confirmation_required", "Removing a suppression requires confirm: true");
	}
	await connectDb();
	return db.transaction((tx) => {
		const saved = tx.select().from(suppressions).where(eq(suppressions._id, suppressionId)).get();
		if (!saved) throw new OperatorError(404, "not_found", "Suppression not found");
		// Removing the global block is not consent to change any contact's status.
		tx.delete(suppressions).where(eq(suppressions._id, suppressionId)).run();
		const remaining = tx.select({ _id: suppressions._id }).from(suppressions)
			.where(eq(suppressions._id, suppressionId)).get();
		if (remaining) throw new OperatorError(500, "write_failed", "Could not read back the removed suppression");
		return { ...saved, removed: true as const };
	}, { behavior: "immediate" });
}
