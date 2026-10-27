# Before any real money: going-live checklist

This build is a **paper-trading platform**. Every order has `venue = 'SIMULATED'`, every balance is virtual, and the API refuses to start with `LIVE_TRADING_ENABLED=true`. That is deliberate.

## What NOT to build

Some apps in this market look like a trading app, take real deposits, and "fill" orders internally at the last traded price, without sending them to an exchange. Behind a "for educational/training purposes only" notice, this is **off-market ("dabba") trading**. In India it is illegal under the Securities Contracts (Regulation) Act and SEBI rules, and operators have faced criminal prosecution. It also defeats the platform's own goals: there is no exchange guarantee, no investor protection, and the operator is the counterparty to every client loss.

So this codebase will not:
- accept real deposits into an account whose trades are simulated, or
- match client orders against the platform's own book and call that execution.

## The legitimate path to live trading (India)

1. **Licensing.** Brokers on the platform must be **SEBI-registered stock brokers** or **Authorised Persons** of one. The platform operator is either a registered broker, or a technology vendor to one under a written agreement. Get legal counsel.
2. **Execution through a licensed broker API.** Every client has their own trading account (KYC done by the broker) and links it with OAuth/consent. Examples are Kite Connect, Upstox, Angel One SmartAPI and Dhan. To build it, implement `ExecutionVenue` (`apps/api/src/trading/execution-venue.ts`) as a `BrokerApiVenue`:
   - send the order with your idempotency key as the broker's tag; persist the broker order ID;
   - drive status from the broker's order-update webhook or WebSocket, verify signatures, and process each event once (idempotent on the broker order ID + status);
   - positions and funds come **from the broker** and are reconciled, not computed locally.
3. **Client money.** Client funds go to the **broker's** designated client bank account through the broker's own payment rails, never into a platform-owned account. The platform's ledger mirrors and reconciles; it never holds client money.
4. **Payment gateway (if the platform takes fees).** Use an RBI-authorised PA/PG. Verify webhooks by HMAC signature, use the gateway's payment ID as the idempotency key (`payments:{gatewayId}`), and post to the ledger only after verified capture. Keep credentials in the vault, never in `config_versions`.
5. **Market data.** Use a licensed real-time feed (exchange vendor or broker feed) and honour its redistribution terms. Quotes already carry a `source` field, so the UI can label them correctly.
6. **Compliance features:** client KYC status gates, risk disclosure acceptance, margin rules per SEBI/exchange circulars, audit-trail retention, grievance redressal, and data localisation (RBI/CERT-In requirements: log retention and incident reporting within 6 hours).
7. **Security gates:** an external penetration test, a load test, a DR drill, an incident-response runbook, on-call alerting, and sign-off from the broker's compliance team.

Only after all of the above should you add `LIVE` mode. Do it by extending `env.ts` and `ExecutionVenue` to require a configured broker integration. Do not just flip the flag.
