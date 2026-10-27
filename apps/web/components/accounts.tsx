'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@/lib/hooks';
import { inr, initials, when } from '@/lib/format';
import { Icon } from './icons';
import { LedgerTable, OrdersTable, PAYMENT_FIELDS, PaymentDialog, PortfolioSummary, PositionsTable, type Payment } from './trading';
import { Dialog, Empty, ErrorState, SkeletonRows, Status, Tabs, useToast } from './ui';

export interface UserRow { id: string; username: string; displayName: string; role: string; status: string; mode: string; isDemo: boolean; brokerId?: string; mfaEnabled: boolean; createdAt: string; phone?: string }
export const USER_FIELDS = 'id username displayName role status mode isDemo brokerId mfaEnabled createdAt phone';
export const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'Super Admin', BROKER: 'Broker', TRADER: 'Trader' };

export function Person({ u, href }: { u: Pick<UserRow, 'displayName' | 'username'>; href?: string }) {
  const body = (
    <span className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
      <span className="avatar" aria-hidden>{initials(u.displayName)}</span>
      <span style={{ minWidth: 0 }}><span className="w6" style={{ display: 'block', whiteSpace: 'nowrap' }}>{u.displayName}</span><span className="t3">{u.username}</span></span>
    </span>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** Create a broker or trader. Accounts start PENDING until a Super Admin approves them. */
export function CreateUserDialog({ roles, brokers, onClose, onDone }: { roles: ('BROKER' | 'TRADER')[]; brokers?: { id: string; username: string }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: '', displayName: '', role: roles[0], phone: '', email: '', brokerId: '', tempPassword: '' });
  const [touched, setTouched] = useState(false);
  const m = useMutation(`mutation($i:CreateUserInput!){ createUser(input:$i){ id status } }`);
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const errs = {
    username: !/^[a-z][a-z0-9_.]{3,39}$/.test(f.username) ? '4–40 characters: lowercase letters, digits, _ or ., starting with a letter' : '',
    displayName: !f.displayName.trim() ? 'Enter a name' : '',
    phone: f.phone && !/^[6-9]\d{9}$/.test(f.phone) ? 'Enter a 10-digit mobile number' : '',
    email: f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) ? 'Enter a valid email' : '',
    tempPassword: f.tempPassword.length < 10 ? 'At least 10 characters' : '',
  };
  const bad = Object.values(errs).some(Boolean);
  const E = ({ k }: { k: keyof typeof errs }) => (touched && errs[k] ? <span className="err">{errs[k]}</span> : null);
  return (
    <Dialog title="Create account" sub="New accounts can sign in after a Super Admin approves them." onClose={onClose}>
      <form className="stack" noValidate onSubmit={async (e) => {
        e.preventDefault(); setTouched(true);
        if (bad) return;
        const r = await m.run({ i: { username: f.username, displayName: f.displayName, role: f.role, phone: f.phone || undefined, email: f.email || undefined, brokerId: f.role === 'TRADER' && f.brokerId ? f.brokerId : undefined, tempPassword: f.tempPassword } });
        if (r) { toast('Account created and sent for approval'); onDone(); onClose(); }
      }}>
        {roles.length > 1 && (
          <div className="field"><label htmlFor="role">Account type</label>
            <select id="role" className="input" value={f.role} onChange={set('role')}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          </div>
        )}
        <div className="field"><label htmlFor="dn">Full name</label><input id="dn" className="input" value={f.displayName} onChange={set('displayName')} maxLength={120} aria-invalid={touched && !!errs.displayName} /><E k="displayName" /></div>
        <div className="field"><label htmlFor="un">Username</label><input id="un" className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-invalid={touched && !!errs.username} autoCapitalize="none" /><E k="username" /></div>
        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div className="field grow"><label htmlFor="ph">Mobile (optional)</label><input id="ph" className="input num" inputMode="tel" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} aria-invalid={touched && !!errs.phone} /><E k="phone" /></div>
          <div className="field grow"><label htmlFor="em">Email (optional)</label><input id="em" type="email" className="input" value={f.email} onChange={set('email')} aria-invalid={touched && !!errs.email} /><E k="email" /></div>
        </div>
        {f.role === 'TRADER' && brokers && (
          <div className="field"><label htmlFor="br">Broker</label>
            <select id="br" className="input" value={f.brokerId} onChange={set('brokerId')}><option value="">No broker</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.username}</option>)}</select>
          </div>
        )}
        <div className="field"><label htmlFor="tp">Temporary password</label><input id="tp" className="input" type="password" autoComplete="new-password" value={f.tempPassword} onChange={set('tempPassword')} aria-invalid={touched && !!errs.tempPassword} />
          {touched && errs.tempPassword ? <E k="tempPassword" /> : <span className="hint">Use three of: lowercase, uppercase, digits, symbols. Share it privately.</span>}
        </div>
        {m.error && <div className="notice err" role="alert"><Icon name="alert" size={18} />{m.error}</div>}
        <div className="actions" style={{ marginTop: 4 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={m.pending}>{m.pending ? 'Creating…' : 'Create account'}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Read-only account view used by brokers (assigned traders) and admins (any trader). */
export function AccountDetail({ id, back, actions }: { id: string; back: { href: string; label: string }; actions?: (u: UserRow) => ReactNode }) {
  const u = useQuery<{ user: UserRow }>(`query($id:ID!){ user(id:$id){ ${USER_FIELDS} } }`, { id });
  const [tab, setTab] = useState<'positions' | 'orders' | 'ledger' | 'requests'>('positions');
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  if (u.error) return <ErrorState error={u.error} retry={u.refetch} />;
  if (!u.data) return <SkeletonRows rows={6} />;
  const t = u.data.user;
  return (
    <div className="stack" style={{ gap: 32 }}>
      <Link href={back.href} className="t2 sm row" style={{ gap: 4 }}><Icon name="chevronLeft" size={16} />{back.label}</Link>
      <div className="spread">
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>{initials(t.displayName)}</span>
          <div><h1 style={{ fontSize: 22 }}>{t.displayName}</h1><div className="row" style={{ gap: 8 }}><span className="t3">{t.username} · {ROLE_LABEL[t.role]}</span><Status value={t.status} /></div></div>
        </div>
        <div className="row">
          {actions?.(t)}
          {t.role === 'TRADER' && <>
            <button className="btn" onClick={() => setPay('WITHDRAWAL')}>Request withdrawal</button>
            <button className="btn btn-primary" onClick={() => setPay('DEPOSIT')}>Request deposit</button>
          </>}
        </div>
      </div>
      {t.role === 'TRADER' ? (
        <>
          <PortfolioSummary userId={id} title="Available balance" />
          <section>
            <Tabs label="Account data" value={tab} onChange={setTab} items={[{ v: 'positions', label: 'Positions' }, { v: 'orders', label: 'Orders' }, { v: 'ledger', label: 'Ledger' }, { v: 'requests', label: 'Fund requests' }]} />
            <div style={{ marginTop: 8 }}>
              {tab === 'positions' && <PositionsTable userId={id} />}
              {tab === 'orders' && <OrdersTable userId={id} emptyText="This trader hasn't placed any orders." />}
              {tab === 'ledger' && <LedgerTable userId={id} />}
              {tab === 'requests' && <UserRequests userId={id} />}
            </div>
          </section>
          <p className="t3">Read-only view. Traders place their own orders.</p>
        </>
      ) : <Empty icon="user" title="No trading account">Only traders have balances, positions and orders.</Empty>}
      {pay && <PaymentDialog type={pay} userId={id} onClose={() => setPay(null)} />}
    </div>
  );
}

function UserRequests({ userId }: { userId: string }) {
  const { data, loading, error, refetch } = useQuery<{ paymentRequests: Payment[] }>(`query($u:ID){ paymentRequests(userId:$u, limit:50){ ${PAYMENT_FIELDS} } }`, { u: userId });
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.paymentRequests.length) return <Empty icon="wallet" title="No fund requests" />;
  return (
    <div className="list list-pad">
      {data!.paymentRequests.map((p) => (
        <div key={p.id} className="list-row">
          <div className="grow"><div className="w5">{p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</div><div className="t3">{when(p.createdAt)}{p.reviewNote ? ` · ${p.reviewNote}` : ''}</div></div>
          <div className="quote-cell" style={{ gap: 4 }}><span className="num w6">₹{inr(p.amount)}</span><Status value={p.status} /></div>
        </div>
      ))}
    </div>
  );
}
