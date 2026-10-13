import "server-only";
import {
	CreateEmailIdentityCommand,
	GetEmailIdentityCommand,
	ListEmailIdentitiesCommand,
	PutEmailIdentityDkimAttributesCommand,
	PutEmailIdentityDkimSigningAttributesCommand,
	PutEmailIdentityMailFromAttributesCommand,
	SESv2Client,
	type GetEmailIdentityCommandOutput,
} from "@aws-sdk/client-sesv2";
import { OperatorError, expectObject, assertKnownFields, readString } from "@/lib/operator-api";

const OPERATION_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_PAGE_LIMIT = 100;
const DETAIL_CONCURRENCY = 5;

export interface DomainDnsRecord {
	type: "CNAME" | "MX" | "TXT";
	name: string;
	value: string;
}

export interface DomainDetail {
	domain: string;
	verified: boolean;
	verificationStatus: string | null;
	dkimStatus: string | null;
	mailFromDomain: string | null;
	mailFromStatus: string | null;
	records: DomainDnsRecord[];
	region: string;
}

interface SesOperation {
	client: SESv2Client;
	region: string;
	signal: AbortSignal;
}

/** Validate a literal ASCII hostname. No URL parsing, trimming or implicit IDN conversion. */
export function validateDomain(value: unknown, field = "domain"): string {
	const domain: string | undefined = readString(value, field, { required: true, max: 253, trim: false });
	const labels = domain?.split(".") ?? [];
	if (
		!domain ||
		/[^a-z0-9.-]/i.test(domain) ||
		labels.length < 2 ||
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
		!/[a-z]/i.test(labels[labels.length - 1])
	) {
		throw new OperatorError(400, "invalid_domain", `${field} must be a hostname, without a scheme, port, path, trailing dot or IP address.`);
	}
	return domain;
}

function readMailFromDomain(body: Record<string, unknown>, domain: string): string | undefined {
	if (!Object.hasOwn(body, "mailFromDomain")) return undefined;
	const mailFrom = validateDomain(body.mailFromDomain, "mailFromDomain");
	// DNS is case-insensitive; comparison must not change the literal identity sent to AWS.
	if (!mailFrom.toLowerCase().endsWith(`.${domain.toLowerCase()}`)) {
		throw new OperatorError(400, "invalid_mail_from_domain", "mailFromDomain must be a child subdomain of domain, not the identity itself.");
	}
	return mailFrom;
}

function mapAwsError(error: unknown, writing: boolean): OperatorError {
	if (error instanceof OperatorError) return error;
	const failure = error && typeof error === "object"
		? error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } }
		: {};
	const name = failure.name ?? "";
	const status = failure.$metadata?.httpStatusCode;
	const writeNotice = writing ? " A change may already have been applied; read the domain before retrying." : "";
	if (name === "NotFoundException" || status === 404) {
		return new OperatorError(404, "ses_not_found", "The SES identity or referenced configuration set was not found.");
	}
	if (["AlreadyExistsException", "ConflictException"].includes(name) || status === 409) {
		return new OperatorError(409, "ses_conflict", "The SES identity already exists or the operation conflicts with its current state.");
	}
	if (["TooManyRequestsException", "ThrottlingException", "Throttling", "LimitExceededException"].includes(name) || status === 429) {
		return new OperatorError(429, "ses_rate_limited", `SES rejected the request because of a rate or resource limit.${writeNotice}`);
	}
	if (
		["AbortError", "TimeoutError", "RequestTimeout", "RequestTimeoutException", "CredentialsProviderError", "TokenProviderError", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException", "AccessDeniedException", "ServiceUnavailableException"].includes(name) ||
		["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(failure.code ?? "") ||
		status === 401 || status === 403 || status === 503 || status === 504
	) {
		return new OperatorError(503, "ses_unavailable", `SES is unavailable. Check the server's region, credentials and IAM permissions.${writeNotice}`);
	}
	// Never return AWS exception messages, request bodies, credential errors or stacks.
	return new OperatorError(502, "ses_upstream_error", `SES could not complete the request.${writeNotice}`);
}

async function withSes<T>(writing: boolean, run: (operation: SesOperation) => Promise<T>): Promise<T> {
	const region = process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
	const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey, SES_SESSION_TOKEN: sessionToken } = process.env;
	const controller = new AbortController();
	let client: SESv2Client | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		client = new SESv2Client({
			region,
			...(accessKeyId && secretAccessKey ? {
				credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
			} : {}),
			// In particular, do not automatically replay a mutation after an uncertain timeout.
			maxAttempts: 1,
			requestHandler: { connectionTimeout: 2_000, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true },
		});
		const operation = { client, region, signal: controller.signal };
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new OperatorError(503, "ses_timeout", `SES did not complete the operation within 30 seconds.${writing ? " A change may already have been applied; read the domain before retrying." : ""}`));
			}, OPERATION_TIMEOUT_MS);
		});
		// The race also bounds credential discovery, which may not honor the HTTP abort signal.
		return await Promise.race([run(operation), deadline]);
	} catch (error) {
		throw mapAwsError(error, writing);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		controller.abort();
		client?.destroy();
	}
}

