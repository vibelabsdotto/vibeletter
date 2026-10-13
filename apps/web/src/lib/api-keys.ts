import "server-only";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { hashApiKey, readBearerToken, shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { getSession, type OperatorSession } from "@/lib/auth";
import { isDevelopmentLoginAllowed } from "@/lib/config";

export { generateApiKey, hashApiKey } from "@/lib/api-key-tokens";

export const API_KEY_SCOPES = [
  "*", "newsletters:read", "newsletters:write", "contacts:read", "contacts:write",
  "campaigns:read", "campaigns:write", "campaigns:send", "domains:read", "domains:write",
  "api-keys:read", "api-keys:write", "suppressions:read", "suppressions:write",
  "overview:read", "queue:read", "queue:write", "health:read", "uploads:write",
] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

type StoredApiKey = typeof apiKeys.$inferSelect;
export type ApiKeyIdentity = Omit<StoredApiKey, "hash"> & { kind: "api-key"; type: "api-key" };
export type SessionIdentity = OperatorSession & {
  kind: "session";
  type: "session";
  _id: string;
  name: string;
  scopes: string[];
};
export type OperatorIdentity = ApiKeyIdentity | SessionIdentity;

export function hasScope(identity: Pick<OperatorIdentity, "scopes">, scope: string): boolean {
  return Array.isArray(identity.scopes) &&
    (identity.scopes.includes("*") || identity.scopes.includes(scope));
}

function inferredScopes(request: Request): string[] {
  const resource = /^\/api\/v1\/([a-z-]+)(?:\/|$)/.exec(new URL(request.url).pathname)?.[1];
  if (!resource) return ["*"];
  return [`${resource}:${["GET", "HEAD"].includes(request.method) ? "read" : "write"}`];
}

export async function authenticateRequest(
  request: Request,
  requiredScopes?: string | readonly string[],
): Promise<OperatorIdentity | null> {
  const scopes = typeof requiredScopes === "string" ? [requiredScopes] : requiredScopes ?? inferredScopes(request);
  // A supplied credential is authoritative, even if malformed or revoked.
  // It must never fall through to cookies or a local development identity.
  if (request.headers.has("authorization")) {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) return null;
    await connectDb();
    const now = new Date();
    const stored = db.select().from(apiKeys).where(and(
      eq(apiKeys.hash, hashApiKey(token)),
      isNull(apiKeys.revokedAt),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
    )).get();
    if (!stored || !scopes.every((scope) => hasScope(stored, scope))) return null;
    // Persistent provenance survives database promotion and key delegation.
    // Unknown/legacy issuance is quarantined too, never inferred from its label.
    if (stored.developmentOnly !== false && !isDevelopmentLoginAllowed(request.headers, request.url)) return null;
    if (shouldTouchLastUsed(stored.lastUsedAt, now.getTime())) {
      db.update(apiKeys).set({ lastUsedAt: now }).where(and(
        eq(apiKeys._id, stored._id), isNull(apiKeys.revokedAt),
      )).run();
    }
    const { hash: _hash, ...publicKey } = stored;
    return { ...publicKey, kind: "api-key", type: "api-key" };
  }
  const session = await getSession(request.headers);
  if (!session) return null;
  return {
    ...session, kind: "session", type: "session", _id: session.user.id,
    name: session.user.name, scopes: ["*"],
  };
}
