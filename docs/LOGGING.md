# Logging: every action, with time and IP

This document covers what the platform records, where it is stored, and how to run it in production.

## The three layers

| Layer | What it records | Where | Tamper protection | Kept for |
|---|---|---|---|---|
| **1. Audit trail** (`audit_events`) | Money and security events: logins, MFA, orders, fills, deposits, withdrawals, approvals, config changes, account changes, denied access | PostgreSQL. Written **in the same DB transaction** as the change itself, so an order cannot exist without its audit row | Hash chain (each row hashes the previous one), DB triggers block UPDATE/DELETE/TRUNCATE, daily archive with SHA-256 | Forever in the DB, plus archives |
| **2. Activity log** (`activity_log`) | **Every API request**: every GraphQL query and mutation, live-feed (WebSocket) connect, subscribe and disconnect, failed and rejected requests | PostgreSQL, buffered and written in batches (≤ 0.5 s) so it never slows a trade | Triggers block UPDATE/TRUNCATE. DELETE only works through `td_purge_activity()`, which refuses days that haven't been archived | `logs.activityRetentionDays` (default 365) in the DB, then the archive |
| **3. Application log** (stdout, JSON) | Server events, errors, and (optionally) one line per request | Your log platform (CloudWatch / Loki / ELK / Datadog) | Whatever the log platform provides | Per log-platform policy |

The **request ID** links all three. Every response has an `x-request-id` header. The same ID is stored on the activity row, on every audit event, and on the order or payment request the call created. From any one of them, you can find the others.

## What is stored for every request

| Field | Example | Notes |
|---|---|---|
| `at` | `2026-10-27 07:24:39.120+00` | Server time (UTC, ms precision). The UI shows it in IST. |
| `request_id` | `d8728925-2db4-…` | Also returned to the client in `x-request-id` |
| `user_id`, `role` | trader.one / TRADER | Also filled for sign-in attempts against an existing account, including failed ones |
| `session_id` | `ab145a05-…` | Which signed-in device |
| `ip` | `49.36.12.4` | See "IP addresses" below |
| `user_agent`, `client` | `Safari · iOS`, `web` / `mobile` | |
| `op_type`, `op_name`, `fields` | `mutation`, `placeOrder` | |
| `variables` | `{"instrumentId":"…","quantity":10}` | **Secrets are removed before storage.** Passwords, OTPs, TOTP codes and tokens are found by the argument they feed, not the variable name, so `$p` → `password` is still redacted. Phone numbers are masked. Capped at 2 KB. |
| `outcome`, `error_code`, `duration_ms` | `ERROR`, `FORBIDDEN`, `14` | |

Business records are stamped too:

- **orders:** `client_ip`, `user_agent`, `session_id`, `request_id`
- **payment_requests:** `requested_ip`, `requested_user_agent`, `requested_session_id`, `reviewed_ip`, `reviewed_at`, `request_id`
- **audit_events:** `ip`, `user_agent`, `session_id`, `request_id`. These are part of the hash on new rows, and old rows still verify.

Never stored: passwords, OTPs, TOTP codes, access or refresh tokens, or secrets (`SECURITY.md`, "Secrets in logs"). The e2e tests check this.

## Trading consent and login audit

- **Consent, every session.** After each sign-in a trader sees the Terms & Rules and must tap *I understand & accept* before trading. The API refuses `placeOrder` (`FORBIDDEN`, reason `CONSENT_REQUIRED`) until the current session has accepted the current rules.
- Each acceptance is a row in `trading_consents`: user, session, **time, IP, device (user agent), client (web/mobile), request ID**, the **exact rules text** and its **SHA-256** (`terms_version`). The table is append-only (database trigger) and an audit event `consent.accepted` is written in the same transaction. If an admin changes the rules, the version changes and everyone is asked again.
- **Login audit** comes from the hash-chained audit trail: `auth.login` (with method: password, password + 2-step code, OTP), `auth.login_failed`, `auth.mfa_failed`, `auth.login_locked`, `auth.login_inactive`, password resets/changes and sign-outs — each with time, IP, device and session.
- Where to see them: users → *Profile → Login history* (web and app); Super Admins → **Login & consent** (`/admin/logins`, filters + CSV export) and on each account page. GraphQL: `tradingConsentStatus`, `acceptTradingConsent`, `consentLog`, `loginHistory`, `loginAudit`.

