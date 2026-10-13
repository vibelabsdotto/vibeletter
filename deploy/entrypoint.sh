#!/bin/sh
set -eu

if [ "${NODE_ENV:-}" != "production" ]; then
  printf '%s\n' 'This image requires NODE_ENV=production.' >&2
  exit 1
fi
if [ "${DEV_LOGIN_ENABLED:-}" != "false" ]; then
  printf '%s\n' 'This image requires DEV_LOGIN_ENABLED=false.' >&2
  exit 1
fi
validate_config() {
  : "${APP_URL:?Set the public HTTPS APP_URL}"
  : "${BETTER_AUTH_URL:?Set BETTER_AUTH_URL to the same origin as APP_URL}"
  : "${ADMIN_EMAIL:?Set the provisioned operator ADMIN_EMAIL}"
  : "${BETTER_AUTH_SECRET:?Set a separate random BETTER_AUTH_SECRET}"
  : "${SESSION_SECRET:?Set the stable recipient-link SESSION_SECRET}"
  # Use the app's validator before opening a DB or starting the queue.
  node --input-type=module -e '
    import { getConfigProblems } from "/app/apps/web/src/lib/config.js";
    const problems = getConfigProblems();
    if (problems.length) {
      console.error("Invalid production configuration: " + problems.join(" "));
      process.exit(1);
    }
  '
}

case "${1:-web}" in
  web)
    validate_config
    exec node /app/apps/web/server.js
    ;;
  worker)
    validate_config
    cd /app/apps/web
    exec /app/node_modules/.bin/tsx --conditions=react-server src/worker.ts
    ;;
  migrate)
    validate_config
    cd /app/apps/web
    /app/node_modules/.bin/tsx src/db/migrate.ts
    # Queue storage has its own official package migration. Both must complete
    # before Compose may start either long-running process.
    exec /app/node_modules/.bin/tsx src/queue/migrate.ts
    ;;
  provision)
    validate_config
    shift
    cd /app/apps/web
    exec /app/node_modules/.bin/tsx --conditions=react-server src/scripts/provision-operator.ts "$@"
    ;;
  cli)
    shift
    exec node /app/apps/cli/dist/index.js "$@"
    ;;
  *)
    printf '%s\n' 'Expected web, worker, migrate, provision or cli.' >&2
    exit 1
    ;;
esac
