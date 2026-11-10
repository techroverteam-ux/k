'use client';
import { useSoleAdmin } from '@/lib/sole-admin';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { ROLE_LABEL, type UserRow } from './accounts';
import { Icon } from './icons';
import { Confirm, Dialog, RowMenu, type RowMenuItem, useToast } from './ui';

type Kind = 'approve' | 'suspend' | 'reactivate' | 'assign' | 'reset' | 'delete' | 'commission';

/** All Super Admin account actions with their confirmation dialogs. Step-up is prompted automatically by the API client. */
export function useUserActions(onDone: () => void) {
  const [act, setAct] = useState<{ kind: Kind; u: UserRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [pw, setPw] = useState('');
  const [showResetPw, setShowResetPw] = useState(false);
  const [broker, setBroker] = useState('');
  const [typed, setTyped] = useState('');
  const sole = useSoleAdmin();
  const router = useRouter();
  const toast = useToast();
  const brokers = useQuery<{ users: { items: { id: string; username: string; displayName: string }[] } }>(`{ users(role:BROKER, status:ACTIVE, limit:100){ items{ id username displayName } } }`);

  const open = (kind: Kind, u: UserRow) => { setErr(null); setReason(''); setTyped(kind === 'commission' ? (u.commissionPerMiniLot ? String(Number(u.commissionPerMiniLot)) : '') : ''); setPw(kind === 'commission' ? (u.commissionPerMegaLot ? String(Number(u.commissionPerMegaLot)) : '') : ''); setBroker(u.brokerId ?? ''); setAct({ kind, u }); };
  const close = () => setAct(null);
  const run = async (q: string, v: Record<string, unknown>, ok: string | ((d: Record<string, { status?: string } | undefined>) => string)) => {
    setBusy(true); setErr(null);
    try {
      const d = await gql(q, v); toast(typeof ok === 'string' ? ok : ok(d)); close();
      if (d?.requestUserDeletion?.status === 'EXECUTED') { router.push('/admin/users'); router.refresh(); }
      onDone();
    }
    catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const ErrBox = () => (err ? <div className="notice err" role="alert" style={{ marginTop: 12 }}><Icon name="alert" size={18} />{err}</div> : null);

  let node = null;
  if (act?.kind === 'approve') node = (
    <Confirm title="Approve this account?" sub={act.u.openingAmount ? `They can sign in as soon as you approve, and ₹${inr(act.u.openingAmount)} is added to their balance.` : 'They can sign in as soon as you approve.'}
      lines={[['Name', act.u.displayName], ['Username', act.u.username], ['Type', ROLE_LABEL[act.u.role]], ...(act.u.brokerName ? [['Broker', act.u.brokerName] as [string, string]] : []), ...(act.u.createdByName ? [['Requested by', act.u.createdByName] as [string, string]] : []), ['Requested on', when(act.u.createdAt)], ...(act.u.openingAmount ? [['Opening amount', `₹${inr(act.u.openingAmount)}`] as [string, string]] : [])]}
      confirmLabel="Approve account" pending={busy} error={err} onClose={close}
      onConfirm={() => run(`mutation($id:ID!){ approveUser(userId:$id){ id } }`, { id: act.u.id }, act.u.openingAmount ? `Account approved and ₹${inr(act.u.openingAmount)} added` : 'Account approved')} />
  );
  if (act?.kind === 'suspend' || act?.kind === 'reactivate') {
    const s = act.kind === 'suspend';
    node = (
      <Dialog title={s ? `Suspend ${act.u.displayName}?` : `Reactivate ${act.u.displayName}?`} sub={s ? 'They’ll be signed out on every device and their open orders will be cancelled.' : 'They’ll be able to sign in again.'} onClose={close}>
        <div className="field"><label htmlFor="rs">Reason</label><input id="rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit log" /><span className="hint">At least 5 characters</span></div>
        <ErrBox />
        <div className="actions"><button className="btn" onClick={close}>Cancel</button>
          <button className={`btn ${s ? 'btn-sell' : 'btn-primary'}`} disabled={busy || reason.trim().length < 5} onClick={() => run(`mutation($id:ID!,$s:UserStatus!,$r:String!){ setUserStatus(userId:$id, status:$s, reason:$r){ id } }`, { id: act.u.id, s: s ? 'SUSPENDED' : 'ACTIVE', r: reason }, s ? 'Account suspended' : 'Account reactivated')}>{busy ? 'Please wait…' : s ? 'Suspend account' : 'Reactivate account'}</button>
        </div>
      </Dialog>
    );
  }
  if (act?.kind === 'assign') node = (
    <Dialog title="Assign broker" sub={`Choose who manages ${act.u.displayName}.`} onClose={close}>
      <div className="field"><label htmlFor="br">Broker</label>
        <select id="br" className="input" value={broker} onChange={(e) => setBroker(e.target.value)}>
          <option value="">No broker</option>
          {brokers.data?.users.items.map((b) => <option key={b.id} value={b.id}>{b.displayName} ({b.username})</option>)}
        </select>
      </div>
      <ErrBox />
      <div className="actions"><button className="btn" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || broker === (act.u.brokerId ?? '')} onClick={() => run(`mutation($t:ID!,$b:ID){ assignTraderToBroker(traderId:$t, brokerId:$b){ id } }`, { t: act.u.id, b: broker || null }, 'Broker updated')}>{busy ? 'Saving…' : 'Save'}</button></div>
    </Dialog>
  );
  if (act?.kind === 'reset') node = (
    <Dialog title="Reset password" sub={`${act.u.displayName} will be signed out everywhere and must use the new temporary password.`} onClose={close}>
      <div className="field">
        <label htmlFor="np">Temporary password</label>
        <div style={{ position: 'relative' }}>
          <input
            id="np"
            className="input"
            type={showResetPw ? 'text' : 'password'}
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            style={{ paddingRight: 40 }}
          />
          <button
            type="button"
            className="icon-btn"
            onClick={() => setShowResetPw(!showResetPw)}
            title={showResetPw ? 'Hide password' : 'View password'}
            aria-label={showResetPw ? 'Hide password' : 'View password'}
            style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 34, height: 34, color: showResetPw ? 'var(--brand)' : 'var(--text-3)' }}
          >
            <Icon name={showResetPw ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
        <span className="hint">At least 10 characters with three of: lowercase, uppercase, digits, symbols</span>
      </div>
      <ErrBox />
      <div className="actions"><button className="btn" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || pw.length < 10} onClick={() => run(`mutation($id:ID!,$p:String!){ resetUserPassword(userId:$id, tempPassword:$p) }`, { id: act.u.id, p: pw }, 'Password reset')}>{busy ? 'Resetting…' : 'Reset password'}</button></div>
    </Dialog>
  );
  if (act?.kind === 'commission') {
    const rx = /^\d{1,7}(\.\d{1,2})?$/;
    const ok = rx.test(typed.trim()) && rx.test(pw.trim());
    node = (
      <Dialog title={`Commission for ${act.u.displayName}`} sub="What the broker earns for every lot their traders open or cut. 3 mini lots opened = 3 × the mini amount." onClose={close}>
        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div className="field grow"><label htmlFor="cmi2">Per mini lot (₹)</label><input id="cmi2" className="input num" inputMode="decimal" placeholder="170" value={typed} onChange={(e) => setTyped(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          <div className="field grow"><label htmlFor="cmg2">Per mega lot (₹)</label><input id="cmg2" className="input num" inputMode="decimal" placeholder="1700" value={pw} onChange={(e) => setPw(e.target.value.replace(/[^\d.]/g, ''))} /></div>
        </div>
        <span className="hint">{act.u.commissionIsDefault ? 'Now using the platform default.' : `Now ₹${inr(act.u.commissionPerMiniLot)} per mini lot and ₹${inr(act.u.commissionPerMegaLot)} per mega lot.`}</span>
        <ErrBox />
        <div className="actions"><button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !ok} onClick={() => run(`mutation($b:ID!,$m:String!,$g:String!){ setBrokerCommissionPerLot(brokerId:$b, perMiniLot:$m, perMegaLot:$g){ id } }`, { b: act.u.id, m: typed.trim(), g: pw.trim() }, 'Commission updated')}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </Dialog>
    );
  }
  if (act?.kind === 'delete') node = (
    <Dialog title={`Delete ${act.u.displayName} permanently?`} sub={sole ? 'Erases the account and all its data right away.' : 'Erases the account and all its data. A different Super Admin must approve within 30 minutes.'} onClose={close}>
      <div className="notice err" style={{ marginBottom: 12 }}><Icon name="alert" size={18} /><span>Orders, positions, ledger, fund and fee requests, strategies, watchlist, notifications and sign-ins of <b>{act.u.username}</b> are deleted and can’t be brought back. {act.u.role === 'BROKER' ? 'Their traders stay, without a broker. ' : ''}The audit log keeps a record of the delete.</span></div>
      <div className="field"><label htmlFor="dr">Reason</label><input id="dr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit log" /><span className="hint">10–300 characters</span></div>
      <div className="field"><label htmlFor="du">Type <b>{act.u.username}</b> to confirm</label><input id="du" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
      <ErrBox />
      <div className="actions"><button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-sell" disabled={busy || reason.trim().length < 10 || typed.trim().toLowerCase() !== act.u.username} onClick={() => run(`mutation($u:ID!,$r:String!,$w:String!){ requestUserDeletion(userId:$u, reason:$r, confirm:$w){ id status } }`, { u: act.u.id, r: reason.trim(), w: typed.trim() }, (d) => (d.requestUserDeletion?.status === 'EXECUTED' ? `${act.u.username} deleted` : 'Sent to another Super Admin for approval'))}>{busy ? 'Please wait…' : sole ? 'Delete now' : 'Ask to delete'}</button>
      </div>
    </Dialog>
  );
  return { open, node, brokers: brokers.data?.users.items ?? [] };
}

