# Release readiness review - 12 November 2026

## Implemented

- Three roles only: SUPER_ADMIN, BROKER, TRADER. One active Super Admin enforced in PostgreSQL.
- Migration 0024 keeps active username `admin` if present, otherwise the oldest active Super Admin. Additional admin identities are suspended and their sessions revoked; historical audit references are preserved. Review this selection before production deployment.
- Admin-created brokers/traders activate immediately. Broker-created traders still require the sole admin's approval, including opening funds. Trader reset approvals remain with the assigned broker or admin.
- Settings, payment details, permanent account deletes and full wipes no longer require another admin. Full wipes retain typed confirmation, reason and audit history.
- Admin commission reporting is collected brokerage less broker commission. Admin and broker PDF/Excel exports are available on web and native mobile. New native modules require a rebuilt APK.
- Migration 0025 snapshots broker identity and commission at each future fill, preventing rate or assignment changes from repricing those fills. Older fills without a snapshot use the existing report fallback (current assignment/rates); historical rates cannot be reconstructed from this migration.
- Dhan Full packets use their own OHLC offsets and market depth; previous-close packets never reset LTP. Full subscription requests include bid/ask depth. Missing Dhan mappings never receive synthetic ticks. Orders stop filling on missing/stale live quotes (60 seconds).
- Charts use receipt time. Raw exchange time is retained separately because a sampled provider trade timestamp appeared ahead of UTC. No undocumented timezone correction is applied.

## Verification

- PostgreSQL E2E: account permissions, trader creation/approval, opening balances, order idempotency, fees on entry/exit, broker and platform earnings, PDF/Excel signatures, snapshot stability after rate change, payment-detail visibility for broker/trader, authenticator password recovery and session revocation, resets/deletes, single-admin full wipe.
- Isolated reset/login suite: five-attempt lockout, one-hour cooldown, retained staff history, re-enable with zero balance, and second-active-admin database constraint.
- API/web builds, TypeScript checks for all three apps, Android Metro/Hermes bundle export.
- Read-only live sample: NSE_EQ security 1333 returned INR 811.60 via both Dhan REST LTP and WebSocket Full feed. Packet depth/OHLC decoding has regression coverage. This sample does not certify every instrument mapping or global-stock feed.

## Remaining release checks

- Production migrations have not been applied by this review. Deploy and verify the intended primary administrator remains active.
- Verify file sharing and destructive-action confirmations on a physical Android/iOS device; bundle export is not a device test.
- Reconcile pre-snapshot commission history if historic broker assignments or rates changed.
- Confirm Dhan timestamp convention and perform mapping checks across each supported exchange; the successful domestic sample is not a full feed certification.
- Screenshot controls and additional security hardening are deferred as requested. Browser requests remain inspectable by their owner; do not ship secrets to frontend clients.

## Follow-up checks

- Fixed platform commission aggregation to return one row per trader even after reassignment, and to include snapshots whose former broker no longer exists. Added reassignment regression coverage.
- Removed cross-segment security-ID fallback: a domestic instrument and index sharing the same security ID cannot update each other's quote.
- Matched omitted Global Stock packet lengths to the official SDK packet sizes. Separated previous-close fields from OHLC fields and tested concatenated packets.
- Live catalog sync no longer inserts demo catalog entries; demo seeding preserves existing live mappings.
- Read-only command: `npm --prefix apps/api run instruments:audit-dhan`. It compares active instruments with Dhan's official domestic and global catalogs and exits nonzero for issues. It makes no database changes.
- Local catalog audit: 200 domestic and 7 global mappings passed. Issues: 25 expiry mismatches, 17 unmapped/demo instruments, 4 expired currency contracts, 4 global symbol/security-ID mismatches, and 1 mapping absent from the official domestic master. Do not treat the current catalog as release-ready. Repair catalog metadata/mappings with an explicit review of open positions; never silently roll a currency contract under an existing position.
- Browser fixtures at 390px and 1280px passed admin/broker PDF and Excel download flows and immediate admin wipe confirmation, with no page errors or horizontal overflow. Mocked API responses prevented real account changes. A shared metric wrapping fix resolves the commission page's narrow-screen overflow.
- Android tooling is installed but no device/emulator is attached; physical file-sharing checks remain outstanding.

- The four global symbol mismatches are explicitly labelled ETF proxies (SPX -> SPY, NDX -> QQQ, DJI -> DIA, RUT -> IWM), not four random wrong security IDs. Migration 0026 corrects names/categories only when the expected mapping matches and the canonical symbol does not already exist. It preserves instrument identity and trading history. Rows skipped due to a canonical-symbol conflict remain an audit finding for manual reconciliation.
- Full UI/browser fixtures now pass at phone and desktop widths after rebuilding. No physical device is attached.

## Dhan setup completion

Automatic maintenance and API-key authorization are now implemented; see [Dhan setup](dhan-setup.md). Migration 0027 adds backend-only integration state and browser connection tickets. Production has not been modified by these checks.

A real catalog import in an isolated database passed with 2,295 supported instruments and unchanged accounts. The previous local catalog findings are now handled by the maintenance engine on deployment: correct metadata for the same contract, retire invalid mappings without deleting their history, and import verified supported contracts. Unsupported sub-paise contracts stay unavailable; they are not replaced by an invented price.