## IP addresses

- **Default (`TRUST_PROXY=false`):** the IP is the TCP peer address. Any `X-Forwarded-For` header is **ignored**, so a client can't fake its IP. There's a test for this.
- **Behind a load balancer (`TRUST_PROXY=true`):** the IP is the **right-most** `X-Forwarded-For` entry, which is the one your load balancer appended. Only turn this on when the API can be reached **only** through that load balancer. Otherwise clients can spoof their IP again.
- With more than one proxy hop (CDN → LB → API), adapt `clientIp()` in `apps/api/src/common/request-context.ts` to skip the known hops.
- IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to `1.2.3.4`, so one client always logs as one IP.

## Where to see it

| Who | Screen | What |
|---|---|---|
| Super Admin | **Activity log** (`/admin/activity`) | Search by IP, operation, time range and result. "Actions & sign-ins" or everything. Expand a row for request ID, session and full device. Click an IP to see **every account that used it** (multi-accounting / shared-device signal). Export CSV (up to 10,000 rows; protected against spreadsheet formula injection). |
| Super Admin | Activity log → **Archives & retention** | Retention settings, archive files with checksums, **Verify** button, "Archive & apply retention now" (needs a step-up code) |
| Super Admin | **Accounts → a user** | IPs used in the last 90 days, how many other accounts shared each one, and recent actions |
| Super Admin | **Audit trail** (`/admin/audit?requestId=…`) | Audit events with time, IP, device, session, request ID, chain verification |
| Every user | **Profile & security → Account activity** (web), **Profile → Account activity** (app) | Their own sign-ins and actions with time, IP and device |

Only Super Admins can search other people's logs. Those searches are themselves recorded in the activity log.

GraphQL (for integrations or a SIEM pull): `activityLog(filter, limit, beforeId)`, `accountsOnIp(ip, days)`, `userIps(userId, days)`, `logArchives`, `verifyLogArchive(day, kind)`, `myActivity`, mutation `runLogMaintenance`.

## Retention and archiving

Every 15 minutes, the API runs maintenance. Only one instance runs it, enforced by a Postgres advisory lock:

1. **Archive** each complete UTC day that isn't archived yet, for both the audit trail and the activity log:
   - Writes `LOG_ARCHIVE_DIR/YYYY/MM/<day>-<kind>.ndjson.gz` and a `.manifest.json`.
   - Records the SHA-256, row count, first/last ID and the last audit hash in `log_archives`, which is append-only.
2. **Purge** activity rows older than `logs.activityRetentionDays`. Only days already archived are purged (`logs.requireArchiveBeforePurge = true`).
3. Delete OTP challenges older than 1 day, and sessions that ended more than 90 days ago.
4. Write a `logs.maintenance` audit event with the counts.

**The audit trail is never purged from the database.**

The settings live in **Configuration** and change through maker-checker approval:

| Key | Default | Range |
|---|---|---|
| `logs.activityRetentionDays` | 365 | 30–3650 |
| `logs.requireArchiveBeforePurge` | true | |
| `logs.quietOperations` | `[]` | Query field names that are *not* logged, e.g. `["quotes","accountSummary"]`. Mutations are always logged. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `LOG_ARCHIVE_DIR` | `./log-archive` | Where archives are written |
| `LOG_MAINTENANCE` | `on` | Set `off` on all but one instance if you don't want the advisory-lock approach |
| `LOG_FORMAT` | `json` in production | `json` or `pretty` |
| `LOG_REQUESTS_STDOUT` | `false` | Also print one JSON line per request (without variables) for your log platform |