async function readIdentity(operation: SesOperation, domain: string): Promise<GetEmailIdentityCommandOutput> {
	const identity = await operation.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }), { abortSignal: operation.signal });
	if (identity.IdentityType !== "DOMAIN") {
		throw new OperatorError(identity.IdentityType ? 404 : 502, identity.IdentityType ? "domain_not_found" : "ses_invalid_response", "SES did not return a domain identity.");
	}
	return identity;
}

function detail(domain: string, identity: GetEmailIdentityCommandOutput, region: string): DomainDetail {
	const dkim = identity.DkimAttributes;
	// GetEmailIdentity does not expose the public key for BYODKIM. Do not invent CNAMEs for it.
	const records: DomainDnsRecord[] = dkim?.SigningAttributesOrigin === "EXTERNAL" ? [] : (dkim?.Tokens ?? []).map((token) => ({
		type: "CNAME",
		name: `${token}._domainkey.${domain}`,
		value: `${token}.${dkim?.SigningHostedZone || "dkim.amazonses.com"}`,
	}));
	const mailFromDomain = identity.MailFromAttributes?.MailFromDomain ?? null;
	if (mailFromDomain) {
		records.push(
			{ type: "MX", name: mailFromDomain, value: `10 feedback-smtp.${region}.amazonses.com` },
			{ type: "TXT", name: mailFromDomain, value: "v=spf1 include:amazonses.com ~all" },
		);
	}
	return {
		domain,
		verified: identity.VerifiedForSendingStatus === true,
		verificationStatus: identity.VerificationStatus ?? null,
		dkimStatus: dkim?.Status ?? null,
		mailFromDomain,
		mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus ?? null,
		records,
		region,
	};
}

export async function listDomains(page: { limit: number; offset: number }): Promise<{ items: DomainDetail[]; total: number; limit: number; offset: number }> {
	const { limit, offset } = page;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
		throw new OperatorError(400, "invalid_pagination", "limit must be an integer from 1 to 100 and offset must be a nonnegative safe integer.");
	}
	return withSes(false, async (operation) => {
		const domains = new Map<string, string>();
		const tokens = new Set<string>();
		let nextToken: string | undefined;
		do {
			const response = await operation.client.send(new ListEmailIdentitiesCommand({ PageSize: 1_000, ...(nextToken ? { NextToken: nextToken } : {}) }), { abortSignal: operation.signal });
			for (const identity of response.EmailIdentities ?? []) {
				if (identity.IdentityType !== "DOMAIN") continue;
				if (!identity.IdentityName) throw new OperatorError(502, "ses_invalid_response", "SES returned a domain without an identity name.");
				if (!domains.has(identity.IdentityName.toLowerCase())) domains.set(identity.IdentityName.toLowerCase(), identity.IdentityName);
			}
			nextToken = response.NextToken || undefined;
			if (nextToken) {
				if (tokens.has(nextToken)) throw new OperatorError(502, "ses_invalid_pagination", "SES repeated a pagination token; a complete domain list could not be read.");
				tokens.add(nextToken);
			}
		} while (nextToken);

		// Enumerate every AWS page before computing total or applying the operator's slice.
		const names = [...domains.values()].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
		const selected = names.slice(offset, offset + limit);
		const items: DomainDetail[] = [];
		for (let start = 0; start < selected.length; start += DETAIL_CONCURRENCY) {
			items.push(...await Promise.all(selected.slice(start, start + DETAIL_CONCURRENCY).map(async (domain) => detail(domain, await readIdentity(operation, domain), operation.region))));
		}
		return { items, total: names.length, limit, offset };
	});
}

