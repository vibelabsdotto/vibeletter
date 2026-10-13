export const APP_NAME = "VibeLetter";
export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_AUTH_SECRET_LENGTH = 32;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

function originUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

export function getSendingConfigProblems(env = process.env) {
  if (env.SENDING_ENABLED !== "true") return [];
  const problems = [];
  const configurationSet = env.SES_CONFIGURATION_SET ?? "";
  if (!configurationSet || configurationSet.length > 64 || /[^A-Za-z0-9_-]/.test(configurationSet)) {
    problems.push("SES_CONFIGURATION_SET must be a valid 1-64 character SES configuration set name when sending is enabled.");
  }
  const region = env.SES_REGION || env.AWS_REGION || "us-east-1";
  const topic = /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-[a-z]+)+-[0-9]+):([0-9]{12}):([A-Za-z0-9_-]{1,256})$/.exec(env.SES_SNS_TOPIC_ARN ?? "");
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  if (!topic || topic[0] !== env.SES_SNS_TOPIC_ARN || topic[1] !== partition || topic[2] !== region) {
    problems.push("SES_SNS_TOPIC_ARN must be a valid standard SNS topic ARN with a 12-digit account ID in the SES region and partition when sending is enabled.");
  }
  return problems;
}

export function getConfigProblems(env = process.env) {
  const problems = getSendingConfigProblems(env);
  if ((env.SESSION_SECRET ?? "").length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters for recipient links.`);
  }
  if ((env.BETTER_AUTH_SECRET ?? "").length < MIN_AUTH_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters.`);
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.BETTER_AUTH_SECRET) {
    problems.push("BETTER_AUTH_SECRET must differ from the recipient-link SESSION_SECRET.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL ?? "")) {
    problems.push("ADMIN_EMAIL must identify the provisioned operator.");
  }
  const appUrl = originUrl(env.APP_URL);
  const authUrl = originUrl(env.BETTER_AUTH_URL);
  if (!appUrl) problems.push("APP_URL must be an explicit HTTP(S) origin without a path.");
  if (!authUrl) problems.push("BETTER_AUTH_URL must be an explicit HTTP(S) origin without a path.");
  if (appUrl && authUrl && appUrl.origin !== authUrl.origin) {
    problems.push("BETTER_AUTH_URL and APP_URL must use the same origin.");
  }
  if (env.NODE_ENV === "production" && appUrl?.protocol !== "https:") {
    problems.push("APP_URL must use HTTPS in production.");
  }
  return problems;
}

export function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(hostname).toLowerCase());
}

// No forwarded headers or implicit localhost defaults may grant this bypass.
export function isDevelopmentLoginAllowed(requestHeaders, requestUrl, env = process.env) {
  if (env.NODE_ENV !== "development" || env.DEV_LOGIN_ENABLED !== "true") return false;
  const canonical = originUrl(env.APP_URL);
  if (!canonical || !isLoopbackHostname(canonical.hostname)) return false;
  const host = requestHeaders?.get("host");
  if (!host || /[\s/@\\,?#]/.test(host)) return false;
  const actual = originUrl(`${canonical.protocol}//${host}`);
  if (!actual || !isLoopbackHostname(actual.hostname) || actual.host !== canonical.host) return false;
  if (requestUrl) {
    try {
      if (new URL(requestUrl).origin !== canonical.origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function getOperatorEmail() {
  return (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
}

export function isSendingEnabled() {
  return process.env.SENDING_ENABLED === "true";
}

export function getAppUrl() {
  return (process.env.APP_URL || "http://localhost:3035").replace(/\/$/, "");
}

function readSendRate() {
  const rate = Number.parseInt(process.env.SEND_RATE_PER_SECOND, 10);
  return Number.isInteger(rate) && rate >= 1 && rate <= 14 ? rate : 10;
}

export const LIMITS = {
  bounceRate: 0.02,
  complaintRate: 0.0008,
  maxEmailBytes: 100_000,
  sendRatePerSecond: readSendRate(),
  welcomeEmailsPer10Minutes: 100,
};
