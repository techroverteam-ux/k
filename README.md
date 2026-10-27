# The K: Super Admin, Broker and Trader platform

The K is one codebase with three apps that share a secure GraphQL API:

| App | Path | Stack |
|---|---|---|
| API | `apps/api` | NestJS 11 · GraphQL (Apollo 5, code-first) · PostgreSQL 16 · Drizzle ORM |
| Web portal | `apps/web` | Next.js 15 (App Router) · React 19 |
| Mobile app (Android + iOS) | `apps/mobile` | Expo SDK 56 · Expo Router · React Native 0.85 |

> **Trading mode: SIMULATED (paper trading).** Orders fill against a simulated price feed, and balances are virtual with no cash value. The API refuses to start with `LIVE_TRADING_ENABLED=true`. Read `docs/GOING_LIVE.md` before you connect real money.

## Quick start (macOS)

```bash
# 1. Database
docker compose up -d postgres          # or use your own Postgres 16

# 2. API
cd apps/api
cp .env.example .env                   # then replace every secret (see comments in the file)
npm ci
npm run db:migrate                     # applies schema + integrity triggers
npm run db:seed                        # dev accounts (password = SEED_PASSWORD in .env)
npm run dev                            # http://localhost:4000/graphql

# 3. Web portal (new terminal)
cd apps/web && npm ci && cp .env.example .env.local && npm run dev    # http://localhost:3000

# 4. Mobile (new terminal)
cd apps/mobile && npm ci
echo "EXPO_PUBLIC_API_URL=http://<your-mac-LAN-IP>:4000" > .env
npm start                              # scan the QR code with Expo Go, or press a / i
```
Add your phone's origin to `CORS_ORIGINS` only if you use the web build of the mobile app. Native apps don't need CORS.

### Seeded dev accounts (password = `SEED_PASSWORD`)

| Username | Role | Notes |
|---|---|---|
| `admin` | Super Admin | Must set up TOTP two-step verification at first sign-in |
| `checker` | Super Admin | The second admin needed for maker-checker approvals |
| `broker.one` | Broker | Assigned traders: `trader.one`, `trader.two` |
| `broker.two` | Broker | Assigned trader: `trader.three` |
| `trader.one` … `trader.three` | Trader | Start with ₹5,00,000 in virtual funds |

New traders can use **Create account** on the login screen (mobile OTP, then a Super Admin approves the account), and anyone can reset a forgotten password by OTP to their registered mobile (Super Admins excepted). To create a demo trader, use **Try a demo** on the login screen. It works by mobile OTP. In development the OTP appears on screen, and it is never sent or logged.

## What each role can do

- **Super Admin:** create, approve, suspend and reactivate accounts; assign traders to brokers; reset passwords; review deposits and withdrawals; change business configuration (versioned, maker-checker, with rollback); view the hash-chained audit log; run reconciliation; see risk alerts.
- **Broker:** sees only their own assigned traders, with balances, positions, orders and ledger as read-only views. Can add traders (a Super Admin approves them), submit payment requests for their traders, and view their commission report.
- **Trader:** up to 10 watchlists with streaming quotes and bid/ask boxes, order ticket (market, limit, stop-loss and take-profit at LTP) with quantity limits, quick-price chips, market-session status, margin preview and confirmation, positions, orders (pending, executed, rejected), P&L by period (incl. custom dates), PDF statements ("bill download"), rejection log, permanent ledger, deposit and withdrawal requests, sessions and devices, login history, display preferences (theme, hide balances, number size, bold numbers, charts, trade sounds), notifications. Traders accept the trading rules at the start of every session before they can place orders.

The server enforces every one of these rules. See `docs/AUTHORIZATION.md`.

## UI / UX

The interface takes Groww as its usability reference: clean white surfaces, one green accent, divider-led lists, a stock page with a docked Buy/Sell panel, and bottom tabs on mobile (Home · Watchlist · Portfolio · Funds · Profile). The brand is **The K**: a single geometric “K” used for the logo, app icons, favicon and the animated splash that plays after every sign-in. Colours and icons are original. Tokens, components, the screen inventory and the validation log are in `docs/DESIGN_SYSTEM.md`.

## Security and financial integrity (summary)

- Double-entry ledger in integer **paise** (BigInt). Database triggers make journals, postings and audit events **append-only** and reject **unbalanced** journals at commit.
- Idempotency keys on payments, orders and ledger postings. Retries and concurrent duplicates never double-post (covered by tests).
- SERIALIZABLE transactions that retry, plus per-account row locks on every money movement.
- argon2id passwords, 15-minute access JWTs, refresh-token rotation with reuse detection, httpOnly SameSite=Strict cookie on web, Keychain/Keystore (SecureStore) on mobile.
- Mandatory TOTP MFA for Super Admins, and **step-up re-verification** for approvals, config changes, suspensions and password resets.
- Maker-checker: nobody approves their own payment request, config change or account creation.
- IDOR protection: cross-account reads return `NOT_FOUND` and write an audit entry.
- GraphQL depth limit (8), cost limit (1500), 100 kB body limit, CSRF prevention, no introspection in production, masked errors, per-IP rate limits.
- A hash-chained audit log that redacts secrets, and a reconciliation job with 7 independent checks.
- **Sessions & encryption**: per-role concurrent-login policy with *force login*, idle and maximum session length, live sign-out with a reason; phone/email encrypted (AES-256-GCM + blind index) with key rotation; strict input validation. See `docs/SESSIONS_AND_ENCRYPTION.md`.
- **Trading consent per session**: the rules a trader accepted, with time, IP, device, session and the exact rules text (SHA-256), in an append-only table. Orders are refused until it exists. Login audit (successful and failed sign-ins) for users and Super Admins.
- **Every request is logged** with time, IP, device, session and outcome. Logs are append-only, archived daily with SHA-256 checksums, and searchable by Super Admins (by IP, account or time) under Activity log. Users see their own activity. See `docs/LOGGING.md`.

Full threat model and controls: `docs/SECURITY.md`.

## Tests

```bash
cd apps/api && cp .env .env.test   # point DATABASE_URL at a throwaway DB (…/tradedesk_test), NODE_ENV=test, THROTTLE_SCALE=20
npm test
```
The 50 end-to-end tests run against real PostgreSQL. They cover authentication, refresh-token reuse, OTP, role checks, IDOR, broker scoping, MFA enforcement, step-up, maker-checker (payments and config), concurrent idempotency (payments and orders), quantity limits, P&L through the ledger, limit-order matching, append-only and balanced-journal triggers, reconciliation, audit-chain verification, secret redaction, query cost limits and error masking.

## Repository layout

```
apps/api/        NestJS GraphQL API
  src/db/          schema.ts (Drizzle), db.ts (pool + serializable retry)
  drizzle/         SQL migrations (0001_integrity.sql = triggers & constraints)
  src/auth/        login, MFA, OTP, sessions, step-up, global guard
  src/policy/      resource-level authorization
  src/ledger/      double-entry ledger
  src/payments/    deposit/withdrawal requests + approvals
  src/trading/     simulated venue, orders, positions
  src/market/      simulated market-data feed + subscriptions
  src/config-mgmt/ versioned maker-checker configuration (+ admin resolvers)
  src/audit/       hash-chained audit log
  src/reconciliation/
  test/e2e.spec.ts
apps/web/        Next.js portal: /trader, /broker, /admin, /account
apps/mobile/     Expo app: (trader), (broker), (admin) tab groups
docs/            architecture, security, authorization matrix, going-live checklist
```
