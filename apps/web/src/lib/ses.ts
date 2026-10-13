import "server-only";
import {
	GetAccountCommand, GetEmailIdentityCommand, ListEmailIdentitiesCommand,
	SESv2Client, SendEmailCommand,
	type GetEmailIdentityCommandOutput,
} from "@aws-sdk/client-sesv2";
import { getSendingConfigProblems, isSendingEnabled } from "@/lib/config";

const CACHE_TTL_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 30_000;

export type SesAccount = {
	productionAccess: boolean; reviewStatus: string | null; sendingEnabled: boolean;
	enforcementStatus: string | undefined; max24HourSend: number; maxSendRate: number; sentLast24Hours: number;
};
export type SesDomain = {
	domain: string; verified: boolean; dkimStatus: string; mailFromDomain: string | null; mailFromStatus: string | null;
	records: { type: string; name: string; value: string }[];
};
export type SesError = { error: string };
export type SesEmail = {
	from: string; to: string; replyTo?: string | null; subject: string; html: string; text: string;
	headers?: Record<string, string>; tags?: { name: string; value: string }[];
};

type CacheEntry = { promise: Promise<unknown>; expiresAt: number };
const cache = new Map<string, CacheEntry>();
let readClient: SESv2Client | undefined;
let sendClient: SESv2Client | undefined;

function region(): string {
	return process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
}

function clientOptions(maxAttempts: number) {
	const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey, SES_SESSION_TOKEN: sessionToken } = process.env;
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey) || (sessionToken && !accessKeyId)) {
		throw new Error("Configure both SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY, or use the AWS default credential chain");
	}
	return {
		region: region(), maxAttempts,
		// Omitting credentials preserves AWS profiles, workload roles and the default chain.
		...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } } : {}),
	};
}

// Exposed for the domain service. Only reads and explicit identity-management operations use this client.
export function getSesClient(): SESv2Client {
	readClient ??= new SESv2Client(clientOptions(3));
	return readClient;
}

function getSendClient(): SESv2Client {
	// A timed-out send may already have reached SES. Never let the SDK replay it.
	sendClient ??= new SESv2Client(clientOptions(1));
	return sendClient;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "SES request failed";
}

async function cached<T>(key: string, fresh: boolean, load: () => Promise<T | SesError>): Promise<T | SesError> {
	const hit = cache.get(key);
	if (!fresh && hit && hit.expiresAt > Date.now()) return hit.promise as Promise<T | SesError>;
	const entry: CacheEntry = { promise: load(), expiresAt: Date.now() + CACHE_TTL_MS };
	cache.set(key, entry);
	try {
		const value = await entry.promise as T | SesError;
		if ("error" in (value as object) && cache.get(key) === entry) cache.delete(key);
		return value;
	} catch (error) {
		if (cache.get(key) === entry) cache.delete(key);
		throw error;
	}
}

export function getSesAccount({ fresh = false }: { fresh?: boolean } = {}): Promise<SesAccount | SesError> {
	return cached("account", fresh, async () => {
		try {
			const account = await getSesClient().send(new GetAccountCommand({}), { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
			return {
				productionAccess: Boolean(account.ProductionAccessEnabled),
				reviewStatus: account.Details?.ReviewDetails?.Status || null,
				sendingEnabled: Boolean(account.SendingEnabled), enforcementStatus: account.EnforcementStatus,
				max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
				maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
				sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
			};
		} catch (error) { return { error: errorMessage(error) }; }
	});
}

function dnsRecords(domain: string, identity: GetEmailIdentityCommandOutput): SesDomain["records"] {
	const dkim = (identity.DkimAttributes?.Tokens || []).map((token) => ({
		type: "CNAME", name: `${token}._domainkey.${domain}`, value: `${token}.${identity.DkimAttributes?.SigningHostedZone || "dkim.amazonses.com"}`,
	}));
	const mailFrom = identity.MailFromAttributes?.MailFromDomain;
	return [...dkim, ...(mailFrom ? [
		{ type: "MX", name: mailFrom, value: `10 feedback-smtp.${region()}.amazonses.com` },
		{ type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
	] : [])];
}

export function listSesDomains({ fresh = false }: { fresh?: boolean } = {}): Promise<SesDomain[] | SesError> {
	return cached("domains", fresh, async () => {
		try {
			const domains: SesDomain[] = [];
			let nextToken: string | undefined;
			const seenTokens = new Set<string>();
			do {
				const page = await getSesClient().send(new ListEmailIdentitiesCommand({ PageSize: 100, NextToken: nextToken }), { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
				for (const item of page.EmailIdentities ?? []) {
					if (item.IdentityType !== "DOMAIN" || !item.IdentityName) continue;
					const domain = item.IdentityName;
					const identity = await getSesClient().send(new GetEmailIdentityCommand({ EmailIdentity: domain }), { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
					domains.push({ domain, verified: Boolean(identity.VerifiedForSendingStatus),
						dkimStatus: identity.DkimAttributes?.Status || "NOT_STARTED",
						mailFromDomain: identity.MailFromAttributes?.MailFromDomain || null,
						mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus || null,
						records: dnsRecords(domain, identity) });
				}
				nextToken = page.NextToken;
				if (nextToken && seenTokens.has(nextToken)) throw new Error("SES returned a repeated pagination token");
				if (nextToken) seenTokens.add(nextToken);
			} while (nextToken);
			return domains;
		} catch (error) { return { error: errorMessage(error) }; }
	});
}

export async function sendSesEmail({ from, to, replyTo, subject, html, text, headers = {}, tags = [] }: SesEmail): Promise<{ sesMessageId: string }> {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	const problems = getSendingConfigProblems();
	if (problems.length) {
		const error = new Error(`Sending is blocked. ${problems.join(" ")}`);
		// No request reached SES. The sender may safely record this as a definite local rejection.
		error.name = "ValidationException";
		throw error;
	}
	const result = await getSendClient().send(new SendEmailCommand({
		FromEmailAddress: from, Destination: { ToAddresses: [to] },
		ReplyToAddresses: replyTo ? [replyTo] : undefined,
		ConfigurationSetName: process.env.SES_CONFIGURATION_SET,
		EmailTags: tags.map(({ name, value }) => ({ Name: name, Value: value })),
		Content: { Simple: {
			Subject: { Data: subject, Charset: "UTF-8" },
			Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
			Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
		} },
	}), { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
	if (!result.MessageId) throw new Error("SES did not acknowledge a message ID; delivery outcome is unknown");
	return { sesMessageId: result.MessageId };
}
