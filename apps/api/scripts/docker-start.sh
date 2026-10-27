#!/bin/sh
# Container start: apply migrations, seed demo accounts (idempotent, never in production), start the API.
set -e
TS="node node_modules/ts-node/dist/bin.js --transpile-only"
$TS scripts/migrate.ts
if [ -n "$SEED_PASSWORD" ] && [ "$NODE_ENV" != "production" ]; then
  $TS scripts/seed.ts
fi
exec node dist/main.js
