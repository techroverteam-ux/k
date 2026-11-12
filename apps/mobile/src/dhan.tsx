import { useState } from 'react';
import * as Linking from 'expo-linking';
import { gql } from './api';
import { Button, ErrorState, Notice, Screen, Section, T, toast, useQuery } from './ui';
export function DhanScreen() {
  const q = useQuery<{
    dhanIntegrationStatus: {
      configured: boolean;
      connected: boolean;
      mode: string;
      expiresAt?: string;
      catalogJson: string;
      feedJson: string;
    };
  }>(`{ dhanIntegrationStatus { configured connected mode expiresAt catalogJson feedJson } }`, undefined, 15000);
  const [busy, setBusy] = useState(false);
  const s = q.data?.dhanIntegrationStatus;
  const c = s ? JSON.parse(s.catalogJson) : {};
  const f = s ? JSON.parse(s.feedJson) : {};
  const action = async (connect: boolean) => {
    setBusy(true);
    try {
      if (connect) {
        const d = await gql<{ beginDhanConnection: string }>(`mutation{beginDhanConnection}`);
        await Linking.openURL(d.beginDhanConnection);
      } else {
        const d = await gql<{ syncDhanCatalog: string }>(`mutation{syncDhanCatalog}`);
        const r = JSON.parse(d.syncDhanCatalog);
        toast(r.status === 'HEALTHY' ? 'Catalog updated' : r.error, r.status !== 'HEALTHY');
      }
      await q.refetch();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen back title="Market data" onRefresh={q.refetch}>
      {q.error && <ErrorState error={q.error} retry={q.refetch} />}
      <Section title="Dhan connection">
        <T>
          {s?.connected ? 'Authorized' : 'Not authorized'} ? {s?.mode ?? 'Loading'}
        </T>
        {s?.expiresAt && <T>Expires: {new Date(s.expiresAt).toLocaleString()}</T>}
        {!s?.configured && <Notice>Add Dhan credentials to the backend environment.</Notice>}
        <Button
          title={s?.connected ? 'Reconnect Dhan' : 'Connect Dhan'}
          busy={busy}
          disabled={!s?.configured}
          onPress={() => void action(true)}
        />
        <T>Complete Dhan login in your browser, then return here. Credentials are kept on the backend.</T>
      </Section>
      <Section title="Instrument catalog">
        <T>Status: {c.status ?? 'Loading'}</T>
        <T>Last success: {c.lastSuccessAt ? new Date(c.lastSuccessAt).toLocaleString() : 'Not yet synced'}</T>
        <T>
          Fresh quotes: {f.freshQuotes ?? 0} / {f.instruments ?? 0}
        </T>
        {!!c.conflicts?.length && (
          <Notice tone="err">
            Contract identities requiring review: {c.conflicts.join(', ')}. Existing history is retained.
          </Notice>
        )}
        {c.error && <Notice tone="err">{c.error}</Notice>}
        {c.precisionNotice && <T>{c.precisionNotice}</T>}
        <T>Refreshes on startup and hourly. The last verified catalog is retained if a download fails.</T>
        <Button title="Sync instruments now" busy={busy} onPress={() => void action(false)} />
      </Section>
    </Screen>
  );
}
