# Authorization matrix

These rules are enforced in the API by `GqlAuthGuard`, which handles authentication, roles, MFA and step-up, and by `PolicyService`, which handles record ownership. The UI only hides what the API already forbids.

**Legend:** ✅ allowed · 🔒 allowed with step-up re-verification · ⛔ denied · *own* = only their own records · *assigned* = only traders whose `broker_id` is this broker

| Operation | Super Admin | Broker | Trader |
|---|---|---|---|
| Sign in / sessions / change password | ✅ (TOTP mandatory) | ✅ | ✅ |
| `me`, notifications, revoke own sessions | ✅ own | ✅ own | ✅ own |
| List / view users | ✅ all | ✅ assigned traders | ⛔ |
| Create broker | ✅ (PENDING) | ⛔ | ⛔ |
| Create trader | ✅ (PENDING) | ✅ under self (PENDING) | ⛔ |
| Approve account | 🔒 not if they created it | ⛔ | ⛔ |
| Suspend / reactivate / close | 🔒 (not self, not admins) | ⛔ | ⛔ |
| Assign trader → broker | 🔒 | ⛔ | ⛔ |
| Reset another user's password | 🔒 (not admins) | ⛔ | ⛔ |
| Account summary, positions, orders, ledger | ✅ any | ✅ assigned | ✅ own |
| Place / cancel order | ⛔ | ⛔ | ✅ own, SIMULATED only |
| Request deposit / withdrawal | ✅ for a trader | ✅ for assigned trader (config `payments.brokerMaySubmit`) | ✅ own |
| Approve payment | 🔒 not their own request, not their own account | ⛔ | ⛔ |
| Reject payment | ✅ | ⛔ | ⛔ |
| Cancel payment request | requester | requester | own |
| Commission report | ✅ any broker | ✅ own | ⛔ |
| View config / history | ✅ | ⛔ | ⛔ |
| Propose / decide / rollback config | 🔒 checker ≠ maker | ⛔ | ⛔ |
| Audit log, verify chain | ✅ | ⛔ | ⛔ |
| Reconciliation | ✅ | ⛔ | ⛔ |

## Rules behind the table

- **Role comes from the database on every request**, not from the JWT. A demotion or suspension takes effect on the next call, and suspension also revokes all sessions.
- **Denied resource access returns `NOT_FOUND`, not `FORBIDDEN`.** This keeps other accounts from being enumerated by ID, and every denial is written to the audit log (`authz.denied`).
- **Super Admins without verified MFA** can only call the MFA-enrolment endpoints (`MFA_REQUIRED`), controlled by config `security.adminMfaRequired`.
- **Step-up tokens** are bound to the user and session, last 5 minutes, and are sent in the `x-step-up` header.
- **Super Admin accounts are never created through the API.** Operations provisions them directly in the database, through a controlled runbook.
