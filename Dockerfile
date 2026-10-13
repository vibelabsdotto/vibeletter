# syntax=docker/dockerfile:1

# Node 24 LTS. Pin NODE_IMAGE to an audited digest for reproducible releases.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
# Native SQLite modules may need a compiler if a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN npm ci --include=dev

FROM dependencies AS build
COPY . .
# The build gets no operator credentials, provider tokens or persistent databases.
# These non-secret, build-only values are not environment defaults in the runtime.
RUN APP_URL=https://build.invalid \
    BETTER_AUTH_URL=https://build.invalid \
    ADMIN_EMAIL=build@build.invalid \
    BETTER_AUTH_SECRET=build-only-auth-value-not-a-runtime-secret \
    SESSION_SECRET=build-only-link-value-not-a-runtime-secret \
    SENDING_ENABLED=false \
    npm run build \
    && test -f apps/web/.next/standalone/apps/web/server.js

FROM dependencies AS production-dependencies
# tsx is a runtime dependency of the web workspace, not just a build tool:
# the worker, migrations and explicit operator provisioning execute TypeScript.
RUN npm ci --omit=dev \
    && test -x node_modules/.bin/tsx \
    && mkdir -p apps/web/node_modules apps/cli/node_modules \
    && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    DEV_LOGIN_ENABLED=false \
    SENDING_ENABLED=false \
    HOSTNAME=0.0.0.0 \
    PORT=3035 \
    DATABASE_PATH=/app/data/vibeletter.db \
    QUEUE_DATABASE_PATH=/app/data/queue.db \
    TZ=UTC
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --chown=node:node deploy/NOTICE ./NOTICE
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
# Next does not automatically copy either directory into standalone output.
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
# The worker is not part of the Next server's trace. Ship its source and assets.
# npm may keep non-hoisted production dependencies inside each workspace.
COPY --from=production-dependencies --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=build --chown=node:node /app/apps/web/src ./apps/web/src
COPY --from=build --chown=node:node /app/apps/web/assets ./apps/web/assets
COPY --from=build --chown=node:node /app/apps/web/drizzle ./apps/web/drizzle
COPY --from=build --chown=node:node /app/apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/cli/package.json ./apps/cli/package.json
COPY --from=build --chown=node:node /app/apps/cli/dist ./apps/cli/dist
COPY --chown=node:node --chmod=755 deploy/entrypoint.sh /usr/local/bin/vibeletter-entrypoint
# Refuse the assembled release artifact. Next copies loaded .env files separately
# from tracing, so outputFileTracingExcludes is not a credential boundary.
# Inspect names and symlink targets only; never read, delete or sanitize secret files.
RUN node --input-type=module <<'NODE'
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const root = realpathSync(".");
const privateDirectories = new Set([
  ".git", ".hermes", ".agents", ".vibeletter", ".aws", ".ssh", ".gnupg", ".credentials", "credentials",
]);
const privateFiles = new Set([
  ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", "credentials", "credentials.json", "credentials.ini", "credentials.yml", "credentials.yaml",
]);
const visited = new Set();

function checkPath(relative) {
  const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
  const name = segments.at(-1);
  if (segments.some((segment) => privateDirectories.has(segment) || segment.startsWith(".env")) ||
      privateFiles.has(name) || /\.(?:db|sqlite|sqlite3)(?:-.*)?$/.test(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name) ||
      /^(?:service[-_]account.*|client_secret.*)\.json$/.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) ||
      /^(?:data|apps\/(?:web|cli)\/data)\//.test(segments.join("/"))) {
    throw new Error(`Release artifact contains forbidden path: ${relative}`);
  }
}

function walk(directory) {
  if (visited.has(directory)) return;
  visited.add(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    checkPath(path.relative(root, filename));
    if (entry.isSymbolicLink()) {
      const target = realpathSync(filename);
      const relative = path.relative(root, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Release artifact symlink escapes its root: ${path.relative(root, filename)}`);
      }
      checkPath(relative);
    } else if (entry.isDirectory()) walk(filename);
    else if (!entry.isFile()) throw new Error(`Release artifact contains a non-regular file: ${path.relative(root, filename)}`);
  }
}

walk(root);
console.log("Release artifact path check passed");
NODE
# Verify the native runtime binary, not merely that its package was installed.
RUN node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1); db.close()' \
    && node apps/cli/dist/index.js --help > /dev/null
USER node
EXPOSE 3035
STOPSIGNAL SIGTERM
ENTRYPOINT ["vibeletter-entrypoint"]
CMD ["web"]
