#!/bin/sh
# Container start: apply migrations, create/reset a Super Admin if asked, seed demo accounts (idempotent, never in production), start the API.
set -e
TS="node node_modules/ts-node/dist/bin.js --transpile-only"
$TS scripts/migrate.ts
# One-time Super Admin setup / password reset (production-safe): see scripts/bootstrap-admin.ts.
if [ -n "$BOOTSTRAP_ADMIN_USERNAME" ]; then
  $TS scripts/bootstrap-admin.ts || echo "bootstrap-admin: not applied (see the message above); the API starts anyway."
fi
# Demo accounts only when asked for explicitly (SEED_DEMO_ACCOUNTS=true), never in production.
if [ "$SEED_DEMO_ACCOUNTS" = "true" ] && [ -n "$SEED_PASSWORD" ] && [ "$NODE_ENV" != "production" ]; then
  $TS scripts/seed.ts
fi
exec node dist/main.js
