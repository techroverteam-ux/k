/** Super Admin → Fees: company bank accounts & UPI IDs (maker-checker) and the fee payments traders report. */
import { useSoleAdmin } from '@/sole-admin';
import { useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { ProofImage } from '@/proof';
import { useAuth } from '@/auth';
import { QR, upiLink } from '@/qr';
import { ReceivingAccount } from '@/payment-details';
import { inr, S, when } from '@/theme';
import { Badge, Button, Chips, Empty, ErrorState, Field, ListRow, Notice, Row, Screen, Section, Sheet, Skeleton, T, Tabs, toast, useQuery } from '@/ui';

interface Payee { id: string; kind: 'BANK' | 'UPI'; label: string; accountName: string; bankName?: string; accountNumber?: string; ifsc?: string; branch?: string; upiId?: string; status: string; createdById: string; createdAt: string }
interface Fee { id: string; displayName: string; username: string; payee: string; amount: string; purpose: string; utr: string; hasProof?: boolean; status: string; reviewNote?: string; createdAt: string }
const PSTATUS: Record<string, [string, 'warn' | 'ok' | 'bad' | undefined]> = { PENDING: ['Waiting for approval', 'warn'], ACTIVE: ['Live', 'ok'], REJECTED: ['Rejected', 'bad'], DISABLED: ['Disabled', undefined] };

export default function AdminFees() {
  const { me } = useAuth();
  const sole = useSoleAdmin();
  const [tab, setTab] = useState<'details' | 'payments'>('payments');
  const payees = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { id kind label accountName bankName accountNumber ifsc branch upiId status createdById createdAt } }`);
  const [st, setSt] = useState<'SUBMITTED' | 'VERIFIED' | 'REJECTED'>('SUBMITTED');
  const fees = useQuery<{ feePayments: Fee[] }>(`query($s:[String!]){ feePayments(status:$s, limit:200){ id displayName username payee amount purpose utr hasProof status reviewNote createdAt } }`, { s: [st] }, 20000);
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<{ f: Fee; ok: boolean } | null>(null);
  const [show, setShow] = useState<Fee | null>(null);
  const act = async (q: string, id: string, msg: string) => { try { await gql(q, { id }); toast(msg); void payees.refetch(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <Screen back title="Fees · bank & UPI">
      <Tabs value={tab} onChange={setTab} items={[{ k: 'payments', label: 'Payments' }, { k: 'details', label: 'Bank & UPI' }]} />
      {tab === 'payments' ? (
        <>
          <Chips value={st} onChange={setSt} items={[{ k: 'SUBMITTED', label: 'To check' }, { k: 'VERIFIED', label: 'Received' }, { k: 'REJECTED', label: 'Not confirmed' }]} />
          {fees.error && !fees.data ? <ErrorState error={fees.error} retry={fees.refetch} /> : !fees.data ? <Skeleton /> : !fees.data.feePayments.length ? <Empty icon="inbox" title="Nothing here" /> : fees.data.feePayments.map((f) => (
            <View key={f.id} style={{ gap: S[2], paddingVertical: S[3] }}>
              <Row><View style={{ flex: 1 }}><T w="600">{f.displayName} · ₹{inr(f.amount)}</T><T v="xs" c="text2">{f.purpose}</T><T v="xs" c="text3" selectable>Ref {f.utr} · to {f.payee} · {when(f.createdAt)}</T>{f.reviewNote ? <T v="xs" c="text3">{f.reviewNote}</T> : null}</View></Row>
              {f.hasProof ? <Button size="sm" icon="eye" title="View screenshot" onPress={() => setShow(f)} /> : <T v="xs" c="text3">No screenshot</T>}
              {st === 'SUBMITTED' && <Row gap={S[2]}><View style={{ flex: 1 }}><Button block size="sm" title="Not found" onPress={() => setReview({ f, ok: false })} /></View><View style={{ flex: 1 }}><Button block size="sm" kind="primary" title="Received" onPress={() => setReview({ f, ok: true })} /></View></Row>}
            </View>
          ))}
        </>
      ) : (
        <>
          <Notice>{`Traders see only Live details. ${sole ? 'You are the only Super Admin, so new details go live as soon as you add them.' : 'New details go live after a different Super Admin approves them.'} To change details, disable them and add new ones.`}</Notice>
          <Button kind="primary" icon="plus" title="Add bank account or UPI" onPress={() => setAdding(true)} />
          {payees.error && !payees.data ? <ErrorState error={payees.error} retry={payees.refetch} /> : !payees.data ? <Skeleton /> : !payees.data.payeeAccounts.length ? <Empty icon="wallet" title="No payment details yet" /> : (
            <Section title="Payment details">
              {payees.data.payeeAccounts.map((p) => {
                const [label, tone] = PSTATUS[p.status] ?? [p.status, undefined];
                return (
                  <View key={p.id} style={{ gap: S[2], paddingVertical: S[3] }}>
                    <Row gap={S[2]}><T w="600" style={{ flexShrink: 1 }}>{p.label}</T><Badge text={label} tone={tone} /></Row>
                    <ReceivingAccount payee={p} />
                    <T v="xs" c="text3">Added {when(p.createdAt)}{p.createdById === me?.id ? ' by you' : ''}</T>
                    <Row gap={S[2]}>
                      {p.status === 'PENDING' && (p.createdById !== me?.id || sole) && <View style={{ flex: 1 }}><Button block size="sm" kind="primary" title="Approve" onPress={() => void act(`mutation($id:ID!){ approvePayeeAccount(id:$id){ id } }`, p.id, 'Approved: traders can see it now')} /></View>}
                      {p.status === 'PENDING' && <View style={{ flex: 1 }}><Button block size="sm" title="Reject" onPress={() => void act(`mutation($id:ID!){ rejectPayeeAccount(id:$id){ id } }`, p.id, 'Rejected')} /></View>}
                      {p.status === 'ACTIVE' && <View style={{ flex: 1 }}><Button block size="sm" kind="sell" title="Disable" onPress={() => void act(`mutation($id:ID!){ disablePayeeAccount(id:$id){ id } }`, p.id, 'Disabled')} /></View>}
                    </Row>
                  </View>
                );
              })}
            </Section>
          )}
        </>
      )}
      {adding && <AddSheet onClose={() => setAdding(false)} onDone={() => { setAdding(false); void payees.refetch(); }} />}
      {show && (
        <Sheet visible title="Payment screenshot" sub={`₹${inr(show.amount)} from ${show.displayName} · ref ${show.utr}`} onClose={() => setShow(null)}>
          <ProofImage id={show.id} height={420} />
          {show.status === 'SUBMITTED' && <Row gap={S[2]}><View style={{ flex: 1 }}><Button block title="Not found" onPress={() => { setShow(null); setReview({ f: show, ok: false }); }} /></View><View style={{ flex: 1 }}><Button block kind="primary" title="Received" onPress={() => { setShow(null); setReview({ f: show, ok: true }); }} /></View></Row>}
        </Sheet>
      )}
      {review && <ReviewSheet f={review.f} ok={review.ok} onClose={() => setReview(null)} onDone={() => { setReview(null); void fees.refetch(); }} />}
    </Screen>
  );
}

function AddSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'BANK' | 'UPI'>('BANK');
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ label: '', accountName: '', bankName: '', accountNumber: '', ifsc: '', branch: '', upiId: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = (v: string, max: number) => v.trim().length >= 2 && v.trim().length <= max && /^[\p{L}\p{M} &'().,\-]+$/u.test(v.trim()) ? '' : `Use 2–${max} characters with no numbers.`;
  const errors = { label: name(f.label, 80), accountName: name(f.accountName, 120), bankName: name(f.bankName, 120), branch: name(f.branch, 60),
    accountNumber: /^\d{9,18}$/.test(f.accountNumber) ? '' : 'Enter 9–18 digits.',
    ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc) ? '' : 'Enter a valid 11-character IFSC.',
    upiId: kind === 'BANK' && !f.upiId.trim() ? '' : /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(f.upiId.trim()) ? '' : 'Enter a valid UPI ID, e.g. name@bank.',
  };
  const lastStep = kind === 'BANK' ? 2 : 1;
  const keys: (keyof typeof f)[] = step === 0 ? ['label', 'accountName'] : kind === 'BANK' && step === 1 ? ['accountNumber', 'ifsc', 'bankName', 'branch'] : ['upiId'];
  const field = (k: keyof typeof f, label: string, max: number) => <Field key={k} label={label} maxLength={max} autoCorrect={false} autoCapitalize={k === 'ifsc' ? 'characters' : k === 'upiId' ? 'none' : 'words'} keyboardType={k === 'accountNumber' ? 'number-pad' : 'default'} value={f[k]} error={touched ? errors[k] : null} onChangeText={(v) => {
    if (['label', 'accountName', 'bankName', 'branch'].includes(k)) v = v.replace(/\p{N}/gu, '');
    if (k === 'accountNumber') v = v.replace(/\D/g, '');
    if (k === 'ifsc') v = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setF((prev) => ({ ...prev, [k]: v }));
  }} />;
  return <Sheet visible title="Add payment details" sub={`Step ${step + 1} of ${lastStep + 1} · ${step === 0 ? 'Account names' : kind === 'BANK' && step === 1 ? 'Bank details' : kind === 'BANK' ? 'UPI and QR (optional)' : 'UPI and QR'}`} onClose={onClose}>
    {step === 0 ? <><Chips value={kind} onChange={setKind} items={[{ k: 'BANK', label: 'Bank account' }, { k: 'UPI', label: 'UPI ID' }]} />{field('label', 'Name shown to traders', 80)}{field('accountName', 'Account holder name', 120)}</> : kind === 'BANK' && step === 1 ? <>{field('accountNumber', 'Account number', 18)}{field('ifsc', 'IFSC', 11)}{field('bankName', 'Bank name', 120)}{field('branch', 'Branch name', 60)}</> : <>{field('upiId', kind === 'BANK' ? 'UPI ID (optional)' : 'UPI ID', 120)}{f.upiId.trim() && !errors.upiId ? <View style={{ alignItems: 'center' }}><QR value={upiLink(f.upiId.trim(), f.accountName.trim())} size={144} /></View> : null}</>}
    {err && <Notice tone="err">{err}</Notice>}
    <Row><Button block title={step ? 'Back' : 'Cancel'} disabled={busy} onPress={() => {setTouched(false);step ? setStep(step - 1) : onClose();}} /><Button block kind="primary" title={step === lastStep ? 'Add details' : 'Next'} busy={busy} onPress={async () => {
      setTouched(true);if (keys.some((k) => errors[k])) return;
      if (step < lastStep) {setStep(step + 1);setTouched(false);return;}
      setBusy(true);setErr(null);
      try {
        const i = kind === 'BANK' ? { kind, label: f.label.trim(), accountName: f.accountName.trim(), bankName: f.bankName.trim(), accountNumber: f.accountNumber, ifsc: f.ifsc, branch: f.branch.trim(), upiId: f.upiId.trim() || undefined } : { kind, label: f.label.trim(), accountName: f.accountName.trim(), upiId: f.upiId.trim() };
        await gql(`mutation($i:PayeeAccountInput!){ addPayeeAccount(input:$i){ id status } }`, { i });toast('Payment details added');onDone();
      } catch (e) {setErr((e as Error).message);setBusy(false);}
    }} /></Row>
  </Sheet>;
}

function ReviewSheet({ f, ok, onClose, onDone }: { f: Fee; ok: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet visible title={ok ? 'Mark as received?' : 'Mark as not found?'} sub={`₹${inr(f.amount)} from ${f.displayName} · ref ${f.utr}`} onClose={onClose}>
      {f.hasProof && <ProofImage id={f.id} height={220} />}
      <T c="text2">{ok ? 'Only confirm after you see this amount and reference in the bank statement.' : 'The trader is told why. Say what to do next.'}</T>
      <Field label={ok ? 'Note (optional)' : 'Reason'} maxLength={300} value={note} onChangeText={setNote} />
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind={ok ? 'primary' : 'sell'} size="lg" title={ok ? 'Received' : 'Not found'} busy={busy} disabled={!ok && note.trim().length < 3} onPress={async () => {
        setBusy(true); setErr(null);
        try { await gql(`mutation($id:ID!,$v:Boolean!,$n:String){ reviewFeePayment(id:$id, verified:$v, note:$n){ id } }`, { id: f.id, v: ok, n: note || undefined }); toast(ok ? 'Marked as received' : 'Marked as not found'); onDone(); }
        catch (e) { setErr((e as Error).message); setBusy(false); }
      }} />
    </Sheet>
  );
}
