import assert from "node:assert/strict";
import { test } from "node:test";
import { getConfigProblems } from "../lib/config.js";
import { register } from "../instrumentation.js";

// Better Auth replaces the environment password; runtime needs separate auth/link secrets and explicit origins.
const STRONG = {
	SESSION_SECRET: "s".repeat(32), BETTER_AUTH_SECRET: "a".repeat(32),
	ADMIN_EMAIL: "operator@example.invalid", APP_URL: "http://localhost:3035", BETTER_AUTH_URL: "http://localhost:3035",
	NODE_ENV: "development", SENDING_ENABLED: "false",
};

test("recipient and Better Auth secrets each need 32 characters", () => {
	assert.deepEqual(getConfigProblems(STRONG), []);
	assert.match(getConfigProblems({ ...STRONG, SESSION_SECRET: "s".repeat(31) }).join(), /SESSION_SECRET must be at least 32/);
	assert.match(getConfigProblems({ ...STRONG, BETTER_AUTH_SECRET: "a".repeat(31) }).join(), /BETTER_AUTH_SECRET must be at least 32/);
	assert.equal(getConfigProblems({}).length, 5, "missing secrets, operator email and both origins are rejected");
});

test("the server doesn't start with a short recipient or auth secret", () => {
	const previous = { ...process.env };
	try {
		Object.assign(process.env, STRONG);
		delete process.env.NEXT_PHASE;
		assert.doesNotThrow(register);
		process.env.BETTER_AUTH_SECRET = "short";
		assert.throws(register, /VibeLetter can't start\. BETTER_AUTH_SECRET must be at least 32 characters/);
		Object.assign(process.env, STRONG, { SESSION_SECRET: "short" });
		assert.throws(register, /SESSION_SECRET must be at least 32 characters/);
	} finally {
		process.env = previous;
	}
});
