# Sessions, concurrent logins, encryption and input validation

## 1. How a session works

| Piece | Where it lives | Lifetime | Protection |
|---|---|---|---|
| **Access token** (JWT, HS256) | Memory only (web and app) | 15 min (`ACCESS_TOKEN_TTL_SEC`) | Signed. Every request also checks the session row, so revocation is immediate. The role is read from the DB, not the token. |
| **Refresh token** | Web: `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/graphql`. App: Keychain/Keystore (`expo-secure-store`, this device only). | Up to the role's `maxHours` (and never beyond `REFRESH_TOKEN_TTL_DAYS`) | Stored server-side only as an HMAC. Rotated on every use. Replaying an old one revokes the session (theft detection). |
| **Session row** (`sessions`) | PostgreSQL | Until it is revoked, expires, or goes idle | Holds the device name, user agent, IP, created and last-active times, MFA state and the revoke reason. |

A session ends when:

- **Sign-out** (`logout`).
- **Sign out a device / sign out other devices** (Profile → Signed-in devices).
- **Password change or reset.** A change signs out the other devices; a reset signs out all of them.
- **Idle timeout:** no activity for `idleMinutes`.
- **Maximum length:** `maxHours` after sign-in.
- **Another device forces a login** (see below).
- **A Super Admin signs it out** (Accounts → account → Signed-in devices; step-up code required).
- **Refresh-token reuse detected.**

The signed-out device is told **immediately** over the live connection (`sessionEvents` subscription) and goes to the sign-in screen with the reason, for example: *"You were signed out because your account was signed in on another device."* If the device was offline, it gets the same message on its next request (`extensions.reason`: `SESSION_REPLACED`, `SESSION_IDLE`, `SESSION_REVOKED`, `SESSION_EXPIRED`).

## 2. Concurrent login detection and "force login"

Policy per role lives in **Configuration → `security.sessionPolicy`**. Changes go through maker-checker.

| Role | Default devices at once | When one more device signs in | Idle sign-out | Max session |
|---|---|---|---|---|
| Super Admin | 1 | ask | 30 min | 12 h |
| Broker | 1 | ask | 120 min | 24 h |
| Trader | 1 | ask | 8 h | 24 h |

`maxConcurrent: 0` means unlimited. `onLimit` options:

- **`ask`** (default): the sign-in succeeds as far as the password, two-step code or OTP, but **no session is created yet**. The user sees *Already signed in*, with the other device's name, IP and last-active time, and two choices:
  - **Sign out other device & continue here:** calls `forceLogin(conflictToken)`. The token is valid for 2 minutes and works only from the same browser or app that asked for it. The other device is signed out at once, and the user is notified.
  - **Cancel:** nothing changes.
- **`replace_oldest`:** the oldest device is signed out automatically.
- **`block`:** the new sign-in is refused until the user signs out on the other device.

Everything is audited and shows in *Login history* and the admin *Login & consent* page:

- `auth.concurrent_login_detected`
- `auth.force_login` (lists the devices it signed out)
- `auth.session_replaced`
- `auth.concurrent_login_blocked`
- `auth.sessions_revoked_by_admin`

The check runs for every sign-in method: password, password + 2-step code, demo OTP.

## 3. Encryption

**In transit:** TLS everywhere (HTTPS, and `wss://` for live data), with HSTS on the web app. There is no home-made "encrypt the request body" layer on top of TLS; that adds risk without adding protection. For the mobile app in production, consider certificate pinning (for example `react-native-ssl-public-key-pinning`) once the API's certificate chain is final.

**At rest, in the application (field-level).** AES-256-GCM, format `enc:v2:<keyId>:<iv|tag|ciphertext>` (`apps/api/src/common/crypto.ts`):

| Data | Stored as |
|---|---|
| Mobile number, email | Ciphertext (`phone_enc`, `email_enc`) plus a **blind index** (keyed HMAC, `phone_hash`, `email_hash`) for lookups and uniqueness. The plaintext columns are emptied by the migration and will be dropped in a later release. |
| TOTP (2-step) secrets | Ciphertext |
| OTP challenges | The code as an HMAC; the phone as its blind index. Never the number. |
| Passwords | argon2id (one-way) |
| Refresh tokens | HMAC (one-way) |

- **Column binding:** each ciphertext is bound to its column (AAD such as `users.phone`), so a value copied into another column won't decrypt.
- **Keys** come only from the environment or your secrets manager:
  - `DATA_ENCRYPTION_KEY` and `DATA_ENCRYPTION_KEY_ID`
  - `DATA_ENCRYPTION_KEYS_PREVIOUS` (old keys, read-only)
  - `BLIND_INDEX_KEY` (optional; otherwise derived from `HASH_PEPPER` with HKDF)
  - In production, keep them in AWS KMS / GCP KMS / Vault and inject them at start-up.
- **Rotation:**
  1. Generate a new key: `openssl rand -base64 32`.
  2. Set it as `DATA_ENCRYPTION_KEY` with a new `DATA_ENCRYPTION_KEY_ID`, and move the old key to `DATA_ENCRYPTION_KEYS_PREVIOUS` as `k1:<base64>`.
  3. Deploy, then run `npm run keys:rotate`. Add `-- --reindex` if you also changed `BLIND_INDEX_KEY`.
  4. Remove the old key.
  - Never change `HASH_PEPPER` or `BLIND_INDEX_KEY` without `--reindex`, or lookups by phone or email stop matching.

**At rest, infrastructure:** use a managed Postgres with storage encryption (KMS), encrypted backups and snapshots, and S3 with SSE-KMS and Object Lock for log archives (`docs/LOGGING.md`).

Tests cover:

- ciphertext-only storage
- blind-index lookups
- column binding
- decrypting with the previous key during rotation
- OTP rows never containing the number

## 4. Input validation

Three layers, all on the server. The clients' form checks are for convenience only.

1. **Request hygiene, on every operation** (`inputHygienePlugin`). It rejects:
   - control characters, and the bidi-override characters used to disguise text (`U+202E` etc.);
   - strings over 5,000 characters;
   - lists over 500 items;
   - nesting deeper than 8 levels.

   This covers plain arguments as well as input objects. Ordinary Unicode (names, ₹, emoji) is fine.
2. **Input objects** (`class-validator` + a global `ValidationPipe`, with unknown fields **rejected**):

   | Input | Rules |
   |---|---|
   | `PlaceOrderInput` | UUID instrument; enums; quantity 1–1,000,000; prices `^\d{1,12}(\.\d{1,2})?$`; idempotency key format |
   | `PaymentRequestInput` | money format; UUID; note ≤ 300 |
   | `CreateUserInput` | username pattern; name 2–120; email; phone; UUID broker; password 10–128 |
   | `RegisterInput` | as `CreateUserInput`, plus a 6-digit OTP |
   | `ActivityFilter` | UUID; IP; operation-name pattern; outcome enum; dates |

   Errors come back as `BAD_USER_INPUT` with a readable message.
3. **Business rules in the services:**
   - tick size, quantity and position limits, market hours, SL/TP trigger direction;
   - password strength, phone normalisation, date ranges, ownership checks;
   - database constraints as the last line of defence: balanced journals, price-by-order-type, append-only tables.

Other protections:

- GraphQL depth and complexity limits.
- 100 KB body limit.
- Per-IP rate limits on sign-in, OTP and reset.
- All SQL goes through parameterised Drizzle queries; there's no string-built SQL.
- React escapes all output, and the web app sends a strict Content-Security-Policy.
- Tests cover malformed orders and payments, sign-up fields, control characters, bidi overrides and oversized strings.