export function UserActionButtons({ u, open }: { u: UserRow; open: (k: Kind, u: UserRow) => void }) {
  if (u.role === 'SUPER_ADMIN') return <span className="t3">Managed by operations</span>;
  const more: RowMenuItem[] = [
    ...(u.role === 'TRADER' ? [{ label: 'Change broker', icon: 'swap' as const, onClick: () => open('assign', u) }] : []),
    ...(u.role === 'BROKER' ? [{ label: 'Change commission', icon: 'percent' as const, onClick: () => open('commission', u) }] : []),
    { label: 'Reset password', icon: 'key', onClick: () => open('reset', u) },
    ...(u.status === 'ACTIVE' ? [{ label: 'Suspend account', icon: 'lock' as const, onClick: () => open('suspend', u), danger: true }] : []),
    { label: 'Delete permanently', icon: 'trash', onClick: () => open('delete', u), danger: true },
  ];
  return (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
      {u.status === 'PENDING' && <button className="btn btn-sm btn-primary" onClick={() => open('approve', u)}>Approve</button>}
      {u.status === 'SUSPENDED' && <button className="btn btn-sm" onClick={() => open('reactivate', u)}>Reactivate</button>}
      <RowMenu label={`More actions for ${u.username}`} items={more} />
    </div>
  );
}

