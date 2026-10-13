import { handleSesEvent } from "@/lib/ses-events";
import { isValidSubscribeUrl, verifySnsMessage } from "@/lib/sns";
import { isPlainObject } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 512 * 1024;

type Envelope = Record<string, unknown>;
class BodyError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}
function reply(status: number, body: Record<string, unknown>): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function parseJson(value: string): unknown {
	try { return JSON.parse(value) as unknown; } catch { return null; }
}
async function readBody(request: Request): Promise<string> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) throw new BodyError("Body is too large", 413);
	if (!request.body) throw new BodyError("Invalid JSON", 400);
	const reader = request.body.getReader();
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
	let rejectAbort: (reason: BodyError) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const onAbort = () => rejectAbort(new BodyError("Request body was interrupted", 408));
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let completed = false;
	try {
		while (true) {
			const chunk = await Promise.race([reader.read(), aborted]);
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_BODY_BYTES) throw new BodyError("Body is too large", 413);
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		completed = true;
		try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { throw new BodyError("Invalid UTF-8", 400); }
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (!completed) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
async function confirmSubscription(message: Envelope): Promise<Response> {
	if (!isValidSubscribeUrl(message.SubscribeURL)) return reply(400, { error: "Invalid SubscribeURL" });
	const url = new URL(message.SubscribeURL as string);
	// Do not allow the signed confirmation to perform another SNS operation or confirm another topic.
	if (url.pathname !== "/" || url.hash || url.searchParams.get("Action") !== "ConfirmSubscription" ||
		url.searchParams.get("TopicArn") !== message.TopicArn || url.searchParams.get("Token") !== message.Token) {
		return reply(400, { error: "Invalid SubscribeURL" });
	}
	const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => null);
	if (!response?.ok) return reply(502, { error: "Subscription confirmation failed" });
	await response.body?.cancel().catch(() => {});
	return reply(200, { ok: true });
}
async function handleNotification(message: Envelope): Promise<Response> {
	const sesEvent = typeof message.Message === "string" ? parseJson(message.Message) : null;
	if (!isPlainObject(sesEvent)) return reply(200, { ok: true, ignored: true });
	try {
		const { handled } = await handleSesEvent(sesEvent as Record<string, unknown>, { notificationId: message.MessageId as string });
		return reply(200, { ok: true, ...(!handled && { ignored: true }) });
	} catch {
		// The event receipt and all feedback writes roll back together for a safe SNS retry.
		// Never log recipient data or credentials.
		console.error("[ses-webhook] Could not handle the event");
		return reply(500, { error: "Could not handle the event" });
	}
}

// Raw delivery must be disabled: only the SNS envelope is signed.
export async function POST(request: Request): Promise<Response> {
	const topicArn = process.env.SES_SNS_TOPIC_ARN;
	if (!topicArn) return reply(503, { error: "SES webhook is not configured" });
	let body: string;
	try { body = await readBody(request); }
	catch (error) { return reply(error instanceof BodyError ? error.status : 400, { error: error instanceof BodyError ? error.message : "Could not read body" }); }
	const parsed = parseJson(body);
	if (!isPlainObject(parsed)) return reply(400, { error: "Invalid JSON" });
	const message = parsed as Envelope;
	if (message.TopicArn !== topicArn) return reply(403, { error: "Unknown topic" });
	if (!(await verifySnsMessage(message))) return reply(400, { error: "Invalid signature" });
	// AWS may legitimately redeliver old signed notifications. Persisted first-claims,
	// not a timestamp cutoff, prevent feedback side effects from being replayed.
	if (message.Type === "SubscriptionConfirmation") return confirmSubscription(message);
	if (message.Type === "Notification") return handleNotification(message);
	return reply(200, { ok: true });
}
