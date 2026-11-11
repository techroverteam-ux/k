'use client';
import { ReenableResetTrader } from './account-resets';
import { AccountWipes } from './wipe';
import { useSoleAdmin } from '@/lib/sole-admin';
import { useAuth } from '@/lib/auth';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@/lib/hooks';
import { inr, initials, when } from '@/lib/format';
import { Icon } from './icons';
import { LedgerTable, OrdersTable, PAYMENT_FIELDS, PaymentDialog, PortfolioSummary, PositionsTable, type Payment } from './trading';
import { Dialog, Empty, ErrorState, SkeletonRows, Status, Tabs, useToast } from './ui';

export interface UserRow { resetDisabledAt?: string; id: string; username: string; displayName: string; role: string; status: string; mode: string; isDemo: boolean; brokerId?: string; brokerName?: string; createdByName?: string; openingAmount?: string; commissionPct?: string; commissionPerMiniLot?: string; commissionPerMegaLot?: string; commissionIsDefault?: boolean; mfaEnabled: boolean; createdAt: string; phone?: string }
export const USER_FIELDS = 'id username displayName role status mode isDemo brokerId brokerName createdByName openingAmount commissionPct commissionPerMiniLot commissionPerMegaLot commissionIsDefault mfaEnabled resetDisabledAt createdAt phone';
/** "40.00" → "40%"; empty for non-brokers. Brokers without their own value use the platform default. */
export const pctLabel = (u: Pick<UserRow, 'role' | 'commissionPerMiniLot' | 'commissionPerMegaLot'>) => (u.role !== 'BROKER' ? '' : u.commissionPerMiniLot ? `₹${Number(u.commissionPerMiniLot).toLocaleString('en-IN')} / mini lot · ₹${Number(u.commissionPerMegaLot).toLocaleString('en-IN')} / mega` : '');
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
  const [f, setF] = useState({ username: '', displayName: '', role: roles[0], phone: '', email: '', brokerId: '', tempPassword: '', commMini: '', commMega: '', openingAmount: '' });
  const [showPw, setShowPw] = useState(false);
  const sole = useSoleAdmin();
  const { me, settings } = useAuth();
  const asBroker = me?.role === 'BROKER';
  const minOpen = Number(settings?.minDeposit ?? 50000);
  const minLabel = minOpen.toLocaleString('en-IN');
  const [touched, setTouched] = useState(false);
  const m = useMutation(`mutation($i:CreateUserInput!){ createUser(input:$i){ id status } }`);
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const errs = {
    username: !/^[a-z][a-z0-9_.@#-]{3,39}$/.test(f.username.trim().toLowerCase()) ? '4–40 chars, start with letter' : '',
    displayName: !f.displayName.trim() ? 'Enter a name' : '',
    phone: f.phone && !/^[6-9]\d{9}$/.test(f.phone) ? 'Enter a 10-digit mobile' : '',
    email: f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) ? 'Enter a valid email' : '',
    tempPassword: f.tempPassword.length < 10 ? 'At least 10 characters' : '',
    openingAmount: f.role === 'TRADER' && (asBroker || f.openingAmount.trim()) && !(/^\d{1,12}(\.\d{1,2})?$/.test(f.openingAmount.trim()) && Number(f.openingAmount) >= minOpen) ? `Enter at least ₹${minLabel}` : '',
    commMini: f.role === 'BROKER' && f.commMini.trim() && !/^\d{1,7}(\.\d{1,2})?$/.test(f.commMini.trim()) ? 'Enter rupees, e.g. 170' : '',
    commMega: f.role === 'BROKER' && f.commMega.trim() && !/^\d{1,7}(\.\d{1,2})?$/.test(f.commMega.trim()) ? 'Enter rupees, e.g. 1700' : '',
  };
  const bad = Object.values(errs).some(Boolean);
  const E = ({ k }: { k: keyof typeof errs }) => (touched && errs[k] ? <span className="err" style={{ fontSize: '11px', marginTop: 2 }}>{errs[k]}</span> : null);
  return (
    <Dialog title={asBroker ? 'Add trader' : 'Create account'} sub={asBroker ? 'This sends a request to the Super Admin. When approved, the trader can sign in.' : sole ? 'The account can sign in straight away.' : 'New accounts can sign in after Super Admin approval.'} size="lg" onClose={onClose}>
      <form noValidate onSubmit={async (e) => {
        e.preventDefault(); setTouched(true);
        if (bad) return;
        const r = await m.run({ i: { username: f.username, displayName: f.displayName, role: f.role, phone: f.phone || undefined, email: f.email || undefined, brokerId: f.role === 'TRADER' && f.brokerId ? f.brokerId : undefined, tempPassword: f.tempPassword, commissionPerMiniLot: f.role === 'BROKER' && f.commMini.trim() ? f.commMini.trim() : undefined, commissionPerMegaLot: f.role === 'BROKER' && f.commMega.trim() ? f.commMega.trim() : undefined, openingAmount: f.role === 'TRADER' && f.openingAmount.trim() ? f.openingAmount.trim() : undefined } });
        if (r) { toast((r as { createUser?: { status?: string } }).createUser?.status === 'ACTIVE' ? 'Account created and active' : asBroker ? 'Request sent to the Super Admin' : 'Account created and sent for approval'); onDone(); onClose(); }
      }}>
        <div className="form-grid-2">
          {roles.length > 1 && (
            <div className="field">
              <label htmlFor="role">Account type</label>
              <select id="role" className="input" value={f.role} onChange={set('role')}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
            </div>
          )}
          {f.role === 'TRADER' && brokers && (
            <div className="field">
              <label htmlFor="br">Broker</label>
              <select id="br" className="input" value={f.brokerId} onChange={set('brokerId')}><option value="">No broker</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.username}</option>)}</select>
            </div>
          )}
          <div className="field">
            <label htmlFor="dn">Full name</label>
            <input id="dn" className="input" placeholder="e.g. Rahul Sharma" value={f.displayName} onChange={set('displayName')} maxLength={120} aria-invalid={touched && !!errs.displayName} />
            <E k="displayName" />
          </div>
          <div className="field">
            <label htmlFor="un">Username</label>
            <input id="un" className="input" placeholder="e.g. rahul_s" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-invalid={touched && !!errs.username} autoCapitalize="none" />
            <E k="username" />
          </div>
          <div className="field">
            <label htmlFor="ph">Mobile (optional)</label>
            <input id="ph" className="input num" placeholder="10-digit number" inputMode="tel" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} aria-invalid={touched && !!errs.phone} />
            <E k="phone" />
          </div>
          <div className="field">
            <label htmlFor="em">Email (optional)</label>
            <input id="em" type="email" className="input" placeholder="name@example.com" value={f.email} onChange={set('email')} aria-invalid={touched && !!errs.email} />
            <E k="email" />
          </div>
          {f.role === 'TRADER' && (
            <div className="field">
              <label htmlFor="oa">Opening amount{asBroker ? '' : ' (optional)'}</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-2)', pointerEvents: 'none' }}>₹</span>
                <input id="oa" className="input num" inputMode="decimal" placeholder={minLabel} value={f.openingAmount} onChange={(e) => setF({ ...f, openingAmount: e.target.value.replace(/[^\d.]/g, '') })} aria-invalid={touched && !!errs.openingAmount} style={{ paddingLeft: 26 }} />
              </div>
              {touched && errs.openingAmount ? <E k="openingAmount" /> : <span className="hint" style={{ fontSize: '11px', marginTop: 2 }}>Min ₹{minLabel}</span>}
            </div>
          )}
          <div className={`field ${f.role === 'BROKER' && roles.length <= 1 ? 'col-span-2' : ''}`}>
            <label htmlFor="tp">Temporary password</label>
            <div style={{ position: 'relative' }}>
              <input
                id="tp"
                className="input"
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Min 10 characters"
                value={f.tempPassword}
                onChange={set('tempPassword')}
                aria-invalid={touched && !!errs.tempPassword}
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowPw(!showPw)}
                title={showPw ? 'Hide password' : 'View password'}
                aria-label={showPw ? 'Hide password' : 'View password'}
                style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 34, height: 34, color: showPw ? 'var(--brand)' : 'var(--text-3)' }}
              >
                <Icon name={showPw ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
            {touched && errs.tempPassword ? <E k="tempPassword" /> : <span className="hint" style={{ fontSize: '11px', marginTop: 2 }}>Min 10 characters (letters, digits, symbols)</span>}
          </div>
          {f.role === 'BROKER' && (
            <div className="col-span-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s3)', borderTop: '1px solid var(--line)', paddingTop: 'var(--s2)' }}>
              <div className="field">
                <label htmlFor="cmi" className="sm t2">Mini lot commission (₹)</label>
                <input id="cmi" className="input num" inputMode="decimal" placeholder="170" value={f.commMini} onChange={(e) => setF({ ...f, commMini: e.target.value.replace(/[^\d.]/g, '') })} aria-invalid={touched && !!errs.commMini} />
                <E k="commMini" />
              </div>
              <div className="field">
                <label htmlFor="cmg" className="sm t2">Mega lot commission (₹)</label>
                <input id="cmg" className="input num" inputMode="decimal" placeholder="1700" value={f.commMega} onChange={(e) => setF({ ...f, commMega: e.target.value.replace(/[^\d.]/g, '') })} aria-invalid={touched && !!errs.commMega} />
                <E k="commMega" />
              </div>
            </div>
          )}
        </div>
        {m.error && <div className="notice err" role="alert" style={{ marginTop: 8 }}><Icon name="alert" size={18} />{m.error}</div>}
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={m.pending}>{m.pending ? (asBroker ? 'Sending…' : 'Creating…') : asBroker ? 'Send for approval' : 'Create account'}</button>
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
          <div><h1 style={{ fontSize: 22 }}>{t.displayName}</h1><div className="row" style={{ gap: 8 }}><span className="t3">{t.username} · {ROLE_LABEL[t.role]}{t.role === 'BROKER' ? ` · ${pctLabel(t)}` : ''}</span><Status value={t.status} /></div></div>
        </div>
        <div className="row">
          {actions?.(t)}
          {!actions && <ReenableResetTrader user={t} onDone={u.refetch} />}
          {t.role === 'TRADER' && t.status === 'ACTIVE' && <>
            <button className="btn" onClick={() => setPay('WITHDRAWAL')}>Request withdrawal</button>
            <button className="btn btn-primary" onClick={() => setPay('DEPOSIT')}>Request deposit</button>
          </>}
        </div>
      </div>
      {t.role === 'TRADER' ? (
        <>
          <AccountWipes userId={id} />
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
