// A button straight to the new subscriber's webmail gets far more confirmation clicks than "check your inbox".
const WEBMAILS = [
	{
		pattern: /^(gmail|googlemail)\.com$/,
		name: "Gmail",
		url: (fromEmail) =>
			`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(
				`${fromEmail ? `from:${fromEmail} ` : ""}in:anywhere newer_than:1d`
			)}`,
	},
	{ pattern: /^(outlook|hotmail|live|msn)\.[a-z.]+$/, name: "Outlook", url: () => "https://outlook.live.com/mail/0/" },
	{ pattern: /^(yahoo|ymail)\.[a-z.]+$/, name: "Yahoo Mail", url: () => "https://mail.yahoo.com/" },
	{ pattern: /^(icloud|me|mac)\.com$/, name: "iCloud Mail", url: () => "https://www.icloud.com/mail" },
	{ pattern: /^(proton\.me|protonmail\.com|pm\.me)$/, name: "Proton Mail", url: () => "https://mail.proton.me/u/0/inbox" },
];

export function getInbox({ email, fromEmail }) {
	const domain = String(email ?? "").split("@")[1]?.toLowerCase();
	const webmail = domain ? WEBMAILS.find(({ pattern }) => pattern.test(domain)) : null;
	return webmail ? { name: webmail.name, url: webmail.url(fromEmail) } : null;
}
