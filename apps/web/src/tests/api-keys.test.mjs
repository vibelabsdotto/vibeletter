import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
	generateApiKey,
	hashApiKey,
	readBearerToken,
	shouldTouchLastUsed,
} from "../lib/api-key-tokens.js";

test("generated keys carry 32 random bytes, a display prefix, and their SHA-256 hash", () => {
	const { key, prefix, hash } = generateApiKey();
	assert.match(key, /^vl_[A-Za-z0-9_-]{43}$/);
	assert.equal(Buffer.from(key.slice(3), "base64url").length, 32);
	assert.equal(prefix, `${key.slice(0, 10)}…`);
	assert.equal(hash, crypto.createHash("sha256").update(key).digest("hex"));
});

test("every generated key and hash is unique", () => {
	const keys = Array.from({ length: 100 }, () => generateApiKey());
	assert.equal(new Set(keys.map(({ key }) => key)).size, keys.length);
	assert.equal(new Set(keys.map(({ hash }) => hash)).size, keys.length);
});

test("hashApiKey is deterministic and sensitive to every character", () => {
	const { key, hash } = generateApiKey();
	assert.equal(hashApiKey(key), hash);
	assert.match(hash, /^[a-f0-9]{64}$/);
	assert.notEqual(hashApiKey(`${key.slice(0, -1)}x`), hash);
});

test("only well-formed bearer tokens are read", () => {
	const { key } = generateApiKey();
	assert.equal(readBearerToken(`Bearer ${key}`), key);
	assert.equal(readBearerToken(`bearer   ${key}  `), key);

	const rejected = [
		undefined,
		null,
		"",
		"Bearer ",
		key,
		`Basic ${key}`,
		`Bearer ${key} extra`,
		`Bearer ${key.slice(0, -1)}`,
		`Bearer ${key}=`,
		`Bearer sk_${key.slice(3)}`,
		`Bearer ${key.toUpperCase().replace("VL_", "vl_")}!`,
	];
	for (const header of rejected) assert.equal(readBearerToken(header), null, String(header));
});

test("lastUsedAt is refreshed at most once per minute", () => {
	const now = Date.parse("2026-10-04T12:00:00.000Z");
	assert.equal(shouldTouchLastUsed(undefined, now), true);
	assert.equal(shouldTouchLastUsed(null, now), true);
	assert.equal(shouldTouchLastUsed(new Date(now - 59_000), now), false);
	assert.equal(shouldTouchLastUsed(new Date(now - 60_000), now), true);
	assert.equal(shouldTouchLastUsed(new Date(now - 3_600_000).toISOString(), now), true);
});
