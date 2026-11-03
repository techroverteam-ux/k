'use client';
import { useSoleAdmin } from '@/lib/sole-admin';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { gql } from '@/lib/api';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Dialog, Empty, ErrorState, SectionHead, SkeletonRows, Tabs, useToast } from './ui';

export interface Payee { id: string; kind: 'BANK' | 'UPI'; label: string; accountName: string; bankName?: string; accountNumber?: string; ifsc?: string; branch?: string; upiId?: string; status: string; createdById: string; createdAt: string }
export interface Fee { id: string; userId: string; username: string; displayName: string; payee: string; amount: string; purpose: string; utr: string; status: string; reviewNote?: string; reviewedAt?: string; createdAt: string }
const PAYEE_FIELDS = 'id kind label accountName bankName accountNumber ifsc branch upiId status createdById createdAt';
const FEE_FIELDS = 'id userId username displayName payee amount purpose utr status reviewNote reviewedAt createdAt';
const FEE_STATUS: Record<string, [string, string]> = { SUBMITTED: ['Checking', 'warn'], VERIFIED: ['Received', 'ok'], REJECTED: ['Not confirmed', 'bad'] };
const PAYEE_STATUS: Record<string, [string, string]> = { PENDING: ['Waiting for approval', 'warn'], ACTIVE: ['Live', 'ok'], REJECTED: ['Rejected', 'bad'], DISABLED: ['Disabled', ''] };

const upiLink = (upiId: string, name: string, note = 'Course fee') =>
  `upi://pay?pa=${encodeURIComponent(upiId).replace(/%40/g, '@')}&pn=${encodeURIComponent(name)}&cu=INR&tn=${encodeURIComponent(note)}`;

/** Scannable UPI QR (standard upi://pay link), generated in the browser. */
function UpiQr({ upiId, name }: { upiId: string; name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let on = true; void QRCode.toDataURL(upiLink(upiId, name), { margin: 1, width: 360, errorCorrectionLevel: 'M' }).then((u) => on && setSrc(u)); return () => { on = false; }; }, [upiId, name]);
  return (
    <div className="stack" style={{ alignItems: 'center', gap: 6 }}>
      {src ? <img src={src} alt={`UPI QR code for ${upiId}`} width={180} height={180} style={{ borderRadius: 12, background: '#fff', padding: 6, border: '1px solid var(--line)' }} /> : <div className="skeleton" style={{ width: 180, height: 180 }} />}
      <span className="t3 sm">Scan with any UPI app: GPay, PhonePe, Paytm, BHIM</span>
    </div>
  );
}

function CopyRow({ k, v }: { k: string; v?: string }) {
  const toast = useToast();
  if (!v) return null;
  return (
    <li>
      <span className="t2">{k}</span>
      <span className="row" style={{ gap: 6 }}><span className="num w6">{v}</span>
        <button type="button" className="icon-btn" aria-label={`Copy ${k}`} title="Copy" onClick={() => { void navigator.clipboard?.writeText(v).then(() => toast(`${k} copied`)); }}><Icon name="file" size={16} /></button>
      </span>
    </li>
  );
}

