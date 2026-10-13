import { fileURLToPath } from "node:url";

// No script-src: Next.js's inline scripts would need per-request nonces, which archive pages can't have
// while they're cached (ISR). script-src-attr still blocks inline event handlers everywhere.
const CONTENT_SECURITY_POLICY = [
	"frame-ancestors 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"script-src-attr 'none'",
].join("; ");

const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
	poweredByHeader: false,
	output: "standalone",
	outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
	outputFileTracingExcludes: {
		// Proxy and next-server traces have entry names without a leading slash.
		"*": [
			// Patterns resolve from apps/web, not outputFileTracingRoot. Cover sibling workspaces too.
			"../../data/**/*", "../../apps/web/data/**/*", "../../apps/cli/data/**/*",
			// Next uses raw patterns for next-server, but project-root-resolved patterns for routes.
			...[
				"**/.env*",
				"**/*.{db,sqlite,sqlite3}{,-*}",
				"**/*.{pem,key,p12,pfx,jks,keystore,kdbx}",
				"**/{.vibeletter,.hermes,.agents,.git,.aws,.ssh,.gnupg,.credentials,credentials}/**/*",
				"**/{.netrc,.npmrc,.yarnrc,.yarnrc.yml,credentials,credentials.json,credentials.ini,credentials.yml,credentials.yaml,service-account*.json,service_account*.json,client_secret*.json,id_rsa*,id_dsa*,id_ecdsa*,id_ed25519*}",
			].flatMap((pattern) => [`../../${pattern}`, pattern]),
		],
	},
	serverExternalPackages: ["better-sqlite3"],
	images: { unoptimized: true },
	async headers() {
		return [{ source: "/:path*", headers: SECURITY_HEADERS }];
	},
};

export default nextConfig;
