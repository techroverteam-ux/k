'use client';
import { useSoleAdmin } from '@/lib/sole-admin';
import Link from 'next/link';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Dialog, Empty, ErrorState, SectionHead, SkeletonRows, useToast } from './ui';

/* ================================================================== trader / broker: wipe out my account */
interface Preview { balance: string; resetTo: string; openPositions: number; openOrders: number; runningStrategies: number; pendingRequests: number; method: string }
const CODE_LABEL: Record<string, string> = { TOTP: '6-digit code from your authenticator app', SMS: '6-digit code sent to your mobile', PASSWORD: 'Your password' };

export function WipeOutSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="section">
      <SectionHead title="Wipe out account" />
      <p className="t2 sm" style={{ margin: 0 }}>Start fresh: your balance goes back to the opening amount and your past orders, trades and statements are cleared from your view. Administrators keep a copy.</p>
      <div><button className="btn btn-danger" onClick={() => setOpen(true)}><Icon name="refresh" size={16} />Wipe out my account</button></div>
      {open && <WipeDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function WipeDialog({ onClose }: { onClose: () => void }) {
  const pv = useQuery<{ wipePreview: Preview }>(`{ wipePreview { balance resetTo openPositions openOrders runningStrategies pendingRequests method } }`);
  const [step, setStep] = useState<'review' | 'verify'>('review');
  const [ch, setCh] = useState<{ method: string; sentTo?: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const p = pv.data?.wipePreview;

  const begin = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ beginAccountWipe: { method: string; sentTo?: string; devCode?: string } }>(`mutation { beginAccountWipe { method sentTo devCode } }`);
      setCh(d.beginAccountWipe); setCode(''); setStep('verify');
      if (d.beginAccountWipe.devCode) toast(`Development code: ${d.beginAccountWipe.devCode}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const wipe = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ wipeMyAccount: { balance: string } }>(`mutation($c:String!,$w:String!){ wipeMyAccount(code:$c, confirm:$w){ balance } }`, { c: code, w: typed });
      toast(`Account wiped out. Balance: ₹${inr(d.wipeMyAccount.balance)}`);
      window.location.assign('/'); // reload every screen with the fresh account
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Dialog title="Wipe out your account?" sub="This can’t be undone from your side." onClose={onClose}>
      {pv.loading && !p ? <SkeletonRows rows={4} pad={false} /> : pv.error && !p ? <ErrorState error={pv.error} retry={pv.refetch} /> : p && step === 'review' ? (
        <div className="stack" style={{ gap: 14 }}>
          <ul className="confirm-lines" style={{ margin: 0 }}>
            <li><span className="t2">Balance now</span><span className="num w6">₹{inr(p.balance)}</span></li>
            <li><span className="t2">Balance after</span><span className="num w6">₹{inr(p.resetTo)}</span></li>
            {p.openOrders > 0 && <li><span className="t2">Pending orders</span><span className="num">{p.openOrders} will be cancelled</span></li>}
            {p.runningStrategies > 0 && <li><span className="t2">Running strategies</span><span className="num">{p.runningStrategies} will be stopped</span></li>}
            {p.pendingRequests > 0 && <li><span className="t2">Fund requests</span><span className="num">{p.pendingRequests} will be cancelled</span></li>}
          </ul>
          <p className="t2 sm" style={{ margin: 0 }}>Your orders, trades, ledger, statements, strategies, watchlist and notifications will be cleared from your view. A Super Admin can still see everything.</p>
          {p.openPositions > 0 && <div className="notice err"><Icon name="alert" size={18} /><span>You have {p.openPositions} open position{p.openPositions > 1 ? 's' : ''}. <Link href="/trader/positions" style={{ textDecoration: 'underline' }}>Exit them</Link> first.</span></div>}
          {err && <div className="notice err">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-sell" disabled={busy || p.openPositions > 0} onClick={() => void begin()}>Continue</button>
          </div>
        </div>
      ) : ch ? (
        <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void wipe(); }}>
          <p className="t2 sm" style={{ margin: 0 }}>{ch.method === 'SMS' ? `We sent a code to ${ch.sentTo}.` : ch.method === 'TOTP' ? 'Open your authenticator app.' : 'There’s no authenticator or mobile on this account, so confirm with your password.'}</p>
          <div className="field">
            <label htmlFor="wipe-code">{CODE_LABEL[ch.method]}</label>
            <input id="wipe-code" className="input" autoFocus autoComplete={ch.method === 'PASSWORD' ? 'current-password' : 'one-time-code'} type={ch.method === 'PASSWORD' ? 'password' : 'text'} inputMode={ch.method === 'PASSWORD' ? undefined : 'numeric'} maxLength={ch.method === 'PASSWORD' ? 128 : 6} value={code} onChange={(e) => setCode(ch.method === 'PASSWORD' ? e.target.value : e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="field">
            <label htmlFor="wipe-typed">Type <b>WIPE</b> to confirm</label>
            <input id="wipe-typed" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {err && <div className="notice err">{err}</div>}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            {ch.method === 'SMS' ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void begin()}>Send a new code</button> : <span />}
            <div className="row">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-sell" disabled={busy || !code || typed.trim().toUpperCase() !== 'WIPE'}>Wipe out</button>
            </div>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/* ================================================================== Super Admin: an account's wipes */
interface AccountWipe { id: string; verifiedWith: string; balanceBefore: string; balanceAfter: string; snapshot: string; ip?: string; createdAt: string }
const VIA: Record<string, string> = { TOTP: 'authenticator', SMS: 'SMS code', PASSWORD: 'password' };

export function AccountWipes({ userId }: { userId: string }) {
  const { data, loading, error, refetch } = useQuery<{ accountWipes: AccountWipe[] }>(`query($u:ID!){ accountWipes(userId:$u){ id verifiedWith balanceBefore balanceAfter snapshot ip createdAt } }`, { u: userId });
  const rows = data?.accountWipes ?? [];
  if (loading && !data) return null;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!rows.length) return null;
  return (
    <section className="section">
      <SectionHead title="Wipe-outs" />
      <p className="t3 sm" style={{ margin: 0 }}>This account was wiped out by its owner. Everything before each wipe is hidden from them and their broker; you still see it in the tabs above.</p>
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
const STATUS: Record<string, string> = { PENDING: 'Waiting for a second Super Admin', EXECUTED: 'Done', REJECTED: 'Rejected', EXPIRED: 'Expired' };

export function PlatformWipePanel({ meId }: { meId: string }) {
  const sole = useSoleAdmin();
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
          <b>Wipe all data</b> permanently deletes everything except the Super Admin accounts: every trader and broker with their orders, positions, ledger, fund and fee requests, strategies, watchlists and notifications, plus bank &amp; UPI details, instruments and price history. Settings go back to their defaults. Only Super Admin logins and the audit log are kept.
          {sole
            ? <>You are the only Super Admin, so <b>the wipe runs as soon as you confirm</b>: there is no second approval. You re-verify with your authenticator.</>
            : <>One Super Admin asks; a <b>different</b> Super Admin must approve within 30 minutes. Both re-verify with their authenticator.</>}
        </span>
      </div>
      {loading && !data ? <SkeletonRows rows={2} pad={false} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : pending ? (
        <div className="panel panel-pad stack" style={{ gap: 10 }}>
          <div className="w6">Pending request · expires {when(pending.expiresAt)}</div>
          <div className="t2 sm">Reason: {pending.reason}</div>
          {pending.requestedById === meId && !sole ? (
            <div className="row"><span className="t3 sm grow">Waiting for another Super Admin to approve.</span><button className="btn" onClick={async () => { try { await gql(`mutation($id:ID!){ rejectPlatformWipe(id:$id){ id } }`, { id: pending.id }); toast('Request cancelled'); void refetch(); } catch (e) { toast((e as Error).message, true); } }}>Cancel request</button></div>
          ) : (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={async () => { try { await gql(`mutation($id:ID!){ rejectPlatformWipe(id:$id){ id } }`, { id: pending.id }); toast('Request rejected'); void refetch(); } catch (e) { toast((e as Error).message, true); } }}>Reject</button>
              <button className="btn btn-sell" onClick={() => setDlg({ kind: 'approve', w: pending })}>Approve and wipe</button>
            </div>
          )}
        </div>
      ) : (
        <div><button className="btn btn-sell" onClick={() => setDlg({ kind: 'request' })}><Icon name="alert" size={16} />{sole ? 'Wipe all data now' : 'Request a full wipe'}</button></div>
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
      {dlg && <PlatformWipeDialog mode={dlg} sole={sole} onClose={() => setDlg(null)} onDone={() => { setDlg(null); void refetch(); }} />}
    </div>
  );
}

function PlatformWipeDialog({ mode, sole, onClose, onDone }: { mode: { kind: 'request' } | { kind: 'approve'; w: PlatformWipe }; sole: boolean; onClose: () => void; onDone: () => void }) {
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
        toast(d.requestPlatformWipe.status === 'EXECUTED' ? 'All data wiped. Only Super Admin accounts are left.' : 'Request sent. Another Super Admin has 30 minutes to approve it.');
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
      title={mode.kind === 'approve' ? 'Approve the full wipe?' : sole ? 'Wipe all data now' : 'Request a full wipe'}
      sub={mode.kind === 'approve' ? `Reason given: ${mode.w.reason}` : sole ? "You're the only Super Admin, so this runs immediately. There's no second approval." : 'Another Super Admin will have to approve it.'}
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
          <button type="submit" className="btn btn-sell" disabled={busy || typed.trim() !== PHRASE || (mode.kind === 'request' && reason.trim().length < 10)}>{mode.kind === 'request' ? (sole ? 'Wipe now' : 'Send request') : 'Approve and wipe'}</button>
        </div>
      </form>
    </Dialog>
  );
}
