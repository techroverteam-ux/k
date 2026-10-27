#!/usr/bin/env bash
# Sets every environment variable The K API needs on Render, then starts a deploy.
# Runs on your Mac. Secrets are generated here and sent only to Render's API (HTTPS).
# Nothing is printed except key names.
#
# You need:
#   - a Render API key: dashboard → Account Settings → API Keys → Create API Key
#   - the Neon DIRECT connection string (no "-pooler" in the host)
#   - a demo password (12+ chars) for the seeded accounts
#
# Existing secret values on Render are never overwritten (so HASH_PEPPER / DATA_ENCRYPTION_KEY
# can't be rotated by accident). Plain settings are always (re)set.
set -euo pipefail

API="${RENDER_API_URL:-https://api.render.com/v1}"
SERVICE_NAME="${1:-}"

need() { command -v "$1" >/dev/null || { echo "Missing $1. Install it first."; exit 1; }; }
need curl; need node; need openssl

read -rsp "Render API key (hidden): " RENDER_API_KEY; echo
[ -n "$RENDER_API_KEY" ] || { echo "No API key given."; exit 1; }
AUTH=(-H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json")

api() { # method path [json-body]
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS --fail-with-body -X "$m" "${AUTH[@]}" -H "Content-Type: application/json" --data-binary @- "$API$p" <<<"$body"
  else
    curl -sS --fail-with-body -X "$m" "${AUTH[@]}" "$API$p"
  fi
}

# --- find the service -------------------------------------------------------
echo "Your Render web services:"
SERVICES_JSON=$(api GET "/services?type=web_service&limit=50")
node -e '
  const list = JSON.parse(process.argv[1]).map(x => x.service);
  list.forEach((s, i) => console.log(`  ${i + 1}) ${s.name}  [${s.id}]  ${s.serviceDetails?.url ?? ""}`));
' "$SERVICES_JSON"
if [ -z "$SERVICE_NAME" ]; then read -rp "Number or name of the API service: " SERVICE_NAME; fi
SERVICE_ID=$(node -e '
  const list = JSON.parse(process.argv[1]).map(x => x.service); const q = process.argv[2];
  const s = /^\d+$/.test(q) ? list[Number(q) - 1] : list.find(x => x.name === q);
  if (!s) { console.error("Service not found: " + q); process.exit(1); }
  console.log(s.id);
' "$SERVICES_JSON" "$SERVICE_NAME")
echo "Using service $SERVICE_ID"

EXISTING=$(api GET "/services/$SERVICE_ID/env-vars?limit=100" | node -e '
  let d = ""; process.stdin.on("data", c => d += c).on("end", () =>
    console.log(JSON.parse(d).map(x => x.envVar.key).join(" ")));')
has() { [[ " $EXISTING " == *" $1 "* ]]; }

set_var() { # key value
  local body
  body=$(node -e 'console.log(JSON.stringify({ value: process.argv[1] }))' "$2")
  api PUT "/services/$SERVICE_ID/env-vars/$1" "$body" >/dev/null
  echo "  set $1"
}
set_secret() { # key generator-command
  if has "$1"; then echo "  kept $1 (already set)"; else set_var "$1" "$($2)"; fi
}

rand48() { node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"; }
key32() { openssl rand -base64 32; }

# --- secrets you provide ----------------------------------------------------
if has DATABASE_URL; then
  read -rp "DATABASE_URL is already set. Replace it? [y/N] " r
else r=y; fi
if [[ $r =~ ^[Yy]$ ]]; then
  read -rsp "Neon DIRECT connection string (hidden): " DB; echo
  [[ $DB == postgres* ]] || { echo "That doesn't look like a postgres:// link."; exit 1; }
  [[ $DB != *-pooler* ]] || { echo "That is the POOLED link (-pooler). Use the direct one."; exit 1; }
fi
if ! has SEED_PASSWORD; then
  read -rsp "Demo account password, 12+ chars (hidden): " SEED; echo
  [ ${#SEED} -ge 12 ] || { echo "Too short."; exit 1; }
fi

echo "Setting environment variables…"
[ -n "${DB:-}" ] && set_var DATABASE_URL "$DB"
[ -n "${SEED:-}" ] && set_var SEED_PASSWORD "$SEED"

# Generated secrets. Save copies of the two that must never change.
NEW_PEPPER=""; NEW_DEK=""
has HASH_PEPPER || NEW_PEPPER=$(rand48)
has DATA_ENCRYPTION_KEY || NEW_DEK=$(key32)
set_secret JWT_ACCESS_SECRET rand48
set_secret JWT_STEPUP_SECRET rand48
[ -n "$NEW_PEPPER" ] && set_var HASH_PEPPER "$NEW_PEPPER" || echo "  kept HASH_PEPPER (already set)"
[ -n "$NEW_DEK" ] && set_var DATA_ENCRYPTION_KEY "$NEW_DEK" || echo "  kept DATA_ENCRYPTION_KEY (already set)"

# Plain settings (demo / paper-trading deployment).
for kv in \
  NODE_VERSION=22 NODE_ENV=development "APP_NAME=The K" DB_POOL_MAX=5 \
  CORS_ORIGINS=http://localhost:3000,http://localhost:8081 DATA_ENCRYPTION_KEY_ID=k1 \
  COOKIE_SECURE=true TRUST_PROXY=true SMS_PROVIDER=dev LIVE_TRADING_ENABLED=false \
  MARKET_FEED=simulated MARKET_HOURS=always_open LOG_FORMAT=json LOG_ARCHIVE_DIR=/tmp/log-archive; do
  set_var "${kv%%=*}" "${kv#*=}"
done

# Service settings. Docker: Dockerfile in apps/api (migrations + demo seed run at container start).
# Node: build/start commands (migrations + demo seed run during the build).
RUNTIME=$(api GET "/services/$SERVICE_ID" | node -e '
  let d = ""; process.stdin.on("data", c => d += c).on("end", () => { const s = JSON.parse(d).serviceDetails ?? {}; console.log(s.runtime ?? s.env ?? "unknown"); });')
echo "  service runtime: $RUNTIME"
if [ "$RUNTIME" = docker ]; then
  BODY=$(node -e 'console.log(JSON.stringify({ rootDir: "apps/api", serviceDetails: { envSpecificDetails: { dockerfilePath: "./Dockerfile", dockerContext: "." } } }))')
else
  BODY=$(node -e 'console.log(JSON.stringify({ rootDir: "apps/api", serviceDetails: { envSpecificDetails: { buildCommand: "npm ci --include=dev && npm run build && npm run db:migrate && npm run db:seed", startCommand: "node dist/main.js" } } }))')
fi
api PATCH "/services/$SERVICE_ID" "$BODY" >/dev/null && echo "  set root directory and $RUNTIME settings" \
  || echo "  (could not update service settings; check Root Directory = apps/api in Settings)"

# Keep the two irreplaceable secrets: copy to clipboard one at a time for your password manager.
if [ -n "$NEW_PEPPER$NEW_DEK" ]; then
  echo
  echo "IMPORTANT: save these in your password manager now (they are not stored anywhere else)."
  if [ -n "$NEW_DEK" ]; then printf %s "$NEW_DEK" | pbcopy; read -rp "DATA_ENCRYPTION_KEY is on the clipboard. Paste it into your password manager, then press Enter… "; fi
  if [ -n "$NEW_PEPPER" ]; then printf %s "$NEW_PEPPER" | pbcopy; read -rp "HASH_PEPPER is on the clipboard. Paste it into your password manager, then press Enter… "; fi
  printf '' | pbcopy
fi

echo "Starting a deploy…"
api POST "/services/$SERVICE_ID/deploys" '{"clearCache":"do_not_clear"}' | node -e '
  let d = ""; process.stdin.on("data", c => d += c).on("end", () => console.log("  deploy " + JSON.parse(d).id + " started"));'
echo "Done. Watch the Logs tab on Render for: migrations applied → Seeded → API listening."
unset RENDER_API_KEY DB SEED NEW_PEPPER NEW_DEK
