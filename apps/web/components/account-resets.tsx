'use client';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@/lib/hooks';
import { when } from '@/lib/format';
import { Confirm, Dialog, Empty, ErrorState, SectionHead, SkeletonRows, useToast } from './ui';

interface Reset { id: string; userId: string; username?: string; role?: string; status: string; reason: string; expiresAt: string; createdAt: string; decidedById?: string; canApprove?: boolean }
export function AccountResetPanel({ allowRequest = false }: { allowRequest?: boolean }) {
  const { me } = useAuth();
  const q = useQuery<{ accountResetRequests: Reset[] }>(`{ accountResetRequests { id userId username role status reason expiresAt createdAt decidedById canApprove } }`, undefined, { pollMs: 10_000 });
  const [requesting, setRequesting] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [decision, setDecision] = useState<{ r: Reset; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const rows = q.data?.accountResetRequests ?? [];
  const pending = rows.some((r) => r.userId === me?.id && r.status === 'PENDING');
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (decision) { await gql(`mutation($id:ID!,$a:Boolean!){ decideAccountReset(id:$id,approve:$a){ id status } }`, { id: decision.r.id, a: decision.approve }); toast(decision.approve ? 'Reset approved. The requester and other approvers have been notified.' : 'Reset rejected. All parties have been notified.'); setDecision(null); }
      else { await gql(`mutation($r:String!,$c:String!){ requestAccountReset(reason:$r,confirm:$c){ id status } }`, { r: reason, c: typed }); toast('Reset requested. The approvers have been notified.'); setRequesting(false); setReason(''); setTyped(''); }
      void q.refetch();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="section">
    <SectionHead title="Account reset requests">{allowRequest && <button className="btn btn-danger" disabled={pending} onClick={() => { setErr(null); setRequesting(true); }}>{pending ? 'Awaiting approval' : 'Request account reset'}</button>}</SectionHead>
    {allowRequest && <p className="t2 sm">{me?.role === 'BROKER' ? 'A Super Admin must approve. Only your view of past activity and commissions is cleared; assigned traders are unchanged.' : 'Your broker or either Super Admin must approve. Approval disables your account and resets it to zero. Staff retain your history, and can re-enable you to start fresh.'}</p>}
    {q.loading && !q.data ? <SkeletonRows rows={2} /> : q.error && !q.data ? <ErrorState error={q.error} retry={q.refetch} /> : !rows.length ? <Empty icon="refresh" title="No account reset requests" /> : <div className="panel list list-pad">{rows.map((r) => <div key={r.id} className="list-row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}><div className="grow"><div className="w6">{r.username} <span className="badge">{r.status}</span></div><p className="t2 sm">{r.reason}</p><div className="t3 xs">Requested {when(r.createdAt)}{r.status === 'PENDING' ? ` ? Expires ${when(r.expiresAt)}` : ''}</div></div>{r.canApprove && <div className="row"><button className="btn btn-sm" onClick={() => { setErr(null); setDecision({ r, approve: false }); }}>Reject reset</button><button className="btn btn-sm btn-danger" onClick={() => { setErr(null); setDecision({ r, approve: true }); }}>Approve reset</button></div>}</div>)}</div>}
    {requesting && <Dialog title="Request an account reset" onClose={() => setRequesting(false)}><form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}><p className="t2 sm">{me?.role === 'BROKER' ? 'Both Super Admins are notified. Either can approve your visibility reset.' : 'Your assigned broker and both Super Admins are notified. Approval disables this account; re-enabling starts it with zero balance. Close your open positions before approval.'}</p><div className="field"><label htmlFor="reset-reason">Reason (10-300 characters)</label><textarea id="reset-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></div><div className="field"><label htmlFor="reset-confirm">Type WIPE to confirm</label><input id="reset-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>{err && <p className="err" role="alert">{err}</p>}<div className="actions"><button type="button" className="btn" onClick={() => setRequesting(false)}>Cancel</button><button className="btn btn-danger" disabled={busy || reason.trim().length < 10 || typed.trim().toUpperCase() !== 'WIPE'}>Send reset request</button></div></form></Dialog>}
    {decision && <Confirm title={decision.approve ? 'Approve account reset?' : 'Reject account reset?'} lines={[["Account", decision.r.username ?? decision.r.userId], ["Effect", decision.r.role === 'BROKER' ? 'Clear broker view only; traders unchanged' : 'Disable trader and reset balance to zero; staff keep history']]} confirmLabel={decision.approve ? 'Approve reset' : 'Reject reset'} tone="danger" pending={busy} error={err} onClose={() => setDecision(null)} onConfirm={() => void submit()} />}
  </section>;
}

export function ReenableResetTrader({ user, onDone }: { user: { id: string; resetDisabledAt?: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const toast = useToast();
  if (!user.resetDisabledAt) return null;
  return <><button className="btn btn-primary" onClick={() => setOpen(true)}>Re-enable trader</button>{open && <Confirm title="Re-enable this trader?" lines={[["Balance", "Starts at zero"], ["History", "Fresh trader view; staff keep all historical records"]]} confirmLabel="Re-enable trader" pending={busy} error={error} onClose={() => setOpen(false)} onConfirm={() => { setBusy(true); void gql(`mutation($id:ID!){ setUserStatus(userId:$id,status:ACTIVE,reason:"Re-enabled after approved account reset"){ id } }`, { id: user.id }).then(() => { toast('Trader re-enabled with a fresh zero balance.'); setOpen(false); onDone(); }).catch((e) => setError(e.message)).finally(() => setBusy(false)); }} />}</>;
}
