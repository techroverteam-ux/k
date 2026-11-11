import { useState } from 'react';
import { View } from 'react-native';
import { gql } from './api';
import { useAuth } from './auth';
import { Button, ErrorState, Field, Lines, Notice, Row, Section, Sheet, Skeleton, T, toast, useQuery } from './ui';
import { S, when } from './theme';

interface Reset { id: string; userId: string; username?: string; role?: string; status: string; reason: string; expiresAt: string; canApprove?: boolean }
export function AccountResetPanel({ allowRequest = false }: { allowRequest?: boolean }) {
  const { me } = useAuth();
  const q = useQuery<{ accountResetRequests: Reset[] }>(`{ accountResetRequests { id userId username role status reason expiresAt canApprove } }`, undefined, 10_000);
  const [open, setOpen] = useState(false); const [decision, setDecision] = useState<{ r: Reset; approve: boolean } | null>(null);
  const [reason, setReason] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const rows = q.data?.accountResetRequests ?? [];
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (decision) await gql(`mutation($id:ID!,$a:Boolean!){ decideAccountReset(id:$id,approve:$a){ id } }`, { id: decision.r.id, a: decision.approve });
      else await gql(`mutation($r:String!,$c:String!){ requestAccountReset(reason:$r,confirm:$c){ id } }`, { r: reason, c: confirm });
      toast(decision ? 'Decision saved. The other parties have been notified.' : 'Reset requested. The approvers have been notified.'); setOpen(false); setDecision(null); void q.refetch();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return <Section title="Account reset requests">
    {allowRequest && <><T v="sm" c="text2">{me?.role === 'BROKER' ? 'Only your view of past activity and commissions is cleared. Your traders are unchanged. A Super Admin must approve.' : 'Your broker or a Super Admin must approve. Approval disables your account and resets its balance to zero. Staff keep your history and can re-enable you.'}</T><Button kind="danger" title="Request account reset" disabled={rows.some((r) => r.userId === me?.id && r.status === 'PENDING')} onPress={() => { setErr(null); setOpen(true); }} /></>}
    {!q.data ? q.error ? <ErrorState error={q.error} retry={q.refetch} /> : <Skeleton /> : !rows.length ? <T v="sm">No reset requests.</T> : rows.map((r) => <View key={r.id} style={{ gap: S[2], paddingVertical: S[3] }}><T w="600">{r.username} - {r.status}</T><T v="sm" c="text2">{r.reason}</T>{r.status === 'PENDING' && <T v="xs">Expires {when(r.expiresAt)}</T>}{r.canApprove && <Row><Button block title="Reject reset" onPress={() => { setErr(null); setDecision({ r, approve: false }); }} /><Button block kind="danger" title="Approve reset" onPress={() => { setErr(null); setDecision({ r, approve: true }); }} /></Row>}</View>)}
    <Sheet visible={open || !!decision} title={decision ? decision.approve ? 'Approve account reset?' : 'Reject account reset?' : 'Request account reset'} onClose={() => { setOpen(false); setDecision(null); }}>
      {decision ? <T c="text2">{decision.r.role === 'BROKER' ? 'Only the broker view is cleared. Traders are unchanged.' : 'Approval disables the trader and resets their balance to zero. Historical data remains available to staff. Open positions must be closed first.'}</T> : <><Field label="Reason (10-300 characters)" maxLength={300} value={reason} onChangeText={setReason} /><Field label="Type WIPE to confirm" value={confirm} onChangeText={setConfirm} autoCapitalize="characters" /></>}
      {err && <Notice tone="err">{err}</Notice>}<Button kind="danger" title={decision ? 'Confirm decision' : 'Send request'} busy={busy} disabled={!decision && (reason.trim().length < 10 || confirm.trim().toUpperCase() !== 'WIPE')} onPress={go} />
    </Sheet>
  </Section>;
}

export function ReenableResetTrader({ user, onDone }: { user: { id: string; resetDisabledAt?: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!user.resetDisabledAt) return null;
  return <><Button kind="primary" title="Re-enable trader" onPress={() => setOpen(true)} /><Sheet visible={open} title="Re-enable trader?" onClose={() => setOpen(false)}><Lines lines={[["Balance", "Starts at zero"], ["History", "Fresh trader view; staff retain history"]]} />{err && <Notice tone="err">{err}</Notice>}<Button kind="primary" title="Re-enable trader" busy={busy} onPress={() => { setBusy(true); void gql(`mutation($id:ID!){ setUserStatus(userId:$id,status:ACTIVE,reason:"Re-enabled after approved account reset"){ id } }`, { id: user.id }).then(() => { toast('Trader re-enabled with a fresh zero balance.'); setOpen(false); onDone(); }).catch((e) => setErr(e.message)).finally(() => setBusy(false)); }} /></Sheet></>;
}
