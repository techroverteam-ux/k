'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@/lib/hooks';
import { inr } from '@/lib/format';
import { toProofDataUrl } from '@/lib/image';
import { PAYEE_FIELDS, UpiQr, upiLink, type Payee } from './fees';
import { Empty, ErrorState, SkeletonRows } from './ui';

export interface PaymentDraft {
  payeeAccountId: string;
  utr: string;
  payerName: string;
  paidOn: string;
  proof?: string;
}
export const newPaymentDraft = (): PaymentDraft => ({
  payeeAccountId: '',
  utr: '',
  payerName: '',
  paidOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
});
export const paymentInput = (p: PaymentDraft) => ({
  payeeAccountId: p.payeeAccountId,
  utr: p.utr.trim().toUpperCase(),
  payerName: p.payerName.trim(),
  paidAt: new Date(`${p.paidOn}T00:00:00+05:30`).toISOString(),
  proof: p.proof || undefined,
});
export function paymentError(p: PaymentDraft) {
  if (!p.payeeAccountId) return 'Choose the receiving account you paid.';
  if (!/^[A-Za-z0-9]{6,30}$/.test(p.utr.trim())) return 'Enter the UTR / reference (6–30 letters and digits).';
  if (p.payerName.trim().length < 2 || p.payerName.trim().length > 120)
    return 'Enter the payer’s name (2–120 characters).';
  const date = new Date(`${p.paidOn}T00:00:00+05:30`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidOn) || !Number.isFinite(date.getTime()) || date.getTime() > Date.now())
    return 'Enter a valid payment date that is not in the future.';
  return '';
}

