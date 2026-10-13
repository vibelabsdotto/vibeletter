import "server-only";
import { NextResponse } from "next/server";
import { authenticateRequest, hasScope, type OperatorIdentity } from "@/lib/api-keys";

export class OperatorError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

export type OperatorPage = { limit: number; offset: number };
export type OperatorBody = Record<string, unknown>;
export const MAX_OPERATOR_BODY_BYTES = 2_000_000;

export function expectObject(body: unknown): OperatorBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorError(400, "invalid_body", "Send a JSON object");
  }
  return body as OperatorBody;
}

export function assertKnownFields(body: OperatorBody, fields: readonly string[]): void {
  const unknown = Object.keys(body).filter((field) => !fields.includes(field));
  if (unknown.length) throw new OperatorError(400, "unknown_field", `Unknown field: ${unknown[0]}`);
}

export function readString(value: unknown, field: string, options: { required?: boolean; max?: number; trim?: boolean } = {}): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new OperatorError(400, "invalid_field", `${field} must be a string`);
  const text = options.trim === false ? value : value.trim();
  if (options.required && !text) throw new OperatorError(400, "invalid_field", `${field} is required`);
  if (text.length > (options.max ?? 10_000)) throw new OperatorError(400, "invalid_field", `${field} is too long`);
  return text;
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new OperatorError(400, "invalid_field", `${field} must be a boolean`);
  return value;
}

export function readInteger(value: unknown, field: string, { min = 1, max = 1_000_000 }: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError(400, "invalid_field", `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function parseId(value: string): string {
  if (!/^[a-f0-9]{24}$/i.test(value)) throw new OperatorError(400, "invalid_id", "ID must contain exactly 24 hexadecimal characters");
  return value;
}

export function readDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new OperatorError(400, "invalid_date", `${field} must be an ISO date-time with timezone`);
  }
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new OperatorError(400, "invalid_date", `${field} must be a valid date`);
  }
  return date;
}

export function readPage(params: URLSearchParams): OperatorPage {
  function integer(name: string, fallback: number, min: number, max: number): number {
    if (params.getAll(name).length > 1) throw new OperatorError(400, "invalid_pagination", `${name} may be specified only once`);
    const text = params.get(name);
    if (text === null) return fallback;
    if (!/^\d+$/.test(text)) throw new OperatorError(400, "invalid_pagination", `${name} must be a nonnegative integer`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError(400, "invalid_pagination", `${name} must be between ${min} and ${max}`);
    return value;
  }
  return { limit: integer("limit", 50, 1, 100), offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER) };
}

export async function readBody(request: Request, { optional = false }: { optional?: boolean } = {}): Promise<OperatorBody> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_OPERATOR_BODY_BYTES)) {
    throw new OperatorError(413, "body_too_large", "Request body exceeds 2 MB");
  }
  if (!request.body) {
    if (optional) return {};
    throw new OperatorError(400, "invalid_body", "Send a JSON object");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OPERATOR_BODY_BYTES) {
        await reader.cancel();
        throw new OperatorError(413, "body_too_large", "Request body exceeds 2 MB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!bytes && optional) return {};
  if (!(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase().match(/^application\/(?:json|[a-z0-9.+-]+\+json)$/)) {
    throw new OperatorError(415, "unsupported_media_type", "Use Content-Type: application/json");
  }
  try { return expectObject(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError(400, "invalid_json", "Invalid JSON body");
  }
}

function configuredAppOrigin(): string {
  try {
    const url = new URL(process.env.APP_URL ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash ||
        (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("Invalid origin");
    return url.origin;
  } catch {
    throw new OperatorError(503, "invalid_configuration", "APP_URL must be a valid public HTTP(S) origin, with HTTPS in production");
  }
}

export async function requireOperator(request: Request, scopes: string | readonly string[]): Promise<OperatorIdentity> {
  // Authenticate first without scope filtering so missing permissions return 403, not 401.
  const actor = await authenticateRequest(request, []);
  if (!actor) throw new OperatorError(401, "unauthorized", "A valid operator session or bearer token is required");
  const required = typeof scopes === "string" ? [scopes] : scopes;
  if (!required.every((scope) => hasScope(actor, scope))) throw new OperatorError(403, "forbidden", "The token does not have the required scope");
  if (actor.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    // The internal HTTP URL behind TLS termination is not the browser's public origin.
    // Only configured APP_URL is trusted, never forwarding headers supplied by the caller.
    const expectedOrigin = configuredAppOrigin();
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== expectedOrigin) throw new OperatorError(403, "invalid_origin", "Cross-origin session writes are not permitted");
  }
  return actor;
}

export function jsonResult(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof OperatorError) return jsonResult({ error: error.message, code: error.code }, error.status);
  if (error instanceof Error && /^(?:Database (?:is not migrated|has pending or mismatched migrations)|Queue database is not ready)/.test(error.message)) {
    return jsonResult({ error: "Database or queue migrations are required before this operation", code: "service_not_ready" }, 503);
  }
  const failure = error as { code?: string; cause?: { code?: string } } | null;
  const code = failure?.code ?? failure?.cause?.code;
  if (code?.startsWith("SQLITE_CONSTRAINT")) return jsonResult({ error: "The request conflicts with an existing record or relation", code: "conflict" }, 409);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return jsonResult({ error: "The database is busy; retry later", code: "database_busy" }, 503);
  console.error("[operator-api] Request failed", error instanceof Error ? error.name : "UnknownError");
  return jsonResult({ error: "The operation could not be completed", code: "internal_error" }, 500);
}
