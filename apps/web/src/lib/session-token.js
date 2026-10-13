import { SignJWT, base64url, jwtVerify } from "jose";
import { MIN_SESSION_SECRET_LENGTH } from "./config.js";

// __Host- cookies need HTTPS, which local dev doesn't have.
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-mailcheap_session" : "mailcheap_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

const encoder = new TextEncoder();
let cachedKey = null;

// Email links derive their keys from SESSION_SECRET with other infos, so signing everyone out never breaks them.
async function getKey() {
	const secret = process.env.SESSION_SECRET;
	if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
		throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
	}
	if (cachedKey?.secret !== secret) {
		const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]);
		const bits = await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("mailcheap-session-v1") },
			material,
			256
		);
		cachedKey = { secret, key: new Uint8Array(bits) };
	}
	return cachedKey.key;
}

// Changing the admin email or password changes it, which signs out every session.
async function getVersion(key) {
	const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
	const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`version\n${ADMIN_EMAIL}\n${ADMIN_PASSWORD}`));
	return base64url.encode(new Uint8Array(signature, 0, 16));
}

export async function signSessionToken(email) {
	const key = await getKey();
	return new SignJWT({ email, v: await getVersion(key) })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(`${SESSION_MAX_AGE}s`)
		.sign(key);
}

export async function verifySessionToken(token) {
	if (!token) return null;
	try {
		const key = await getKey();
		const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
		if (payload.email !== process.env.ADMIN_EMAIL || payload.v !== (await getVersion(key))) return null;
		return { email: payload.email };
	} catch {
		return null;
	}
}
