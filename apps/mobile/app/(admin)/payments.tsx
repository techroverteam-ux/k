import { useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { useAuth } from '@/auth';
import { BellButton } from '@/screens';
import { inr, when } from '@/theme';
import { Button, Empty, ErrorState, Field, Lines, ListRow, Notice, Row, Screen, Sheet, Skeleton, T, toast, useQuery } from '@/ui';

interface P { id: string; userId: string; username?: string; type: string; mode: string; amount: string; status: string; createdAt: string; requestedById: string }
export default function Approvals() {
  const { me } = useAuth();
  const { data, error, loading, refetch } = useQuery<{ paymentRequests: P[] }>(`{ paymentRequests(status:[REQUESTED], limit:100){ id userId username type mode amount status createdAt requestedById } }`, undefined, 10000);
  const [sel, setSel] = useState<P | null>(null);
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = (p: P) => p.requestedById === me?.id || p.userId === me?.id;
  const act = async () => {
    if (!sel) return;
    setBusy(true); setErr(null);
    try {
      if (mode === 'approve') await gql(`mutation($id:ID!){ approvePayment(id:$id){ id } }`, { id: sel.id });
      else await gql(`mutation($id:ID!,$n:String!){ rejectPayment(id:$id, note:$n){ id } }`, { id: sel.id, n: note });
      toast(mode === 'approve' ? 'Approved and posted' : 'Request rejected'); setSel(null); setNote(''); void refetch();
    } catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Screen title="Approvals" right={<BellButton />} onRefresh={refetch}>
      <T v="sm" c="text2">Approving posts to the ledger straight away. You can’t approve a request you raised.</T>
      {loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.paymentRequests.length ? <Empty icon="check" title="Nothing to review" /> : data!.paymentRequests.map((p) => (
        <ListRow key={p.id} onPress={own(p) ? undefined : () => { setErr(null); setMode('approve'); setSel(p); }} label={`Review ${p.username}`}
          title={`${p.username} · ${p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}`} sub={`${when(p.createdAt)}${p.mode === 'SIMULATED' ? ' · virtual' : ''}${own(p) ? ' · needs another admin' : ''}`}
          right={<T v="num">₹{inr(p.amount)}</T>} />
      ))}
      <Sheet visible={!!sel} title={mode === 'approve' ? 'Approve request?' : 'Reject request?'} sub="You’ll confirm with your authenticator code." onClose={() => setSel(null)}>
        {sel && <Lines lines={[['Account', sel.username ?? ''], ['Type', sel.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'], ['Amount', `₹${inr(sel.amount)}`]]} />}
        {sel?.mode === 'SIMULATED' && mode === 'approve' && <Notice>This changes a virtual balance only. No money moves.</Notice>}
        {mode === 'reject' && <Field label="Reason shown to the requester" value={note} onChangeText={setNote} />}
        {err && <Notice tone="err">{err}</Notice>}
        <Row>
          {mode === 'approve' ? <Button block title="Reject" kind="danger" onPress={() => setMode('reject')} /> : <Button block title="Back" onPress={() => setMode('approve')} />}
          <View style={{ flex: 1 }}><Button block size="lg" title={mode === 'approve' ? 'Approve' : 'Reject'} kind={mode === 'approve' ? 'primary' : 'sell'} busy={busy} disabled={mode === 'reject' && note.trim().length < 3} onPress={act} /></View>
        </Row>
      </Sheet>
    </Screen>
  );
}
