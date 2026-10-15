# VibeLetter

VibeLetter is a self-hosted newsletter app for Amazon SES. Write in the original Mailcheap editor, manage several newsletters, and publish a web archive. A context-aware CLI operates the same backend as the dashboard.

This is an independent VibeLabs derivative of [Mailcheap](https://github.com/marclou/mailcheap), based on commit [`67d13b028a6ecae9ec56d49c4b2db58019217eba`](https://github.com/marclou/mailcheap/tree/67d13b028a6ecae9ec56d49c4b2db58019217eba). The original MIT copyright belongs to Marc Lou and remains in [LICENSE](LICENSE).

## What changed

- Next.js hosts both the dashboard and the backend in `apps/web`.
- SQLite, Drizzle and better-sqlite3 replace MongoDB. Migrations use the official Drizzle migration journal.
- A persistent local queue and a separate worker replace QStash. Web and worker share a persistent local volume.
- Better Auth handles the single operator account. Public production signup is disabled. API keys are scoped bearer tokens with optional expiry, stored as hashes.
- Cloudflare R2 replaces Vercel Blob for editor images. A private bucket can serve images through the app.
- `apps/cli` provides instance contexts, structured output and operator commands against `/api/v1`.

No Vercel, MongoDB, Redis, Upstash or paid queue service is required. SES, R2 and your host can still incur charges. This is not a serverless deployment.

## What you need

| Component | Requirement |
| --- | --- |
| Host | One Linux host with a persistent local filesystem and HTTPS reverse proxy |
| Runtime | Node.js 24 LTS, or Docker with the Compose plugin |
| Database | The application and queue SQLite files on one local persistent volume |
| Mail | An SES account, verified identities in the selected region, and monitored bounce/complaint feedback |
| Images | An R2 bucket with bucket-scoped object read/write credentials |

Run exactly one web replica and one worker. Do not share the SQLite files over NFS or SMB, run them on separate hosts, or deploy ephemeral serverless instances.

## Start here

The operator guides are in German:

- [Local setup and configuration](docs/SETUP.md)
- [Production deployment, upgrades and operations](docs/DEPLOYMENT.md)
- [SES domains, DNS, IAM and feedback](docs/SES-DOMAINS.md)
- [CLI reference](docs/CLI.md)
- [Security boundaries](SECURITY.md)

Sending defaults to `SENDING_ENABLED=false`. A verified identity alone is not enough to enable production mail. Finish the DNS and feedback checks first. Use the SES mailbox simulator or an explicitly approved test recipient, not an imported audience.

### Local development

```bash
npm ci
cp .env.example .env
```

Set `BETTER_AUTH_SECRET` and `SESSION_SECRET` to different random values, and use `APP_URL=http://localhost:3035` with the same `BETTER_AUTH_URL`. Set `DATABASE_PATH` and `QUEUE_DATABASE_PATH` to absolute paths in a private local data directory, shared by both processes. Do not leave these path variables empty. The setup guide explains which processes load which env files.

```bash
# Export the trusted, shell-compatible .env in this terminal.
set -a
. ./.env
set +a
NODE_ENV=development npm run db:migrate
NODE_ENV=development npm run queue:migrate
npm run dev:web
```

Open `http://localhost:3035`. Export the same environment in a second terminal and start `NODE_ENV=development npm run worker` when you need queued work. Keep sending disabled. The explicit development login requires development mode, an enabled flag and a loopback request origin. It is never available in production.

### Docker deployment

```bash
cp deploy/production.env.example .env.production
chmod 600 .env.production
```

Fill in the public HTTPS origin, operator email, two separate secrets and provider settings before continuing.

```bash
docker compose build
docker compose up -d
```

Compose runs a separate migration service before starting web and worker. It binds the web port to `127.0.0.1:3035`, not the public internet. Configure the host's HTTPS proxy and explicitly provision the operator before logging in. See the [deployment guide](docs/DEPLOYMENT.md) for those steps and the upgrade procedure.

Building an image or seeing an HTTP healthcheck pass does not prove that SES feedback, R2 or an actual send works.

## Project commands

Run these from the repository root:

Before the first CLI invocation, run `npm run build --workspace apps/cli` or the full `npm run build`. The root CLI wrapper runs the compiled bin without changing the working directory, so repository-local contexts stay under the root `.vibeletter/`. Use `npm run --silent cli -- --json readiness` for JSON without npm banners.

| Command | Purpose |
| --- | --- |
| `npm run dev:web` | Dashboard and backend on localhost:3035 |
| `npm run build` | Build the web and CLI workspaces |
| `npm run typecheck` | Type generation and TypeScript checks |
| `npm run lint` | Workspace lint checks |
| `npm test` | Retained upstream test suite |
| `npm run db:generate` | Generate migrations after a reviewed schema change |
| `npm run db:migrate` | Apply committed migrations |
| `npm run queue:migrate` | Apply the queue package's migrations |
| `npm run operator:provision` | Explicitly provision the operator using stdin or a temporary environment variable |
| `npm run worker` | Standalone queue consumer |
| `npm run cli -- --help` | Local CLI usage |

Do not use `drizzle-kit push` in place of the committed migration history. Web startup does not replace an explicit migration step.

Every push to `main` runs [Woodpecker CI](.woodpecker/ci.yaml) on `ci.vibelabs.to`: `npm ci`, `npm audit --omit=dev`, tests, typecheck, lint, the CLI docs check and the production build. CI only checks; it does not deploy and uses no secrets.

## Data and mail boundaries

Each newsletter has its own sender, reply-to address and public archive settings. Separate domains in the same AWS account and region share SES quotas and reputation constraints. SES identity verification does not create a receiving inbox. A reply-to address needs a real mailbox or forwarding service.

The app database, auth records and queue contain personal data. R2 stores images, not the contact database. Uploaded email images are intentionally readable without an operator session. Do not upload private documents.

Outbound mail can have an uncertain outcome after a connection failure. An absent delivery event is not permission to resend. Check message state, queue state and SES feedback before retrying any work that might already have reached SES.

## Upstream screenshots

These images document the original Mailcheap UI, not a verified VibeLetter deployment. Names and addresses in the upstream screenshots are examples.

<details>
<summary>Editor, reports, contacts and archive</summary>

![Mailcheap overview](docs/screenshots/overview.webp)

| Editor | Campaign report |
| --- | --- |
| ![Editor](docs/screenshots/editor.webp) | ![Campaign report](docs/screenshots/report.webp) |
| Contacts | Public archive |
| ![Contacts](docs/screenshots/contacts.webp) | ![Public archive](docs/screenshots/archive.webp) |

![Issue page](docs/screenshots/issue.webp)

</details>

## License

[MIT](LICENSE). Original work by [Marc Lou](https://x.com/marclou). VibeLetter adaptation by VibeLabs. There is no warranty, security audit claim, deliverability guarantee or support SLA. Operators are responsible for consent, retention, applicable law, DNS, credentials and host maintenance.
