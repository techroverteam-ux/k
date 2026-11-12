'use client';
import { AccountResetPanel } from './account-resets';
import Link from 'next/link';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Dialog, Empty, ErrorState, SectionHead, SkeletonRows, useToast } from './ui';

/* ================================================================== trader / broker: wipe out my account */

export function WipeOutSection() { return <AccountResetPanel allowRequest />; }

/* ================================================================== Super Admin: an account's wipes */
interface AccountWipe { id: string; verifiedWith: string; balanceBefore: string; balanceAfter: string; snapshot: string; ip?: string; createdAt: string }
const VIA: Record<string, string> = { SESSION: 'signed-in session', SMS: 'SMS code', PASSWORD: 'password' };

export function AccountWipes({ userId }: { userId: string }) {
  const { data, loading, error, refetch } = useQuery<{ accountWipes: AccountWipe[] }>(`query($u:ID!){ accountWipes(userId:$u){ id verifiedWith balanceBefore balanceAfter snapshot ip createdAt } }`, { u: userId });
  const rows = data?.accountWipes ?? [];
  if (loading && !data) return null;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!rows.length) return null;
  return (
    <section className="section">
      <SectionHead title="Wipe-outs" />
      <p className="t3 sm" style={{ margin: 0 }}>Approved resets hide past data only from its owner. Assigned brokers and Super Admins retain the history and archived snapshots.</p>
      <div className="panel">
        <div className="list list-pad">
          {rows.map((w) => {
            const s = JSON.parse(w.snapshot) as { positions: { symbol: string; realizedPnlMinor: string }[]; watchlist: { symbol: string }[]; cancelledOrders: string[]; stoppedStrategies: string[]; cancelledRequests: string[] };
            return (
              <div key={w.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="mark" aria-hidden="true"><Icon name="refresh" size={16} /></span>
                <div className="grow">
                  <div className="w6">{when(w.createdAt)} · balance ₹{inr(w.balanceBefore)} → ₹{inr(w.balanceAfter)}</div>
                  <div className="t3 sm">Confirmed with {VIA[w.verifiedWith] ?? w.verifiedWith}{w.ip ? ` · IP ${w.ip}` : ''}</div>
                  <div className="t3 sm">
                    Cleared {s.positions.length} position row{s.positions.length === 1 ? '' : 's'}{s.positions.length ? ` (${s.positions.map((p) => p.symbol).join(', ')})` : ''}, {s.watchlist.length} watchlist item{s.watchlist.length === 1 ? '' : 's'};
                    cancelled {s.cancelledOrders.length} order{s.cancelledOrders.length === 1 ? '' : 's'} and {s.cancelledRequests.length} request{s.cancelledRequests.length === 1 ? '' : 's'}; stopped {s.stoppedStrategies.length} strateg{s.stoppedStrategies.length === 1 ? 'y' : 'ies'}.
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ================================================================== Super Admin: wipe all trading data */
interface PlatformWipe { id: string; status: string; requestedById: string; reason: string; decidedById?: string; decidedAt?: string; expiresAt: string; summary?: string; createdAt: string }
const STATUS: Record<string, string> = { PENDING: 'Awaiting confirmation', EXECUTED: 'Done', REJECTED: 'Rejected', EXPIRED: 'Expired' };

export function PlatformWipePanel({ meId }: { meId: string }) {
  const { data, loading, error, refetch } = useQuery<{ platformWipes: PlatformWipe[] }>(`{ platformWipes { id status requestedById reason decidedById decidedAt expiresAt summary createdAt } }`, undefined, { pollMs: 15_000 });
  const [dlg, setDlg] = useState<{ kind: 'request' } | { kind: 'approve'; w: PlatformWipe } | null>(null);
  const toast = useToast();
  const rows = data?.platformWipes ?? [];
  const pending = rows.find((w) => w.status === 'PENDING' && new Date(w.expiresAt) > new Date());
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="notice err" style={{ alignItems: 'flex-start' }}>
        <Icon name="alert" size={18} />
        <span>
          <b>Wipe all data</b> permanently deletes everything except the Super Admin account: every trader and broker with their orders, positions, ledger, fund and fee requests, strategies, watchlists and notifications, plus bank &amp; UPI details, instruments and price history. Settings go back to their defaults. Only Super Admin logins and the audit log are kept.
          <>The Super Admin can execute this immediately after confirming.</>
        </span>
      </div>
      {loading && !data ? <SkeletonRows rows={2} pad={false} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : pending ? (
        <div className="panel panel-pad stack" style={{ gap: 10 }}>
          <div className="w6">Pending request · expires {when(pending.expiresAt)}</div>
          <div className="t2 sm">Reason: {pending.reason}</div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={async () => { try { await gql(`mutation($id:ID!){ rejectPlatformWipe(id:$id){ id } }`, { id: pending.id }); toast('Request rejected'); void refetch(); } catch (e) { toast((e as Error).message, true); } }}>Reject</button>
              <button className="btn btn-sell" onClick={() => setDlg({ kind: 'approve', w: pending })}>Approve and wipe</button>
            </div>
        </div>
      ) : (
        <div><button className="btn btn-sell" onClick={() => setDlg({ kind: 'request' })}><Icon name="alert" size={16} />Wipe all data</button></div>
      )}
      <section className="section">
        <SectionHead title="History" />
        {!rows.length ? <Empty icon="shield" title="No wipes yet" /> : (
          <div className="panel"><div className="list list-pad">
            {rows.map((w) => {
              const sum = w.summary ? (JSON.parse(w.summary) as Record<string, number>) : null;
              return (
                <div key={w.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="w6">{STATUS[w.status] ?? w.status} · {when(w.createdAt)}</div>
                    <div className="t3 sm">{w.reason}</div>
                    {sum && <div className="t3 sm">Deleted {sum.accounts ?? 0} accounts, {sum.orders ?? 0} orders, {sum.journals ?? 0} ledger journals, {sum.paymentRequests ?? 0} fund requests.</div>}
                  </div>
                </div>
              );
            })}
          </div></div>
        )}
      </section>
      {dlg && <PlatformWipeDialog mode={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); void refetch(); }} />}
    </div>
  );
}

function PlatformWipeDialog({ mode, onClose, onDone }: { mode: { kind: 'request' } | { kind: 'approve'; w: PlatformWipe }; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const PHRASE = 'WIPE ALL DATA';
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode.kind === 'request') {
        const d = await gql<{ requestPlatformWipe: { status: string } }>(`mutation($r:String!,$w:String!){ requestPlatformWipe(reason:$r, confirm:$w){ id status } }`, { r: reason, w: typed });
        toast(d.requestPlatformWipe.status === 'EXECUTED' ? 'All data wiped. Only Super Admin account are left.' : 'Wipe recorded.');
      } else {
        const d = await gql<{ approvePlatformWipe: string }>(`mutation($id:ID!,$w:String!){ approvePlatformWipe(id:$id, confirm:$w) }`, { id: mode.w.id, w: typed });
        const c = JSON.parse(d.approvePlatformWipe) as Record<string, number>;
        toast(`Wiped: ${c.accounts ?? 0} accounts deleted.`);
      }
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog
      title={mode.kind === 'approve' ? 'Approve the full wipe?' : 'Wipe all data'}
      sub={mode.kind === 'approve' ? `Reason given: ${mode.w.reason}` : 'This executes immediately after confirmation.'}
      onClose={onClose}>
      <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void go(); }}>
        {mode.kind === 'request' && (
          <div className="field"><label htmlFor="pw-reason">Reason (kept in the audit log)</label><input id="pw-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. End of the October training batch" /></div>
        )}
        <div className="notice err"><Icon name="alert" size={18} /><span>All trader and broker accounts and their data will be <b>permanently deleted</b>. This cannot be undone.</span></div>
        <div className="field"><label htmlFor="pw-typed">Type <b>{PHRASE}</b> to confirm</label><input id="pw-typed" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
        {err && <div className="notice err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-sell" disabled={busy || typed.trim() !== PHRASE || (mode.kind === 'request' && reason.trim().length < 10)}>{mode.kind === 'request' ? 'Wipe now' : 'Approve and wipe'}</button>
        </div>
      </form>
    </Dialog>
  );
}
