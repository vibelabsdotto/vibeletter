import { getAppUrl } from "./config.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";

// Its own key, so an unsubscribe link can never confirm a subscription or the other way around.
const INFO = "mailcheap-confirm-v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createConfirmToken({ contactId, newsletterId, confirmationNonce }, now = Date.now()) {
	return createContactToken({ info: INFO, contactId, newsletterId, confirmationNonce }, now);
}

export function verifyConfirmToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: INFO, maxAgeMs: MAX_AGE_MS, now });
}

export function getConfirmUrl({ contactId, newsletterId, confirmationNonce }) {
	if (!confirmationNonce) throw new Error("A current confirmation nonce is required");
	return `${getAppUrl()}/confirm?token=${createConfirmToken({ contactId, newsletterId, confirmationNonce })}`;
}
