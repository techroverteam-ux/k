# Security design and threat model

## Assets
1. Ledger correctness: balances, P&L, fees, payment postings.
2. Credentials and sessions: passwords, TOTP secrets, refresh tokens.
3. Personal data: phone numbers, emails, trading activity.
4. Administrative powers: approvals, configuration, account status.
5. Audit trail integrity.

## Threats → controls (STRIDE, mapped to the OWASP API Top 10)

| Threat | Control | Where |
|---|---|---|
| **S**poofing: credential stuffing, brute force | argon2id; generic errors; constant-time dummy verify; account lockout (config); per-IP throttling on login, OTP and step-up | `auth.service.ts`, `password.service.ts`, `auth.resolver.ts` |
| Stolen refresh token | Rotation on each use; **reuse detection revokes the session** and notifies the user; httpOnly SameSite=Strict cookie (web); SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (mobile) | `auth.service.ts#refresh`, `mobile/src/api.ts` |
| Admin account takeover | Mandatory TOTP for Super Admins; step-up for sensitive mutations; TOTP secrets AES-256-GCM-encrypted with a key held outside the database | `auth.guard.ts`, `crypto.ts` |
| OTP abuse / SMS pumping | 3 OTPs per number per 10 minutes, 5 verify attempts, single use, 5-minute TTL, OTP hashed with a pepper, IP throttle | `requestDemoOtp`, `verifyDemoOtp` |
| **T**ampering with ledger or audit | DB triggers block UPDATE/DELETE/TRUNCATE; deferred trigger rejects unbalanced journals; mode-mismatch trigger; hash-chained audit with verification | `drizzle/0001_integrity.sql`, `audit.service.ts` |
| Double posting (retries, races) | Idempotency keys (unique indexes) on journals, payments and orders; SERIALIZABLE transactions with retry; `SELECT … FOR UPDATE` on accounts | `ledger.service.ts`, `db.ts` |
| **R**epudiation | Every privileged action is audited in the same transaction: actor, role, IP, outcome, before/after | `AuditService.record` |
| **I**nformation disclosure: IDOR / BOLA (API1) | `PolicyService.assertCanAccessUser` on every user-scoped read; list queries scoped in SQL; denial returns NOT_FOUND | `policy.service.ts` |
| Excessive data exposure (API3) | Explicit GraphQL types; phone and email masked unless owner or admin; no hashes or secrets in the schema | `user.types.ts` |
| Error leakage | `formatError` masks unknown errors; no stack traces; introspection off in production | `app.module.ts` |
| Concurrent sessions | Per-role limit with ask / replace_oldest / block; "force login" via a 2-minute device-bound token; signed-out devices told live (`sessionEvents`) and on next request (`SESSION_REPLACED`); idle timeout and max session length per role; admin sign-out | `auth.service.ts` (`admitSession`, `forceLogin`), `session-policy.ts`, `docs/SESSIONS_AND_ENCRYPTION.md` |
| PII at rest | Phone/email AES-256-GCM with key ids + column-bound AAD and HMAC blind indexes; OTP rows store only hashes; `npm run keys:rotate` | `common/crypto.ts`, `common/pii.ts`, `scripts/rotate-keys.ts` |
| Input validation | Hygiene plugin (control/bidi chars, sizes, nesting) on every request; class-validator DTOs with unknown fields rejected; service-level business rules | `common/validation.ts` |
| Self sign-up & password reset | Sign-up requires mobile OTP and lands PENDING until a Super Admin approves; reset answers identically whether or not the account exists, codes are single-use, hashed and attempt-limited, all sessions are revoked, Super Admins can't self-reset | `auth.service.ts` (`registerTrader`, `requestPasswordReset`, `resetPassword`) |
| Trading consent | Per-session acceptance stored append-only with IP/time/device and the rules' SHA-256; orders refused without it | `consent/`, `0007_consent_integrity.sql` |
| Statement download | PDF via a 2-minute signed link (separate audience) so the access token is never put in a URL; ownership checked when the link is issued; downloads audited | `statements/` |
| Request logging | Every request recorded with time, trusted IP, device, session, request ID and outcome; append-only, archived daily with SHA-256 (`docs/LOGGING.md`) | `logging/`, `0003_logging_integrity.sql` |
| Secrets in logs | Audit metadata sanitizer redacts password/otp/token/secret keys; OTPs are never logged; test asserts it | `sanitize()`, e2e test |
| **D**enial of service (API4) | Depth limit 8, cost limit 1500 with list multipliers, 100 kB body limit, 10 s statement timeout, rate limits, list limits capped at 100 | `complexity.plugin.ts`, `main.ts` |
| **E**levation of privilege: broken function-level auth (API5) | Global guard with `@Roles`; roles re-read from the DB on each request; maker-checker on approvals and config | `auth.guard.ts` |
| Mass assignment / injection | Typed GraphQL inputs; Drizzle parameterized SQL; LIKE wildcards escaped; zod-validated config values | resolvers, `registry.ts` |
| CSRF | Apollo `csrfPrevention`; SameSite=Strict cookie that only carries the refresh token; CORS allowlist | `app.module.ts`, `main.ts` |
| Clickjacking / XSS (web) | CSP, `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff; access token kept in memory only | `web/next.config.mjs` |
| Misconfiguration (API8) | Env validated at boot; production refuses dev SMS, insecure cookies, raised throttles, shared JWT secrets and live trading | `config/env.ts` |
| Secrets in configuration (spec) | The config registry is a closed list of business keys, so unknown keys (e.g. `payments.gatewaySecret`) are rejected; secrets live only in env/vault | `registry.ts`, e2e test |

## Production checklist

- [ ] Keep secrets in a managed vault (AWS Secrets Manager / GCP Secret Manager / Vault). Rotate `JWT_*`, `HASH_PEPPER` and `DATA_ENCRYPTION_KEY` with a documented runbook. Keep `DATA_ENCRYPTION_KEY` in KMS and use envelope encryption.
- [ ] TLS everywhere: HTTPS load balancer, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, HSTS preload, and `wss://` for subscriptions.
- [ ] Least-privilege DB roles. The app role gets `INSERT/SELECT` only on `journal_entries`, `ledger_postings` and `audit_events`, and a separate migration role owns the schema. Example:
  ```sql
  CREATE ROLE tradedesk_app LOGIN PASSWORD '…';
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO tradedesk_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, ledger_postings, audit_events, activity_log, log_archives FROM tradedesk_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tradedesk_app;
  ```
