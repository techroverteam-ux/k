'use client';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { ROLE_LABEL, type UserRow } from './accounts';
import { Icon } from './icons';
import { Confirm, Dialog, RowMenu, useToast } from './ui';

type Kind = 'approve' | 'suspend' | 'reactivate' | 'assign' | 'reset';

/** All Super Admin account actions with their confirmation dialogs. Step-up is prompted automatically by the API client. */
export function useUserActions(onDone: () => void) {
  const [act, setAct] = useState<{ kind: Kind; u: UserRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [pw, setPw] = useState('');
  const [broker, setBroker] = useState('');
  const toast = useToast();
  const brokers = useQuery<{ users: { items: { id: string; username: string; displayName: string }[] } }>(`{ users(role:BROKER, status:ACTIVE, limit:100){ items{ id username displayName } } }`);

  const open = (kind: Kind, u: UserRow) => { setErr(null); setReason(''); setPw(''); setBroker(u.brokerId ?? ''); setAct({ kind, u }); };
  const close = () => setAct(null);
  const run = async (q: string, v: Record<string, unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await gql(q, v); toast(ok); close(); onDone(); }
    catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const ErrBox = () => (err ? <div className="notice err" role="alert" style={{ marginTop: 12 }}><Icon name="alert" size={18} />{err}</div> : null);

  let node = null;
  if (act?.kind === 'approve') node = (
    <Confirm title="Approve this account?" sub="They can sign in as soon as you approve." lines={[['Name', act.u.displayName], ['Username', act.u.username], ['Type', ROLE_LABEL[act.u.role]]]}
      confirmLabel="Approve account" pending={busy} error={err} onClose={close}
      onConfirm={() => run(`mutation($id:ID!){ approveUser(userId:$id){ id } }`, { id: act.u.id }, 'Account approved')} />
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
      <div className="field"><label htmlFor="np">Temporary password</label><input id="np" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /><span className="hint">At least 10 characters with three of: lowercase, uppercase, digits, symbols</span></div>
      <ErrBox />
      <div className="actions"><button className="btn" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || pw.length < 10} onClick={() => run(`mutation($id:ID!,$p:String!){ resetUserPassword(userId:$id, tempPassword:$p) }`, { id: act.u.id, p: pw }, 'Password reset')}>{busy ? 'Resetting…' : 'Reset password'}</button></div>
    </Dialog>
  );
  return { open, node, brokers: brokers.data?.users.items ?? [] };
}

export function UserActionButtons({ u, open }: { u: UserRow; open: (k: Kind, u: UserRow) => void }) {
  if (u.role === 'SUPER_ADMIN') return <span className="t3">Managed by operations</span>;
  const more = [
    ...(u.role === 'TRADER' ? [{ label: 'Change broker', onClick: () => open('assign', u) }] : []),
    { label: 'Reset password', onClick: () => open('reset', u) },
    ...(u.status === 'ACTIVE' ? [{ label: 'Suspend account', onClick: () => open('suspend', u), danger: true }] : []),
  ];
  return (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
      {u.status === 'PENDING' && <button className="btn btn-sm btn-primary" onClick={() => open('approve', u)}>Approve</button>}
      {u.status === 'SUSPENDED' && <button className="btn btn-sm" onClick={() => open('reactivate', u)}>Reactivate</button>}
      <RowMenu label={`More actions for ${u.username}`} items={more} />
    </div>
  );
}