### Runbook

```bash
cd apps/api
npm run db:migrate                                   # applies 0002_logging + 0003_logging_integrity
npm run logs:archive -- 2026-10-26                   # archive one past day by hand (idempotent)
npm run logs:archive -- 2026-10-01 2026-10-26        # a range
npm run logs:verify  -- 2026-10-26                   # re-hash files and compare with recorded checksums
```

Investigating "who did this?":

1. Find the order, payment or audit row. Copy its `request_id`.
2. Go to Audit trail `?requestId=…`, or Activity log → expand the row.
3. Click the IP to see other accounts on it. Click the account for all its IPs.

## Production setup

1. **Write-once storage for archives.** Point `LOG_ARCHIVE_DIR` at a mounted volume and sync it to **S3 with Object Lock (compliance mode)** or a GCS bucket with a retention policy, such as an hourly `aws s3 sync`. A local disk is not tamper-proof. Keep a second copy in another region/account.
2. **Least-privilege database role.** The app role must not be able to delete logs directly:
   ```sql
   REVOKE UPDATE, DELETE, TRUNCATE ON activity_log, log_archives, audit_events FROM tradedesk_app;
   -- td_purge_activity() is SECURITY DEFINER: owned by the migration role, callable by the app
   ALTER FUNCTION td_purge_activity(timestamptz, boolean) OWNER TO tradedesk_migrator;
   REVOKE ALL ON FUNCTION td_purge_activity(timestamptz, boolean) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION td_purge_activity(timestamptz, boolean) TO tradedesk_app;
   ```
   Also make sure the app role can't `SET td.purge`. If it is not a superuser and the triggers are owned by the migration role, the purge function is the only path.
3. **Ship stdout to a log platform.** Set `LOG_FORMAT=json`. Each line has `level`, `msg`, `requestId`, `userId`, `ip`. Send it to CloudWatch, Loki, ELK or Datadog. Alert on:
   - `activity_log_fallback`: DB log writes failing; rows are going to stdout instead
   - spikes in `ERROR` outcomes, `FORBIDDEN`, `UNAUTHENTICATED`
   - `auth.refresh_reuse_detected`
   - failed `logs.maintenance` or archive verification
4. **Volume.** A row is about 0.5–1 KB including indexes.
   - Rough size: `active users × requests per user per day × 1 KB`.
   - Logging every background read is the heavy part. A trader polling every 3 s for 6 h is about 7,000 rows/day. Add polling queries to `logs.quietOperations` if you don't need them; actions are always kept.
   - Above roughly 50M rows, switch `activity_log` to **monthly range partitions** on `at`. Retention then becomes "archive, then drop partition", which is instant and avoids table bloat. Use `pg_partman` or a monthly migration.
5. **Clock.** Use NTP on all API hosts: activity timestamps come from the API server when the request arrives.

## Privacy and compliance

- IP addresses and device details are **personal data** under India's DPDP Act 2023. The platform:
  - tells users in the terms rules that time, IP and device are recorded;
  - lets users see their own log;
  - limits search to Super Admins;
  - masks phone numbers;
  - never stores secrets.
- Before going live, get your compliance team or legal counsel to confirm:
  - **Retention periods.** Brokers and intermediaries have SEBI/exchange record-keeping obligations, and the activity window may need to be longer than the default. Set `logs.activityRetentionDays` to the confirmed figure.
  - Whether CERT-In log retention directions apply to you.
  - Your privacy notice text.
- This document doesn't give regulatory numbers on purpose. Confirm them for your licence type.

## Tests

`apps/api/test/e2e.spec.ts` → "activity log & audit enrichment":

- Secrets redacted, including under arbitrary variable names and in malformed requests.
- Spoofed `X-Forwarded-For` ignored.
- The same request ID on the order, audit and payment rows.
- Admin-only search.
- Append-only enforcement.
- Archive → purge only archived days → tamper detection on the archive file.
- Audit chain still verifies with the new fields.
