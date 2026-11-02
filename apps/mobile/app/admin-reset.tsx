/** Super Admin → Data reset: permanently delete all trader and broker data. One asks, a different one approves within 30 minutes. */
import { useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { useAuth } from '@/auth';
import { S, when } from '@/theme';
import { Button, Empty, ErrorState, Field, Notice, Row, Screen, Section, Sheet, Skeleton, T, toast, useQuery } from '@/ui';

interface PW { id: string; status: string; requestedById: string; reason: string; expiresAt: string; summary?: string; createdAt: string }
const STATUS: Record<string, string> = { PENDING: 'Waiting for a second Super Admin', EXECUTED: 'Done', REJECTED: 'Rejected', EXPIRED: 'Expired' };
const PHRASE = 'WIPE ALL DATA';

export default function AdminReset() {
  const { me } = useAuth();
  const q = useQuery<{ platformWipes: PW[] }>(`{ platformWipes { id status requestedById reason expiresAt summary createdAt } }`, undefined, 15000);
  const [dlg, setDlg] = useState<{ kind: 'request' } | { kind: 'approve'; w: PW } | null>(null);
  const rows = q.data?.platformWipes ?? [];
  const pending = rows.find((w) => w.status === 'PENDING' && new Date(w.expiresAt) > new Date());
  const reject = async (id: string, msg: string) => { try { await gql(`mutation($id:ID!){ rejectPlatformWipe(id:$id){ id } }`, { id }); toast(msg); void q.refetch(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <Screen back title="Data reset">
      <Notice tone="err">Wipe all trading data permanently deletes every trader and broker account with their orders, positions, ledger, fund requests, strategies, watchlists and notifications. Super Admin logins, settings, price history, payment details and the audit log are kept. A different Super Admin must approve within 30 minutes.</Notice>
      {q.error && !q.data ? <ErrorState error={q.error} retry={q.refetch} /> : !q.data ? <Skeleton rows={2} /> : pending ? (
        <View style={{ gap: S[2] }}>
          <T w="600">Pending request · expires {when(pending.expiresAt)}</T>
          <T v="sm" c="text2">Reason: {pending.reason}</T>
          {pending.requestedById === me?.id
            ? <Button title="Cancel my request" onPress={() => void reject(pending.id, 'Request cancelled')} />
            : <Row gap={S[2]}><View style={{ flex: 1 }}><Button block title="Reject" onPress={() => void reject(pending.id, 'Request rejected')} /></View><View style={{ flex: 1 }}><Button block kind="sell" title="Approve and wipe" onPress={() => setDlg({ kind: 'approve', w: pending })} /></View></Row>}
        </View>
      ) : <Button kind="sell" size="lg" title="Request a full wipe" onPress={() => setDlg({ kind: 'request' })} />}
      <Section title="History">
        {!rows.length ? <Empty icon="shield" title="No wipes yet" /> : rows.map((w) => {
          const sum = w.summary ? (JSON.parse(w.summary) as Record<string, number>) : null;
          return (
            <View key={w.id} style={{ paddingVertical: S[2], gap: 2 }}>
              <T w="600">{STATUS[w.status] ?? w.status} · {when(w.createdAt)}</T>
              <T v="xs" c="text2">{w.reason}</T>
              {sum && <T v="xs" c="text3">Deleted {sum.accounts ?? 0} accounts, {sum.orders ?? 0} orders, {sum.journals ?? 0} ledger journals.</T>}
            </View>
          );
        })}
      </Section>
      {dlg && <WipeSheet mode={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); void q.refetch(); }} />}
    </Screen>
  );
}

function WipeSheet({ mode, onClose, onDone }: { mode: { kind: 'request' } | { kind: 'approve'; w: PW }; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet visible title={mode.kind === 'request' ? 'Request a full wipe' : 'Approve the full wipe?'} sub={mode.kind === 'approve' ? `Reason given: ${mode.w.reason}` : 'Another Super Admin will have to approve it.'} onClose={onClose}>
      {mode.kind === 'request' && <Field label="Reason (kept in the audit log)" maxLength={300} value={reason} onChangeText={setReason} placeholder="e.g. End of the October training batch" />}
      <Notice tone="err">All trader and broker accounts and their data will be permanently deleted. This cannot be undone.</Notice>
      <Field label={`Type ${PHRASE} to confirm`} autoCapitalize="characters" autoCorrect={false} value={typed} onChangeText={setTyped} />
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="sell" size="lg" title={mode.kind === 'request' ? 'Send request' : 'Approve and wipe'} busy={busy} disabled={typed.trim() !== PHRASE || (mode.kind === 'request' && reason.trim().length < 10)} onPress={async () => {
        setBusy(true); setErr(null);
        try {
          if (mode.kind === 'request') { await gql(`mutation($r:String!,$w:String!){ requestPlatformWipe(reason:$r, confirm:$w){ id } }`, { r: reason, w: typed }); toast('Request sent. Another Super Admin has 30 minutes to approve it.'); }
          else { const d = await gql<{ approvePlatformWipe: string }>(`mutation($id:ID!,$w:String!){ approvePlatformWipe(id:$id, confirm:$w) }`, { id: mode.w.id, w: typed }); toast(`Wiped: ${(JSON.parse(d.approvePlatformWipe) as Record<string, number>).accounts ?? 0} accounts deleted`); }
          onDone();
        } catch (e) { setErr((e as Error).message); setBusy(false); }
      }} />
    </Sheet>
  );
}