export function ReceivingAccount({
  payee,
}: {
  payee: Pick<Payee, 'label' | 'accountName' | 'accountNumber' | 'bankName' | 'ifsc' | 'branch' | 'upiId'>;
}) {
  const lines = [
    ['Account holder', payee.accountName],
    ['Bank', payee.bankName],
    ['Account number', payee.accountNumber],
    ['IFSC', payee.ifsc],
    ['Branch', payee.branch],
    ['UPI ID', payee.upiId],
  ].filter(([, v]) => !!v);
  return (
    <div className="payment-destination">
      <div className="payment-destination-info">
        <strong>{payee.label}</strong>
        <dl>
          {lines.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {payee.upiId && (
        <div className="payment-qr">
          <UpiQr upiId={payee.upiId} name={payee.accountName} size={144} />
          <a className="btn btn-sm" href={upiLink(payee.upiId, payee.accountName)}>
            Open UPI app
          </a>
        </div>
      )}
    </div>
  );
}

export function ReceivingAccountPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { ${PAYEE_FIELDS} } }`);
  const accounts = (q.data?.payeeAccounts ?? []).filter((p) => p.status === 'ACTIVE');
  useEffect(() => {
    if (!value && accounts[0]) onChange(accounts[0].id);
  }, [value, q.data]);
  if (!q.data && q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data) return <SkeletonRows rows={2} />;
  if (!accounts.length)
    return (
      <Empty icon="wallet" title="Payment details unavailable">
        The Super Admin needs to add an active bank account or UPI ID before a payment can be submitted.
      </Empty>
    );
  const selected = accounts.find((p) => p.id === value);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="field">
        <label htmlFor="receiving-account">Pay the Super Admin</label>
        <select id="receiving-account" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Choose receiving account
          </option>
          {accounts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {selected ? <ReceivingAccount payee={selected} /> : <p className="err">Choose an active receiving account.</p>}
      <p className="hint">
        After paying, enter the UTR / reference from your bank or UPI app. The Super Admin verifies the payment before
        approving it.
      </p>
    </div>
  );
}

export function PaymentReferenceFields({
  value,
  onChange,
  onBusyChange,
}: {
  value: PaymentDraft;
  onChange: (next: PaymentDraft) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [error, setError] = useState('');
  const latest = useRef(value);
  latest.current = value;
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="field">
        <label htmlFor="payer-name">Payer name</label>
        <input
          id="payer-name"
          className="input"
          maxLength={120}
          value={value.payerName}
          onChange={(e) => onChange({ ...value, payerName: e.target.value })}
          placeholder="Name on the paying account"
        />
      </div>
      <div className="form-grid-2">
        <div className="field">
          <label htmlFor="payment-utr">UTR / payment reference</label>
          <input
            id="payment-utr"
            className="input"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={30}
            value={value.utr}
            onChange={(e) => onChange({ ...value, utr: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })}
          />
        </div>
        <div className="field">
          <label htmlFor="payment-date">Payment date</label>
          <input
            id="payment-date"
            className="input"
            type="date"
            max={newPaymentDraft().paidOn}
            value={value.paidOn}
            onChange={(e) => onChange({ ...value, paidOn: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="fund-proof">Payment screenshot (optional)</label>
        <input
          id="fund-proof"
          disabled={busy}
          className="input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setError('');
            setBusy(true);
            onBusyChange?.(true);
            try {
              const proof = await toProofDataUrl(file);
              onChange({ ...latest.current, proof });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
        {busy && <span className="hint">Preparing screenshot…</span>}
        {value.proof && (
          <div className="row">
            <span className="hint">Screenshot attached</span>
            <button
              type="button"
              disabled={busy}
              className="btn btn-sm"
              onClick={() => onChange({ ...value, proof: undefined })}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface PaymentEvidence {
  id: string;
  userId: string;
  payeeAccountId: string;
  payee: string;
  accountName: string;
  accountNumber?: string;
  bankName?: string;
  ifsc?: string;
  branch?: string;
  upiId?: string;
  amount: string;
  utr: string;
  payerName: string;
  paidAt: string;
  hasProof: boolean;
  createdAt: string;
}
export const EVIDENCE_FIELDS =
  'id userId payeeAccountId payee accountName bankName accountNumber ifsc branch upiId amount utr payerName paidAt hasProof createdAt';
export function PaymentEvidenceDetails({ evidence }: { evidence: PaymentEvidence }) {
  const [show, setShow] = useState(false);
  const proof = useQuery<{ paymentEvidenceProof: string }>(
    `query($id:ID!){ paymentEvidenceProof(id:$id) }`,
    { id: evidence.id },
    { skip: !show },
  );
  return (
    <section className="stack" style={{ gap: 10 }} aria-label="Submitted payment details">
      <h3>Submitted payment</h3>
      <ul className="confirm-lines" style={{ margin: 0 }}>
        {[
          ['Amount paid', `₹${inr(evidence.amount)}`],
          ['Payer', evidence.payerName],
          ['UTR / reference', evidence.utr],
          ['Payment date', new Date(evidence.paidAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })],
          ['Receiving account', evidence.payee],
          ['Account holder', evidence.accountName],
          ['Bank', evidence.bankName],
          ['Account number', evidence.accountNumber],
          ['IFSC', evidence.ifsc],
          ['Branch', evidence.branch],
          ['UPI ID', evidence.upiId],
        ]
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <li key={k}>
              <span className="t2">{k}</span>
              <span className="w6 num">{v}</span>
            </li>
          ))}
      </ul>
      {evidence.hasProof ? (
        <button type="button" className="btn btn-sm" onClick={() => setShow(!show)}>
          {show ? 'Hide screenshot' : 'View payment screenshot'}
        </button>
      ) : (
        <p className="hint">No screenshot attached.</p>
      )}
      {show &&
        (proof.error ? (
          <ErrorState error={proof.error} retry={proof.refetch} />
        ) : proof.data ? (
          <a href={proof.data.paymentEvidenceProof} target="_blank" rel="noreferrer">
            <img
              src={proof.data.paymentEvidenceProof}
              alt="Payment screenshot"
              style={{ width: '100%', maxHeight: 280, objectFit: 'contain' }}
            />
          </a>
        ) : (
          <SkeletonRows rows={2} />
        ))}
    </section>
  );
}

export function OpeningPaymentDetails({ userId, onReady }: { userId: string; onReady?: (ready: boolean) => void }) {
  const q = useQuery<{ openingPayment: PaymentEvidence | null }>(
    `query($id:ID!){ openingPayment(userId:$id){ ${EVIDENCE_FIELDS} } }`,
    { id: userId },
  );
  useEffect(() => {
    onReady?.(!!q.data && !q.error);
  }, [q.data, q.error, onReady]);
  if (!q.data && q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data) return <SkeletonRows rows={2} />;
  return q.data.openingPayment ? (
    <PaymentEvidenceDetails evidence={q.data.openingPayment} />
  ) : (
    <div className="notice warn">
      No payment details were attached to this request. Verify the payment before approving an opening balance.
    </div>
  );
}
