import { getAppUrl } from "./config.js";

// ARCHIVE_HOSTS="news.example.com=weekly,letters.example.org=another" serves a newsletter's archive
// on its own domain: / lists the issues, /p/slug shows one.
export function parseArchiveHosts(value) {
	const hosts = new Map();
	for (const pair of String(value ?? "").split(",")) {
		const [host, slug] = pair.split("=").map((part) => part?.trim().toLowerCase());
		if (host && slug) hosts.set(host, slug);
	}
	return hosts;
}

export function getArchiveSlugForHost(host, value = process.env.ARCHIVE_HOSTS) {
	const hostname = String(host ?? "")
		.toLowerCase()
		.split(":")[0];
	return parseArchiveHosts(value).get(hostname) ?? null;
}

export function getArchiveHost(slug, value = process.env.ARCHIVE_HOSTS) {
	for (const [host, hostSlug] of parseArchiveHosts(value)) if (hostSlug === slug) return host;
	return null;
}

const ARCHIVE_PATH_PATTERN = /^\/archive\/([^/]+)(\/.*)?$/;
const HOST_PATHS = { "/sitemap": "/sitemap.xml", "/robots": "/robots.txt" };

// Where an app-domain /archive path lives on the newsletter's own domain, or null without one.
export function getArchiveHostUrl(pathname, search = "", value = process.env.ARCHIVE_HOSTS) {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	const host = match && getArchiveHost(match[1], value);
	if (!host) return null;
	const path = match[2] ?? "/";
	return `https://${host}${HOST_PATHS[path] ?? path}${search}`;
}

// Archive pages are cached once for every host, so their links can't depend on the request. Without
// a domain of its own, the archive lives at APP_URL/archive/<slug>.
export function getArchiveUrls({ slug }, value = process.env.ARCHIVE_HOSTS, appUrl = getAppUrl()) {
	const host = getArchiveHost(slug, value);
	const base = host ? `https://${host}` : `/archive/${slug}`;
	const absoluteBase = host ? base : `${appUrl}${base}`;
	return {
		host,
		index: host ? `${base}/` : base,
		post: (postSlug) => `${base}/p/${postSlug}`,
		author: (authorSlug) => `${base}/authors/${authorSlug}`,
		siteIndex: host ? `${base}/` : absoluteBase,
		absolutePost: (postSlug) => `${absoluteBase}/p/${postSlug}`,
		absoluteAuthor: (authorSlug) => `${absoluteBase}/authors/${authorSlug}`,
	};
}
