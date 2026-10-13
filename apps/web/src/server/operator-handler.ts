import "server-only";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { assertKnownFields, errorResponse, jsonResult, OperatorError, parseId, readBody, readPage, readString, requireOperator, type OperatorBody, type OperatorPage } from "@/lib/operator-api";
import { createNewsletter, getNewsletter, listNewsletters, updateNewsletter, deleteNewsletter, createContact, getContact, listContacts, updateContact, deleteContact, setContactStatus, importContacts, readEmail } from "@/lib/operator-services";
import { campaignAction, createCampaign, deleteCampaign, getCampaign, listCampaigns, previewCampaign, reportCampaign, updateCampaign } from "@/server/operator-campaigns";
import { createDomain, getDomain, listDomains, verifyDomain } from "@/server/operator-domains";
import { addSuppression, createApiKey, getApiKey, getSuppression, listApiKeys, listSuppressions, removeSuppression, revokeApiKey } from "@/server/operator-security";
import { operatorHealth, operatorOverview, publicReadiness } from "@/server/operator-overview";
import { isSendingEnabled } from "@/lib/config";
import { queueConfirmationEmail, queueWelcomeEmail, sendWelcomeTestEmail } from "@/lib/sending";
import { isRateLimited } from "@/lib/rate-limit";
import { POST as uploadImage } from "@/app/api/uploads/route";
import type { OperatorIdentity } from "@/lib/api-keys";
import { QueueOperationError } from "@/queue";
import { getSesAccount } from "@/lib/ses";

function methodNotAllowed(allowed: readonly string[]): never {
  throw new OperatorError(405, "method_not_allowed", `Allowed methods: ${allowed.join(", ")}`);
}
function requireMethod(method: string, allowed: readonly string[]): void {
  if (!allowed.includes(method)) methodNotAllowed(allowed);
}
function noExtraBody(body: OperatorBody): void { assertKnownFields(body, []); }
async function rateLimit(actor: OperatorIdentity, name: string, limit: number, window = "1 h") {
  if (await isRateLimited({ name, key: actor._id, limit, window })) throw new OperatorError(429, "rate_limited", "Too many requests; try again later");
}

