# Architecture

```
 ┌──────────────┐   HTTPS (GraphQL)   ┌──────────────────────────────────────────┐
 │ Next.js web  │ ──────────────────▶ │ NestJS API (stateless, horizontally       │
 │ admin/broker │ ◀── WSS (graphql-ws)│ scalable)                                  │
 │ /trader      │                     │  Guard: auth → role → MFA → step-up        │
 └──────────────┘                     │  Resolvers (thin) ─▶ Services (rules)      │
 ┌──────────────┐                     │   Auth · Policy · Users · Ledger ·         │
 │ Expo mobile  │ ──────────────────▶ │   Payments · Orders · Market · Config ·    │
 │ (iOS/Android)│ ◀────────────────── │   Audit · Notifications · Reconciliation   │
 └──────────────┘                     └───────────────┬──────────────────────────┘
                                                      │ pg (pool, 10 s statement timeout)
                                      ┌───────────────▼──────────────────────────┐
                                      │ PostgreSQL 16                              │
                                      │  append-only + balance triggers            │
                                      │  unique idempotency indexes                │
                                      └────────────────────────────────────────────┘
       Secrets: env / vault (never DB)     Scale-out: Redis for throttling + PubSub
```

## Data model (core)

- `users`: role (`SUPER_ADMIN`/`BROKER`/`TRADER`), status, mode (`SIMULATED`/`LIVE`), `broker_id` (traders only, enforced by a CHECK), encrypted MFA secret, lockout counters.
- `sessions`: one row per device; refresh-token **hash**; rotation and revocation timestamps.
- `ledger_accounts`: `cash:{mode}:{userId}` per trader plus system accounts (`FUNDING_SOURCE`, `SIM_MARKET_PNL`, `FEE_INCOME`, `ADJUSTMENT`) per mode.
- `journal_entries` + `ledger_postings`: signed BigInt paise; each journal sums to 0, and its `idempotency_key` is unique.
- `payment_requests`: REQUESTED → POSTED | REJECTED | CANCELLED | FAILED; `journal_id` links to the posting.
- `orders` (idempotent per user), `positions` (net qty, average price, realized P&L), `instruments`, `watchlist_items`.
- `config_versions`: (key, version) unique; at most one PENDING and one APPROVED per key (partial unique indexes).
- `audit_events`: `seq`, `prev_hash`, `hash` (SHA-256 over the canonical JSON).
- `notifications`, `reconciliation_runs`, `otp_challenges`.

## Money flows (all double-entry)

| Event | Debit (+) | Credit (−) |
|---|---|---|
| Demo opening balance | trader cash | FUNDING_SOURCE |
| Deposit approved | trader cash | FUNDING_SOURCE |
| Withdrawal approved | FUNDING_SOURCE | trader cash |
| Simulated profit | trader cash | SIM_MARKET_PNL |
| Simulated loss | SIM_MARKET_PNL | trader cash |
| Brokerage | FEE_INCOME | trader cash |
| Correction | `reverse()` posts the exact negation once (`reverses_id` unique) | |

Available balance = ledger balance − margin used (open positions + resting limit orders) − pending withdrawals.

## Performance notes
- Every list query is indexed on (owner, status, created_at). Lists are capped at 100.
- DataLoader batches the `instrument` look-ups on orders and positions.
- Quotes live in memory and stream over WebSocket. Nothing financial is cached except config, which has a 5-second TTL and is always re-validated inside the write transaction.
- Measure p95 with k6 against `accountSummary`, `orders` and `placeOrder` at the target concurrency before claiming any figure.