/* ================================================================== trader / broker: pay fees */
export function PayFees() {
  const payees = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { ${PAYEE_FIELDS} } }`);
  const mine = useQuery<{ feePayments: Fee[] }>(`{ feePayments(limit:50) { ${FEE_FIELDS} } }`);
  const [form, setForm] = useState<Payee | null>(null);
  const list = payees.data?.payeeAccounts ?? [];
  if (payees.loading && !payees.data) return null;
  if (!list.length && !(mine.data?.feePayments.length)) return null;
  return (
    <section className="section">
      <SectionHead title="Pay fees" />
      <p className="t2 sm" style={{ margin: 0 }}>Course and subscription fees are paid in real money to the account below. They don’t change your virtual trading balance.</p>
      {payees.error && !payees.data ? <ErrorState error={payees.error} retry={payees.refetch} /> : (
        <div className="fee-grid">
          {list.map((p) => (
            <div key={p.id} className="panel panel-pad stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="w6">{p.label}</span><span className="badge">{p.kind === 'UPI' ? 'UPI' : 'Bank transfer'}</span></div>
              <ul className="confirm-lines" style={{ margin: 0 }}>
                <CopyRow k="Name" v={p.accountName} />
                {p.kind === 'BANK' ? (<><CopyRow k="Account number" v={p.accountNumber} /><CopyRow k="IFSC" v={p.ifsc} /><CopyRow k="Bank" v={[p.bankName, p.branch].filter(Boolean).join(', ') || undefined} /></>) : <CopyRow k="UPI ID" v={p.upiId} />}
              </ul>
              {p.kind === 'UPI' && p.upiId && <UpiQr upiId={p.upiId} name={p.accountName} />}
              <div className="row" style={{ gap: 8 }}>
                {p.kind === 'UPI' && <a className="btn btn-sm" href={upiLink(p.upiId!, p.accountName)}>Pay with UPI app</a>}
                <button className="btn btn-sm btn-primary" onClick={() => setForm(p)}>I’ve paid</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {(mine.data?.feePayments.length ?? 0) > 0 && (
        <div className="panel"><div className="list list-pad">
          {mine.data!.feePayments.map((f) => {
            const [label, tone] = FEE_STATUS[f.status] ?? [f.status, ''];
            return (
              <div key={f.id} className="list-row">
                <div className="grow"><div className="w6">₹{inr(f.amount)} · {f.purpose}</div><div className="t3 sm">Ref {f.utr} · {when(f.createdAt)} · to {f.payee}{f.reviewNote ? ` · ${f.reviewNote}` : ''}</div></div>
                <span className={`badge ${tone}`}>{label}</span>
              </div>
            );
          })}
        </div></div>
      )}
      {form && <FeeForm payee={form} onClose={() => setForm(null)} onDone={() => { setForm(null); void mine.refetch(); }} />}
    </section>
  );
}

function FeeForm({ payee, onClose, onDone }: { payee: Payee; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const ok = /^\d{1,9}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && purpose.trim().length >= 2 && /^[A-Za-z0-9]{6,30}$/.test(utr.trim());
  return (
    <Dialog title="Tell us about your payment" sub={`Paid to ${payee.label}. We’ll check it against our bank statement.`} onClose={onClose}>
      <form className="stack" style={{ gap: 14 }} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          await gql(`mutation($p:ID!,$a:String!,$w:String!,$u:String!){ submitFeePayment(payeeAccountId:$p, amount:$a, purpose:$w, utr:$u){ id } }`, { p: payee.id, a: amount, w: purpose, u: utr.trim() });
          toast('Thanks! We’ll confirm it shortly.'); onDone();
        } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <div className="field"><label htmlFor="fee-amt">Amount paid (₹)</label><input id="fee-amt" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} autoFocus /></div>
        <div className="field"><label htmlFor="fee-for">What it’s for</label><input id="fee-for" className="input" maxLength={120} placeholder="e.g. Course fee, November batch" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
        <div className="field"><label htmlFor="fee-utr">UTR / reference number</label><input id="fee-utr" className="input" maxLength={30} placeholder="From your bank or UPI app" value={utr} onChange={(e) => setUtr(e.target.value.replace(/\s/g, ''))} /><span className="t3 xs">The 12-digit UPI reference, or the bank transfer UTR.</span></div>
        {err && <div className="notice err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !ok}>Submit</button></div>
      </form>
    </Dialog>
  );
}

/* ================================================================== Super Admin: bank & UPI master + fee payments */
export function FeesAdmin({ meId }: { meId: string }) {
  const sole = useSoleAdmin();
  const payees = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { ${PAYEE_FIELDS} } }`);
  const [tab, setTab] = useState<'SUBMITTED' | 'VERIFIED' | 'REJECTED'>('SUBMITTED');
  const fees = useQuery<{ feePayments: Fee[] }>(`query($s:[String!]){ feePayments(status:$s, limit:200) { ${FEE_FIELDS} } }`, { s: [tab] }, { pollMs: 20_000 });
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<{ f: Fee; ok: boolean } | null>(null);
  const toast = useToast();
  const act = async (q: string, id: string, msg: string) => { try { await gql(q, { id }); toast(msg); void payees.refetch(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <div className="stack" style={{ gap: 32 }}>
      <section className="section">
        <SectionHead title="Bank accounts & UPI"><button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add</button></SectionHead>
        <p className="t3 sm" style={{ margin: 0 }}>Traders see only <b>Live</b> details. New details go live after a different Super Admin checks and approves them. To change details, disable the old ones and add new ones.</p>
        {payees.loading && !payees.data ? <SkeletonRows rows={2} pad={false} /> : payees.error && !payees.data ? <ErrorState error={payees.error} retry={payees.refetch} /> : !payees.data!.payeeAccounts.length ? <Empty icon="wallet" title="No payment details yet">Add your company bank account or UPI ID.</Empty> : (
          <div className="panel"><div className="list list-pad">
            {payees.data!.payeeAccounts.map((p) => {
              const [label, tone] = PAYEE_STATUS[p.status] ?? [p.status, ''];
              return (
                <div key={p.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div className="grow" style={{ minWidth: 220 }}>
                    <div className="row" style={{ gap: 8 }}><span className="w6">{p.label}</span><span className={`badge ${tone}`}>{label}</span></div>
                    <div className="t3 sm">{p.accountName} · {p.kind === 'BANK' ? `A/c ${p.accountNumber} · IFSC ${p.ifsc}${p.bankName ? ` · ${p.bankName}` : ''}` : `UPI ${p.upiId}`}</div>
                    <div className="t3 xs">Added {when(p.createdAt)}{p.createdById === meId ? ' by you' : ''}</div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    {p.status === 'PENDING' && (p.createdById !== meId || sole) && <button className="btn btn-sm btn-primary" onClick={() => void act(`mutation($id:ID!){ approvePayeeAccount(id:$id){ id } }`, p.id, 'Approved: traders can see it now')}>Approve</button>}
                    {p.status === 'PENDING' && <button className="btn btn-sm" onClick={() => void act(`mutation($id:ID!){ rejectPayeeAccount(id:$id){ id } }`, p.id, 'Rejected')}>Reject</button>}
                    {p.status === 'ACTIVE' && <button className="btn btn-sm btn-danger" onClick={() => void act(`mutation($id:ID!){ disablePayeeAccount(id:$id){ id } }`, p.id, 'Disabled')}>Disable</button>}
                  </div>
                </div>
              );
            })}
          </div></div>
        )}
      </section>
      <section className="section">
        <SectionHead title="Fee payments" />
        <Tabs label="Status" value={tab} onChange={setTab} items={[{ v: 'SUBMITTED', label: 'To check' }, { v: 'VERIFIED', label: 'Received' }, { v: 'REJECTED', label: 'Not confirmed' }]} />
        {fees.loading && !fees.data ? <SkeletonRows rows={3} pad={false} /> : fees.error && !fees.data ? <ErrorState error={fees.error} retry={fees.refetch} /> : !fees.data!.feePayments.length ? <Empty icon="inbox" title="Nothing here" /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Trader</th><th className="r">Amount</th><th>For</th><th>Reference</th><th>To</th><th>When</th>{tab === 'SUBMITTED' && <th />}</tr></thead>
            <tbody>{fees.data!.feePayments.map((f) => (
              <tr key={f.id}>
                <td><span className="w6">{f.displayName}</span><span className="sub" style={{ display: 'block' }}>{f.username}</span></td>
                <td className="r num w6">₹{inr(f.amount)}</td>
                <td>{f.purpose}{f.reviewNote && <span className="sub" style={{ display: 'block' }}>{f.reviewNote}</span>}</td>
                <td className="num">{f.utr}</td>
                <td className="t2 sm">{f.payee}</td>
                <td className="t2 sm">{when(f.createdAt)}</td>
                {tab === 'SUBMITTED' && <td className="r"><div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}><button className="btn btn-sm btn-primary" onClick={() => setReview({ f, ok: true })}>Received</button><button className="btn btn-sm" onClick={() => setReview({ f, ok: false })}>Not found</button></div></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {adding && <AddPayee onClose={() => setAdding(false)} onDone={() => { setAdding(false); void payees.refetch(); }} />}
      {review && <ReviewFee f={review.f} ok={review.ok} onClose={() => setReview(null)} onDone={() => { setReview(null); void fees.refetch(); }} />}
    </div>
  );
}

function AddPayee({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'BANK' | 'UPI'>('BANK');
  const [f, setF] = useState({ label: '', accountName: '', bankName: '', accountNumber: '', ifsc: '', branch: '', upiId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title="Add payment details" sub="A different Super Admin must approve them before traders see them." onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          const i = kind === 'BANK' ? { kind, label: f.label, accountName: f.accountName, bankName: f.bankName || undefined, accountNumber: f.accountNumber, ifsc: f.ifsc, branch: f.branch || undefined } : { kind, label: f.label, accountName: f.accountName, upiId: f.upiId };
          const d = await gql<{ addPayeeAccount: { status: string } }>(`mutation($i:PayeeAccountInput!){ addPayeeAccount(input:$i){ id status } }`, { i });
          toast(d.addPayeeAccount.status === 'ACTIVE' ? 'Added: traders can see it now' : 'Added. Another Super Admin needs to approve it.'); onDone();
        } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <Tabs label="Type" value={kind} onChange={setKind} items={[{ v: 'BANK', label: 'Bank account' }, { v: 'UPI', label: 'UPI ID' }]} />
        <div className="field"><label htmlFor="pa-label">Name for this (shown to traders)</label><input id="pa-label" className="input" maxLength={80} placeholder={kind === 'BANK' ? 'e.g. HDFC current account' : 'e.g. Company UPI'} value={f.label} onChange={set('label')} /></div>
        <div className="field"><label htmlFor="pa-name">Account holder name</label><input id="pa-name" className="input" maxLength={120} value={f.accountName} onChange={set('accountName')} /></div>
        {kind === 'BANK' ? (
          <>
            <div className="field"><label htmlFor="pa-no">Account number</label><input id="pa-no" className="input" inputMode="numeric" maxLength={18} value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value.replace(/\D/g, '') })} /></div>
            <div className="two"><div className="field"><label htmlFor="pa-ifsc">IFSC</label><input id="pa-ifsc" className="input" maxLength={11} value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label htmlFor="pa-bank">Bank (optional)</label><input id="pa-bank" className="input" maxLength={120} value={f.bankName} onChange={set('bankName')} /></div></div>
            <div className="field"><label htmlFor="pa-branch">Branch (optional)</label><input id="pa-branch" className="input" maxLength={120} value={f.branch} onChange={set('branch')} /></div>
          </>
        ) : (
          <div className="field"><label htmlFor="pa-upi">UPI ID</label><input id="pa-upi" className="input" maxLength={120} placeholder="name@bank" value={f.upiId} onChange={set('upiId')} /></div>
        )}
        <div className="notice info"><Icon name="info" size={18} /><span>Double-check every digit. Traders will send real money here.</span></div>
        {err && <div className="notice err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Add for approval</button></div>
      </form>
    </Dialog>
  );
}

function ReviewFee({ f, ok, onClose, onDone }: { f: Fee; ok: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Dialog title={ok ? 'Mark as received?' : 'Mark as not found?'} sub={`₹${inr(f.amount)} from ${f.displayName} · ref ${f.utr}`} onClose={onClose}>
      <form className="stack" style={{ gap: 12 }} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await gql(`mutation($id:ID!,$v:Boolean!,$n:String){ reviewFeePayment(id:$id, verified:$v, note:$n){ id } }`, { id: f.id, v: ok, n: note || undefined }); toast(ok ? 'Marked as received' : 'Marked as not found'); onDone(); }
        catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <p className="t2 sm" style={{ margin: 0 }}>{ok ? 'Only confirm after you see this amount and reference in the bank statement.' : 'The trader is told why. Say what to do next.'}</p>
        <div className="field"><label htmlFor="fee-note">{ok ? 'Note (optional)' : 'Reason'}</label><input id="fee-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={ok ? '' : 'e.g. No payment with this reference in our account'} /></div>
        {err && <div className="notice err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className={`btn ${ok ? 'btn-primary' : 'btn-sell'}`} disabled={busy || (!ok && note.trim().length < 3)}>{ok ? 'Received' : 'Not found'}</button></div>
      </form>
    </Dialog>
  );
}