/* ============================================================ permanent deletes waiting for a second Super Admin */
interface Deletion { id: string; status: string; targetUserId: string; targetUsername: string; targetRole: string; reason: string; requestedById: string; expiresAt: string; createdAt: string; summary?: string }

/** Pending (and, for one account, past) delete requests, with Approve / Reject for the other Super Admin. */
export function PendingDeletions({ userId, onDone }: { userId?: string; onDone?: () => void }) {
  const { me } = useAuth();
  const sole = useSoleAdmin();
  const toast = useToast();
  const { data, refetch } = useQuery<{ userDeletions: Deletion[] }>(`query($u:ID){ userDeletions(userId:$u){ id status targetUserId targetUsername targetRole reason requestedById expiresAt createdAt summary } }`, { u: userId });
  const [approve, setApprove] = useState<Deletion | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now();
  const rows = (data?.userDeletions ?? []).filter((d) => d.status === 'PENDING' && new Date(d.expiresAt).getTime() > now);
  if (!rows.length) return null;
  const act = async (q: string, v: Record<string, unknown>, ok: string, deleted = false) => {
    setBusy(true); setErr(null);
    try { await gql(q, v); toast(ok); setApprove(null); void refetch(); if (deleted) onDone?.(); }
    catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel panel-pad stack" style={{ gap: 10, marginBottom: 16, borderColor: 'var(--neg)' }} aria-label="Accounts waiting to be deleted">
      <div className="row" style={{ gap: 8 }}><Icon name="alert" size={18} /><span className="w6">Waiting for a second Super Admin: permanent delete</span></div>
      {rows.map((d) => {
        const mine = d.requestedById === me?.id;
        return (
          <div key={d.id} className="spread" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div><div className="w6">{d.targetUsername} · {ROLE_LABEL[d.targetRole as keyof typeof ROLE_LABEL] ?? d.targetRole}</div><div className="t3 sm">{d.reason} · asked {when(d.createdAt)}{mine ? ' by you' : ''} · expires {when(d.expiresAt)}</div></div>
            <div className="row" style={{ gap: 6 }}>
              {(!mine || sole) && <button className="btn btn-sm btn-sell" onClick={() => { setTyped(''); setErr(null); setApprove(d); }}>Approve delete</button>}
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(`mutation($id:ID!){ rejectUserDeletion(id:$id){ id } }`, { id: d.id }, mine ? 'Request cancelled' : 'Request rejected')}>{mine ? 'Cancel request' : 'Reject'}</button>
            </div>
          </div>
        );
      })}
      {approve && (
        <Dialog title={`Delete ${approve.targetUsername} now?`} sub={`Reason given: ${approve.reason}`} onClose={() => setApprove(null)}>
          <div className="notice err" style={{ marginBottom: 12 }}><Icon name="alert" size={18} /><span>This erases the account and all its data at once. It can’t be undone.</span></div>
          <div className="field"><label htmlFor="da">Type <b>{approve.targetUsername}</b> to confirm</label><input id="da" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
          {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
          <div className="actions"><button className="btn" onClick={() => setApprove(null)}>Cancel</button>
            <button className="btn btn-sell" disabled={busy || typed.trim().toLowerCase() !== approve.targetUsername} onClick={() => void act(`mutation($id:ID!,$w:String!){ approveUserDeletion(id:$id, confirm:$w) }`, { id: approve.id, w: typed.trim() }, `${approve.targetUsername} deleted`, true)}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
