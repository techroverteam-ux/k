# Dhan connection and instrument maintenance

## Dhan registration

Application name: **The K**

Redirect URL: **https://k-api-wijo.onrender.com/integrations/dhan/callback**

Leave the optional Postback URL blank; this integration supplies market data for existing simulated trading.

## Render backend environment

Set these on the API service only, together in one save:

```env
MARKET_FEED=dhan
DHAN_CLIENT_ID=your_existing_dhan_client_id
DHAN_API_KEY=your_generated_api_key
DHAN_API_SECRET=your_generated_api_secret
DHAN_REDIRECT_URL=https://k-api-wijo.onrender.com/integrations/dhan/callback
WEB_APP_URL=https://k-1nxt.onrender.com
DHAN_CATALOG_SYNC=on
COOKIE_SECURE=true
```

Keep existing database, JWT, password-pepper and encryption-key settings unchanged. No Dhan secrets belong in web or mobile environment variables. The old `DHAN_ACCESS_TOKEN` is ignored when API-key mode is configured; remove it after verifying the new connection.

Deploy the prepared code and migrations, then sign in as the Super Admin and open **Market data** (`/admin/market-data` on web; Profile -> Market data on mobile). Choose **Connect Dhan**, complete Dhan browser login, and return to the panel. Dhan requires that browser authorization step; merely setting an API key cannot authorize market requests.

Issued access tokens are encrypted in PostgreSQL and survive service restarts. Their expiry appears in the panel. Use **Reconnect Dhan** when authorization expires. The API key is not a permanent access token, and this integration does not store your Dhan password, PIN or TOTP secret.

## Automatic catalog maintenance

- Streams and validates both official catalogs on startup and hourly in Dhan mode, retaining only supported contracts in memory.
- Refreshes run in the background so the API can start serving requests while a catalog downloads. Manual sync returns immediately; web and mobile show `SYNCING` and poll the final result. Repeated clicks share the running job.
- Applies metadata changes atomically using batched writes and a PostgreSQL advisory lock.
- Keeps stable instrument identities and preserves users, login credentials, orders, ledger history and balances.
- Retires unavailable/expired/demo contracts from new trading; it never silently rolls an open position into another contract.
- Only changed metadata is rewritten on later syncs. Security ID reuse never transfers an old position into a later contract. In-use identity conflicts are flagged for review.
- New instruments have no invented live reference price. No simulated ticks or synthetic charts are served as Dhan data.
- Uses correct domestic paise tick sizes and IST contract expiry interpretation.
- Rejects malformed catalogs, abrupt catalog shrinkage and unsupported subscription sizes. Retains the last successful catalog if refreshing fails. A catalog older than 30 hours blocks order previews and fills until refreshed.
- Supports selected liquid domestic shares/futures, MCX futures, three domestic indices, nearest-expiry NIFTY/BANKNIFTY/FINNIFTY option contracts and the configured global shares/ETFs. It does not import every contract Dhan publishes.
- Contracts requiring ticks finer than one paise remain unavailable in the current price model; this includes some currency contracts. They are not rounded into incorrect tradable prices.
- Candles stay in process memory only. No candle persistence is reintroduced.

The panel reports last successful synchronization, authorization expiry and fresh quote coverage. Fresh quote coverage naturally falls when markets close or instruments are illiquid. Order previews and fills refuse stale or unavailable live data.

The panel also reports domestic/global socket connections, subscriptions, the last received price and Dhan rejection messages. Browser authorization alone does not confirm that market ticks are arriving. For example, Dhan disconnect reason 806 requires a Data APIs subscription; reconnecting cannot replace that subscription. An API 503 is a separate availability problem: inspect the Render API logs for restarts and memory-limit events. App logs saying `Please sign in again` concern the platform session, not the shared Dhan authorization.

Manual commands:

```powershell
npm --prefix apps/api run instruments:audit-dhan
npm --prefix apps/api run instruments:sync-dhan
```

The first command is read-only. The second uses the same safe maintenance engine as the API. Neither recreates user accounts or resets balances. Existing invalid testing positions are retained for review rather than transferred to a different contract.

## Validation completed

- Real official catalog import passed in an isolated local PostgreSQL database: 2,295 supported instruments, with the account count unchanged.
- Mocked provider integration tests cover admin/MFA requirements, browser-bound callbacks, encrypted issued credentials and replay rejection.
- Malformed-download regression test confirms the previous catalog remains unchanged.
- Responsive browser fixture checks cover the status panel, manual refresh and connection launch at 390px and 1280px.
- A live end-to-end login using the newly registered application can only be verified after its credentials are added and the Super Admin completes Dhan authorization.

Official references: https://dhanhq.co/docs/v2/authentication/ and https://dhanhq.co/docs/v2/instruments/ . Global catalog and packet structure follow Dhan's official SDK: https://github.com/dhan-oss/DhanHQ-py .