- [ ] Stream audit events to independent WORM storage (e.g. S3 Object Lock, or a SIEM) and alert on `DENIED`/`FAILURE` spikes, `auth.refresh_reuse_detected`, and failed reconciliation.
- [ ] Use a managed Postgres with encryption at rest, PITR, encrypted cross-region backups, and a **quarterly restore drill**.
- [ ] Run more than one API instance. Move the throttler storage and GraphQL PubSub to Redis (`@nest-lab/throttler-storage-redis`, `graphql-redis-subscriptions`). Both are drop-in at the module level.
- [ ] Schedule reconciliation (e.g. every 15 minutes) and freeze withdrawals when it fails.
- [ ] Before any real money moves: dependency scanning (CI already runs `npm audit`), SAST, an external penetration test, and a load test with k6 or Artillery.

## Known gaps / next steps

- **SL/TP are independent orders** (no OCO): when a stop-loss fires, a matching take-profit stays open until the trader cancels it.
- **Market sessions** are configurable (`trading.marketHours`, `trading.marketHolidays`); the INTL close time (02:30) and the holiday list must be confirmed by the business before go-live. Dev/test use `MARKET_HOURS=always_open` (refused in production).

- **TOTP replay window:** a code can be reused within its 30-second window. Next step: store the last accepted time-step per user and reject repeats.
- **Passkeys (WebAuthn)** are not implemented yet. Add them with `@simplewebauthn/server` as a second factor or passwordless option.
- **Suspicious-login detection** currently notifies on a new device or user agent. Next step: add geo/IP-reputation signals and impossible-travel checks.
- **Persisted GraphQL operations:** the cost and depth limits are active. Enabling an allowlist of persisted queries for production clients would add another layer.
- **Data retention:** OTP challenges (1 day), ended sessions (90 days) and the activity log (`logs.activityRetentionDays`, archived first) are purged automatically. Notifications still need a rule. Keep ledger and audit records per the regulatory retention period. See `docs/LOGGING.md`.
