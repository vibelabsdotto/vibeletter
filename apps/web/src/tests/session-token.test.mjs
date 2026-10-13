import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, decodeJwt } from "jose";

process.env.SESSION_SECRET = "s".repeat(40);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "correct horse battery staple";

const { SESSION_COOKIE, SESSION_MAX_AGE, signSessionToken, verifySessionToken } = await import("../lib/session-token.js");
const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
const { getClickUrl, getOpenUrl } = await import("../lib/tracking.js");
const { createConfirmToken } = await import("../lib/confirmation.js");
const { createKeepToken } = await import("../lib/last-chance.js");

async function withEnv(values, run) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("a session lasts 7 days and verifies while the admin login is unchanged", async () => {
	const token = await signSessionToken("admin@example.com");
	const { iat, exp } = decodeJwt(token);
	assert.equal(SESSION_MAX_AGE, 7 * 24 * 60 * 60);
	assert.equal(exp - iat, SESSION_MAX_AGE);
	assert.deepEqual(await verifySessionToken(token), { email: "admin@example.com" });
});

test("changing the admin password or email signs out every session", async () => {
	const token = await signSessionToken("admin@example.com");
	await withEnv({ ADMIN_PASSWORD: "a new password here" }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	await withEnv({ ADMIN_EMAIL: "other@example.com" }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	assert.deepEqual(await verifySessionToken(token), { email: "admin@example.com" });
});

test("sessions are signed with their own key, not SESSION_SECRET itself", async () => {
	const rawKey = new TextEncoder().encode(process.env.SESSION_SECRET);
	const { v } = decodeJwt(await signSessionToken("admin@example.com"));
	for (const claims of [{ email: "admin@example.com" }, { email: "admin@example.com", v }]) {
		const forged = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(rawKey);
		assert.equal(await verifySessionToken(forged), null);
	}

	const token = await signSessionToken("admin@example.com");
	await withEnv({ SESSION_SECRET: "t".repeat(40) }, async () => {
		assert.equal(await verifySessionToken(token), null);
	});
	await withEnv({ SESSION_SECRET: "s".repeat(31) }, async () => {
		assert.equal(await verifySessionToken(token), null);
		await assert.rejects(signSessionToken("admin@example.com"), /at least 32 characters/);
	});
	assert.equal(await verifySessionToken(`${token}x`), null);
	assert.equal(await verifySessionToken(""), null);
});

// Signed with SESSION_SECRET = "s" x 40. Email links don't use the session key: changing how they're signed
// breaks the links in emails already sent.
test("email links keep their signatures", () => {
	const ids = { contactId: "65f000000000000000000001", newsletterId: "65f000000000000000000002" };
	const at = Date.UTC(2026, 9, 1);
	assert.equal(
		createUnsubscribeToken(ids),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiJ9.qxugCW39rqGI0TSWiaWjEWH-bVd71-Lb69vN7idQJ0k"
	);
	assert.equal(
		getOpenUrl("https://app.example.com", "65f000000000000000000003"),
		"https://app.example.com/o/65f000000000000000000003.JtU4g2LPPxg4mmeolrDvOn"
	);
	assert.equal(
		getClickUrl("https://app.example.com", "65f000000000000000000003", "https://example.com/a"),
		"https://app.example.com/c/65f000000000000000000003.52hwWaNiG9b4Z8RNRfq3tq.aHR0cHM6Ly9leGFtcGxlLmNvbS9h"
	);
	assert.equal(
		createConfirmToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiIsInQiOjE3OTA4MTI4MDB9.64ux5hwD5hvAyrvxgKpO5LcGY4XGxOzwRU0JVqsrxo8"
	);
	assert.equal(
		createKeepToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiIsInQiOjE3OTA4MTI4MDB9.TcO_u6bsrlsl-cZZJ66RGMD_-_bR92nFDSJSe638hYE"
	);
});

test("production keeps the session in a __Host- cookie", async () => {
	assert.equal(SESSION_COOKIE, "mailcheap_session");
	await withEnv({ NODE_ENV: "production" }, async () => {
		const production = await import("../lib/session-token.js?production");
		assert.equal(production.SESSION_COOKIE, "__Host-mailcheap_session");
	});
});