function csvExport(items: Awaited<ReturnType<typeof listContacts>>["items"]): string {
  const columns = ["_id", "newsletterId", "email", "status", "source", "subscribedAt", "confirmedAt", "unsubscribedAt"] as const;
  function cell(value: unknown): string {
    let text = value instanceof Date ? value.toISOString() : String(value ?? "");
    // CSV consumers often open exports in a spreadsheet. Do not permit formula evaluation.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  return [columns.join(","), ...items.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n") + "\r\n";
}

async function queueRequest(method: string, parts: string[], request: Request, page: OperatorPage, params: URLSearchParams) {
  const id = parts[1];
  const operation = parts[2];
  if (!id) {
    requireMethod(method, ["GET"]);
    const { listJobs } = await import("@/queue");
    const status = params.get("status");
    if (params.has("campaignId")) throw new OperatorError(400, "unsupported_filter", "Queue filtering by campaignId is not supported");
    if (status !== null && !["pending", "pending_retry", "running", "failed", "dead-letter"].includes(status)) throw new OperatorError(400, "invalid_status", "Unknown queue status");
    return jsonResult(await listJobs({ ...page, status: (status ?? undefined) as "pending" | "pending_retry" | "running" | "failed" | "dead-letter" | undefined }));
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new OperatorError(400, "invalid_job_id", "Invalid queue job ID");
  if (!operation) {
    requireMethod(method, ["GET"]);
    const { getJob } = await import("@/queue");
    const job = await getJob(id);
    if (!job) throw new OperatorError(404, "not_found", "Queue job not found");
    return jsonResult(job);
  }
  requireMethod(method, ["POST"]);
  noExtraBody(await readBody(request, { optional: true }));
  if (operation === "retry") {
    const { retryJob } = await import("@/queue");
    return jsonResult(await retryJob(id));
  }
  if (operation === "cancel") {
    const { cancelJob } = await import("@/queue");
    return jsonResult(await cancelJob(id));
  }
  throw new OperatorError(404, "not_found", "Queue operation not found");
}

async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const [resource, id, subresource] = parts;
  const method = request.method.toUpperCase();
  const reads = method === "GET" || method === "HEAD";
  const resources = ["health", "overview", "newsletters", "contacts", "campaigns", "domains", "api-keys", "suppressions", "queue", "uploads"];
  if (!resources.includes(resource) || parts.length > 3) {
    await requireOperator(request, []);
    throw new OperatorError(404, "not_found", "API route not found");
  }
  // Public readiness deliberately exposes no identities, account quotas or filesystem paths.
  if (resource === "health" && parts.length === 1 && (method === "GET" || method === "HEAD")) {
    const readiness = await publicReadiness();
    return jsonResult(readiness, readiness.ok ? 200 : 503);
  }
  // Action requests authenticate before reading any body. A read-only key may use cleanup-preview.
  const actor = await requireOperator(request, (resource === "campaigns" || resource === "newsletters") && subresource === "actions" ? [] : `${resource}:${reads ? "read" : "write"}`);
  await rateLimit(actor, reads ? "operator-read" : "operator-write", reads ? 1200 : 600);
  const page = readPage(url.searchParams);
  if (resource === "uploads") {
    if (parts.length !== 1) throw new OperatorError(404, "not_found", "Upload route not found");
    requireMethod(method, ["POST"]);
    return uploadImage(request);
  }
  if (resource === "health" || resource === "overview") {
    if ((resource === "overview" && parts.length !== 1) || (resource === "health" && (parts.length !== 2 || id !== "details"))) throw new OperatorError(404, "not_found", "API route not found");
    requireMethod(method, ["GET"]);
    return jsonResult(resource === "health" ? await operatorHealth() : await operatorOverview(url.searchParams));
  }
  if (resource === "queue") return queueRequest(method, parts, request, page, url.searchParams);
  if (resource === "domains" && id === "account" && !subresource) {
    requireMethod(method, ["GET"]);
    const account = await getSesAccount({ fresh: true });
    if ("error" in account) throw new OperatorError(503, "ses_unavailable", "SES account information is unavailable; check server region, credentials and IAM permissions");
    return jsonResult(account);
  }
  if (resource === "contacts" && id === "import" && !subresource) {
    requireMethod(method, ["POST"]);
    return jsonResult(await importContacts(await readBody(request)));
  }
  if (resource === "contacts" && id === "export" && !subresource) {
    requireMethod(method, ["GET"]);
    const format = url.searchParams.get("format") ?? "csv";
    if (format !== "json" && format !== "csv") throw new OperatorError(400, "invalid_format", "Export format must be csv or json");
    const result = await listContacts(page, url.searchParams);
    if (format === "json") return jsonResult(result);
    return new Response(csvExport(result.items), { status: 200, headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=contacts.csv", "Cache-Control": "no-store",
      "X-Total-Count": String(result.total), "X-Limit": String(result.limit), "X-Offset": String(result.offset),
    } });
  }
  if (resource === "newsletters" && subresource === "actions") {
    requireMethod(method, ["POST"]);
    await requireOperator(request, ["newsletters:read", "campaigns:send"]);
    const body = await readBody(request); assertKnownFields(body, ["action", "to"]);
    if (body.action !== "welcome-test") throw new OperatorError(400, "invalid_action", "Unknown newsletter action");
    const newsletter = await getNewsletter(parseId(id));
    if (!isSendingEnabled()) throw new OperatorError(503, "sending_disabled", "Sending is disabled");
    await rateLimit(actor, "operator-test-send", 20);
    const result = await sendWelcomeTestEmail({ newsletterId: newsletter._id, to: readEmail(body.to ?? process.env.ADMIN_EMAIL, "to") });
    return jsonResult({ newsletter: await getNewsletter(newsletter._id), result: result ?? null });
  }
  if (resource === "contacts" && subresource === "status") {
    requireMethod(method, ["POST"]);
    return jsonResult(await setContactStatus(parseId(id), await readBody(request)));
  }
  if (resource === "campaigns" && subresource === "preview") {
    requireMethod(method, ["GET"]); return jsonResult(await previewCampaign(parseId(id)));
  }
  if (resource === "campaigns" && subresource === "report") {
    requireMethod(method, ["GET"]); return jsonResult(await reportCampaign(parseId(id), page));
  }
  if (resource === "campaigns" && subresource === "actions") {
    requireMethod(method, ["POST"]);
    const body = await readBody(request);
    const action = readString(body.action, "action", { required: true, max: 40 });
    const scope = action === "cleanup-preview" ? "campaigns:read" : ["send", "test", "schedule", "resume", "send-more"].includes(action!) ? "campaigns:send" : "campaigns:write";
    await requireOperator(request, scope);
    if (scope === "campaigns:send") await rateLimit(actor, "operator-campaign-send", 20);
    const result = await campaignAction(parseId(id), body);
    if (action !== "cleanup-preview") revalidatePath("/", "layout");
    return jsonResult(result, action === "duplicate" ? 201 : 200);
  }
  if (resource === "domains" && subresource === "dns") {
    requireMethod(method, ["GET"]);
    const result = await getDomain(id);
    return jsonResult({ domain: result.domain, records: result.records, region: result.region });
  }
  if (resource === "domains" && subresource === "verify") {
    requireMethod(method, ["POST"]); return jsonResult(await verifyDomain(id, await readBody(request, { optional: true })));
  }
  if (resource === "api-keys" && subresource === "revoke") {
    requireMethod(method, ["POST"]); noExtraBody(await readBody(request, { optional: true })); return jsonResult(await revokeApiKey(parseId(id)));
  }
  if (subresource) throw new OperatorError(404, "not_found", "API route not found");
  if (!id) {
    requireMethod(method, ["GET", "POST"]);
    if (method === "GET") {
      switch (resource) {
        case "newsletters": return jsonResult(await listNewsletters(page));
        case "contacts": return jsonResult(await listContacts(page, url.searchParams));
        case "campaigns": return jsonResult(await listCampaigns(page, url.searchParams));
        case "domains": return jsonResult(await listDomains(page));
        case "api-keys": return jsonResult(await listApiKeys(page));
        case "suppressions": return jsonResult(await listSuppressions(page, url.searchParams));
      }
    }
    const body = await readBody(request);
    let result: unknown;
    let status = 201;
    switch (resource) {
      case "newsletters": result = await createNewsletter(body); break;
      case "contacts": {
        await rateLimit(actor, "api-contacts-key", 600);
        if (typeof body.ip === "string" && /^[0-9a-f.:]{3,45}$/i.test(body.ip) && await isRateLimited({ name: "api-contacts-ip", key: `${actor._id}:${body.ip}`, limit: 5, window: "10 m" })) throw new OperatorError(429, "rate_limited", "Too many signups from this visitor");
        const contact = await createContact(body);
        status = contact.created ? 201 : 200; result = contact;
        if (isSendingEnabled() && (contact.status === "pending" || (contact.created && contact.status === "active"))) {
          const newsletter = await getNewsletter(contact.newsletterId);
          after(async () => {
            try { await (contact.status === "pending" ? queueConfirmationEmail : queueWelcomeEmail)({ newsletter, contact }); }
            catch { console.error("[operator-api] Signup email enqueue failed"); }
          });
        }
        break;
      }
      case "campaigns": await rateLimit(actor, "api-campaigns-create", 20); result = await createCampaign(body); break;
      case "domains": result = await createDomain(body); break;
      case "api-keys": result = await createApiKey(body, actor); break;
      case "suppressions": {
        const saved = await addSuppression(body); result = saved; status = saved.created ? 201 : 200; break;
      }
    }
    revalidatePath("/", "layout");
    return jsonResult(result, status);
  }
  requireMethod(method, resource === "domains" ? ["GET"] : ["GET", "PATCH", "DELETE"]);
  if (resource === "domains") return jsonResult(await getDomain(id));
  const recordId = parseId(id);
  if (method === "GET") {
    switch (resource) {
      case "newsletters": return jsonResult(await getNewsletter(recordId));
      case "contacts": return jsonResult(await getContact(recordId));
      case "campaigns": return jsonResult(await getCampaign(recordId));
      case "api-keys": return jsonResult(await getApiKey(recordId));
      case "suppressions": return jsonResult(await getSuppression(recordId));
    }
  }
  const body = await readBody(request, { optional: resource === "api-keys" && method === "DELETE" });
  let result: unknown;
  if (method === "PATCH") {
    switch (resource) {
      case "newsletters": result = await updateNewsletter(recordId, body); break;
      case "contacts": result = await updateContact(recordId, body); break;
      case "campaigns": result = await updateCampaign(recordId, body); break;
      default: methodNotAllowed(["GET", "DELETE"]);
    }
  } else {
    switch (resource) {
      case "newsletters": result = await deleteNewsletter(recordId, body); break;
      case "contacts": result = await deleteContact(recordId, body); break;
      case "campaigns": result = await deleteCampaign(recordId, body); break;
      case "api-keys": noExtraBody(body); result = await revokeApiKey(recordId); break;
      case "suppressions": result = await removeSuppression(recordId, body); break;
    }
  }
  revalidatePath("/", "layout");
  return jsonResult(result);
}

export async function operatorHandler(request: Request): Promise<Response> {
  try { return await dispatch(request); }
  catch (error) {
    if (error instanceof QueueOperationError) return errorResponse(new OperatorError(error.statusCode, "queue_operation_failed", error.message));
    return errorResponse(error);
  }
}
