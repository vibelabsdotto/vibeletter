# Security

VibeLetter is self-hosted software provided under the MIT license, without a warranty or support SLA. This document describes implementation boundaries, not the result of an independent security audit. Operators must maintain the host, dependencies, DNS, credentials and data retention.

## Operator authentication

- Better Auth uses the application's SQLite database. Production supports the single operator selected by `ADMIN_EMAIL`, not public signup or team membership.
- Operator credentials are provisioned explicitly after migrations. The provisioning command refuses to silently overwrite an existing password account.
- `BETTER_AUTH_SECRET` and `SESSION_SECRET` must be different and at least 32 characters each. Production requires a public HTTPS `APP_URL` and the same `BETTER_AUTH_URL` origin.
- The operator password is not a deployment `ADMIN_PASSWORD` variable. Provision it through stdin or a temporary environment variable, never an argument or committed file.
- A development login requires `NODE_ENV=development`, explicit `DEV_LOGIN_ENABLED=true`, a loopback canonical origin and a matching actual loopback request host. It is denied in production even when the flag is accidentally set.
- Login throttling includes a single-operator guessing budget. Process-memory limits reset on restart. They are not a distributed rate-limiting service or protection against every denial-of-service attack.

Do not publish the development server or use a development bypass as a production access-recovery method. Do not assume MFA, SSO, account recovery or a password-reset service exists just because Better Auth supports these features elsewhere.

## API keys and client credentials

Bearer API keys have the `vl_` prefix. The server stores their hashes and validates scope, revocation and optional expiry. Plaintext is returned only on creation. List and detail operations do not return hashes or tokens. A key cannot grant a new key scopes that it does not hold.

Use narrowly scoped keys and set an expiry appropriate for the integration. A `*` key can operate the instance, so treat it like operator access. Keep tokens out of command arguments, URLs, shell history and logs. CLI contexts can store tokens in private local files, but private file permissions do not protect them from the same user or a compromised host.

Supplying an invalid bearer credential must not silently fall through to a valid browser cookie. Write requests authenticated with cookies also need the application's origin checks. Keep the dashboard behind HTTPS and do not expose the internal web port alongside the proxy.

## Recipient links and newsletter content

`SESSION_SECRET` signs recipient-facing confirmation, unsubscribe and tracking links. It is separate from the operator-authentication secret. Rotating it invalidates old links in already sent emails. Generate it once for an instance, not on every deployment.

Campaign and archive HTML is untrusted content. Retained rendering helpers sanitize supported content, and HTML archive content uses a sandboxed frame. A separate archive origin through `ARCHIVE_HOSTS` adds an origin boundary between newsletter content and the dashboard. It still needs explicit DNS, TLS and routing.

The Next configuration sends frame, content-type, referrer and Content Security Policy headers. The CSP does not set a complete `script-src` policy. It is not a claim that all script execution is prevented. Review content changes and origin routing rather than relying on a header name alone.

## Mail and provider callbacks

`SENDING_ENABLED` defaults to false. Enabling it permits real outbound work, including queued campaign, test, confirmation and welcome mail. There is no production mock success or local-mail fallback that counts as a delivery.

The queue runs in a separate local worker, not an unauthenticated public job callback. Run exactly one worker. A timeout can leave the SES acceptance outcome unknown, and neither SQLite persistence nor retries provide an exactly-once delivery guarantee. Do not blindly retry ambiguous sends.

SES feedback enters through `/api/webhooks/ses`. The handler must require the configured SNS topic and a valid AWS SNS signature before processing notifications or confirming subscriptions. Certificate URLs are restricted to the expected HTTPS SNS certificate path, and certificate fetches reject redirects. Keep raw SNS delivery off so the signed envelope reaches the handler.

A configured topic is not proof that feedback works. Verify a confirmed subscription and durable processing of approved simulator bounce and complaint cases before enabling an audience. Keep appropriate AWS feedback forwarding until the automated path has been demonstrated. See [SES-DOMAINS.md](docs/SES-DOMAINS.md).

## SQLite, R2 and deployment secrets

Application data, auth records and queue data live on the same host's persistent local volume. SQLite files are not encrypted by the application. Restrict filesystem permissions and use host-level storage encryption when required. Do not place them on NFS or SMB or share them across replicas.

R2 credentials must be restricted to the chosen bucket. Image uploads validate type, file structure and size. Local file storage is allowed only when explicitly selected in development. Production does not silently fall back from R2 to disk.

Public email images are intentionally readable without an operator session, even when the R2 bucket itself is private and the app serves the image. Do not upload private documents or credentials. If `R2_PUBLIC_URL` is set, the public asset origin has its own access and security configuration.

`.env.production` is an environment file, not a secret manager. Docker administrators can inspect container environment and read mounted data. `.dockerignore` prevents local environment files and databases from entering normal builds, but it cannot remove a secret that someone already committed into source or an image layer.

Build releases only from credential-free source and environment. Next.js can copy loaded `.env` and `.env.production` files into standalone output separately from its tracing rules. Recursive tracing exclusions cover the monorepo, but exclusions alone do not make a bare `npm run build` artifact safe to publish. A non-Docker standalone release needs the same final path inspection before distribution.

The Docker build refuses an assembled application artifact containing environment files, SQLite files and sidecars, private keys, CLI context files, credential files or private agent/configuration directories. It also rejects symlinks that escape the artifact root. The check does not read or delete these files, and it cannot detect a token embedded in ordinary source or compiled JavaScript. Keep runtime credentials and persistent data outside the build input and inject them only at runtime. Do not bypass a failed artifact check by deleting sensitive files from a completed image, since earlier layers may still contain them.

There is no automatic backup or rollback service. An explicitly planned restore must reconcile the application database, queue and externally accepted sends. Restoring stale queue state can cause duplicate mail. Review [DEPLOYMENT.md](docs/DEPLOYMENT.md) before changing schemas or deleting volumes.

## Reporting a vulnerability

Do not post credentials, tokens, recipient data or exploit payloads containing real records in a public issue. Use GitHub private vulnerability reporting if it is enabled on the repository. If it is not available, use an existing private maintainer contact rather than publishing sensitive details.

There is no promised response time or security-fix SLA. If you operate a vulnerable deployment, disable the affected path or stop sending while assessing the issue. Do not assume that reporting it also secures your instance.
