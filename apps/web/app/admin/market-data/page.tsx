'use client';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { ErrorState, PageHead, useToast } from '@/components/ui';
export default function MarketData() {
  const q = useQuery<{
    dhanIntegrationStatus: {
      configured: boolean;
      connected: boolean;
      mode: string;
      expiresAt?: string;
      catalogJson: string;
      feedJson: string;
    };
  }>(`{ dhanIntegrationStatus { configured connected mode expiresAt catalogJson feedJson } }`, undefined, {
    pollMs: 15000,
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const s = q.data?.dhanIntegrationStatus;
  const catalog = s ? JSON.parse(s.catalogJson) : {};
  const feed = s ? JSON.parse(s.feedJson) : {};
  const connect = async () => {
    setBusy(true);
    try {
      const d = await gql<{ beginDhanConnection: string }>(`mutation{ beginDhanConnection }`);
      window.location.assign(d.beginDhanConnection);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      const d = await gql<{ syncDhanCatalog: string }>(`mutation{ syncDhanCatalog }`);
      const r = JSON.parse(d.syncDhanCatalog);
      toast(
        r.status === 'SYNCING'
          ? 'Instrument sync started. Progress updates automatically.'
          : r.status === 'HEALTHY'
            ? 'Instrument catalog updated'
            : r.status === 'ATTENTION'
              ? 'Catalog updated. Some existing contracts need review.'
              : (r.error ?? 'Instrument sync could not start. Try again shortly.'),
        !['SYNCING', 'HEALTHY'].includes(r.status),
      );
      await q.refetch();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <PageHead title="Market data" sub="Dhan authorization, live feed health and automatic instrument maintenance." />
      {q.error?.code === 'NETWORK' ? (
        <div className="notice err" role="alert">
          The app cannot reach the API right now. The connection details below may be outdated. Retrying automatically.
          <div>
            <button className="btn btn-sm" onClick={() => void q.refetch()}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        q.error && <ErrorState error={q.error} retry={q.refetch} />
      )}
      <section className="panel panel-pad stack">
        <h2>Dhan connection</h2>
        <p>
          {s?.connected ? 'Authorized' : 'Not authorized'} · {s?.mode ?? 'Loading'}
        </p>
        {s?.expiresAt && <p>Authorization expires: {new Date(s.expiresAt).toLocaleString()}</p>}
        {!s?.configured && <p>Add Dhan client ID, API key, secret and redirect URL to the backend environment.</p>}
        <div>
          <button className="btn btn-primary" disabled={busy || !s?.configured} onClick={() => void connect()}>
            {s?.connected ? 'Reconnect Dhan' : 'Connect Dhan'}
          </button>
        </div>
        <p>
          Only the Super Admin connects Dhan. Broker and trader logins are unaffected. Reconnect here when Dhan
          authorization expires.
        </p>
      </section>
      <section className="panel panel-pad stack">
        <h2>Instrument catalog</h2>
        <p>Status: {catalog.status ?? 'Loading'}</p>
        {catalog.status === 'SYNCING' && (
          <div className="notice">
            Sync is running in the background. You can keep using the app; this page updates automatically.
          </div>
        )}
        <p>
          Last successful sync:{' '}
          {catalog.lastSuccessAt ? new Date(catalog.lastSuccessAt).toLocaleString() : 'Not yet synced'}
        </p>
        <p>
          Fresh live quotes: {feed.freshQuotes ?? 0} / {feed.instruments ?? 0}. Closed or illiquid markets may have no
          fresh trades.
        </p>
        {(['domestic', 'global'] as const).map(
          (key) =>
            feed[key] && (
              <div className="stack" key={key}>
                <p>
                  {key === 'domestic' ? 'Domestic' : 'Global'} feed:{' '}
                  {feed[key].connected ? 'Connected' : 'Waiting for connection'} · {feed[key].subscriptions} instruments
                </p>
                {feed[key].lastTickAt && <p>Last price received: {new Date(feed[key].lastTickAt).toLocaleString()}</p>}
                {feed[key].error && <div className="notice err">{feed[key].error}</div>}
              </div>
            ),
        )}
        {!!catalog.conflicts?.length && (
          <div className="notice err">
            These existing contract identities are in use or conflict with the official catalog and need review:{' '}
            {catalog.conflicts.join(', ')}. Their history is retained; new trading is unavailable for retired contracts.
          </div>
        )}
        {catalog.error && <div className="notice err">{catalog.error}</div>}
        <p>
          The catalog refreshes on startup and hourly. Failed downloads retain the last verified catalog. Expired or
          unsupported contracts are unavailable for new trades.
        </p>
        {catalog.precisionNotice && <p>{catalog.precisionNotice}</p>}
        <div>
          <button className="btn" disabled={busy || !s || catalog.status === 'SYNCING'} onClick={() => void sync()}>
            {catalog.status === 'SYNCING' ? 'Syncing instruments…' : 'Sync instruments now'}
          </button>
        </div>
      </section>
    </div>
  );
}