/** GET is a fresh AWS read only, including when verification has failed. */
export async function getDomain(domain: string): Promise<DomainDetail> {
	const validated = validateDomain(domain);
	return withSes(false, async (operation) => detail(validated, await readIdentity(operation, validated), operation.region));
}

export async function createDomain(body: Record<string, unknown>): Promise<DomainDetail> {
	const input = expectObject(body);
	assertKnownFields(input, ["domain", "mailFromDomain", "configurationSetName"]);
	const domain = validateDomain(input.domain);
	const mailFromDomain = readMailFromDomain(input, domain);
	const configurationSetName = Object.hasOwn(input, "configurationSetName")
		? readString(input.configurationSetName, "configurationSetName", { required: true, max: 64, trim: false })
		: undefined;
	if (configurationSetName !== undefined && (!/^[a-z0-9_-]{1,64}$/i.test(configurationSetName) || /[^a-z0-9_-]/i.test(configurationSetName))) {
		throw new OperatorError(400, "invalid_configuration_set", "configurationSetName must contain 1 to 64 letters, numbers, hyphens or underscores.");
	}
	return withSes(true, async (operation) => {
		await operation.client.send(new CreateEmailIdentityCommand({
			EmailIdentity: domain,
			DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
			...(configurationSetName !== undefined ? { ConfigurationSetName: configurationSetName } : {}),
		}), { abortSignal: operation.signal });
		if (mailFromDomain !== undefined) {
			await operation.client.send(new PutEmailIdentityMailFromAttributesCommand({
				EmailIdentity: domain,
				MailFromDomain: mailFromDomain,
				BehaviorOnMxFailure: "REJECT_MESSAGE",
			}), { abortSignal: operation.signal });
		}
		return detail(domain, await readIdentity(operation, domain), operation.region);
	});
}

/** Explicit POST may update signing/MAIL FROM. AWS, not this service, verifies DNS. */
export async function verifyDomain(domain: string, body: Record<string, unknown>): Promise<DomainDetail> {
	const validated = validateDomain(domain);
	const input = expectObject(body);
	assertKnownFields(input, ["mailFromDomain", "dkimSigningEnabled"]);
	const mailFromDomain = readMailFromDomain(input, validated);
	const signingEnabled = Object.hasOwn(input, "dkimSigningEnabled") ? input.dkimSigningEnabled : true;
	if (typeof signingEnabled !== "boolean") {
		throw new OperatorError(400, "invalid_dkim_signing", "dkimSigningEnabled must be a boolean.");
	}
	return withSes(true, async (operation) => {
		const identity = await readIdentity(operation, validated);
		const dkim = identity.DkimAttributes;
		const easyDkim = !dkim?.SigningAttributesOrigin || dkim.SigningAttributesOrigin === "AWS_SES";
		const needsDkimSetup = !dkim || dkim.Status === "NOT_STARTED" || dkim.Status === "FAILED";
		const needsIdentitySetup = identity.VerifiedForSendingStatus !== true && (identity.VerificationStatus === "NOT_STARTED" || identity.VerificationStatus === "FAILED");
		if (signingEnabled && easyDkim && (needsDkimSetup || needsIdentitySetup)) {
			// Initiate Easy DKIM without deleting the identity or replacing BYODKIM/DEED.
			// Keep its key length, avoiding an unrelated, rate-limited key rotation.
			await operation.client.send(new PutEmailIdentityDkimSigningAttributesCommand({
				EmailIdentity: validated,
				SigningAttributesOrigin: "AWS_SES",
				SigningAttributes: { NextSigningKeyLength: dkim?.NextSigningKeyLength ?? dkim?.CurrentSigningKeyLength ?? "RSA_2048_BIT" },
			}), { abortSignal: operation.signal });
		}
		if (dkim?.SigningEnabled !== signingEnabled) {
			await operation.client.send(new PutEmailIdentityDkimAttributesCommand({ EmailIdentity: validated, SigningEnabled: signingEnabled }), { abortSignal: operation.signal });
		}
		if (mailFromDomain !== undefined) {
			await operation.client.send(new PutEmailIdentityMailFromAttributesCommand({
				EmailIdentity: validated,
				MailFromDomain: mailFromDomain,
				BehaviorOnMxFailure: identity.MailFromAttributes?.BehaviorOnMxFailure ?? "REJECT_MESSAGE",
			}), { abortSignal: operation.signal });
		}
		return detail(validated, await readIdentity(operation, validated), operation.region);
	});
}
