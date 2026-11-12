/** Funds → Pay fees: the company's bank / UPI details (real money, not the virtual balance) and "I've paid" with the UTR. */
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { gql } from '@/api';
import { inr, S, useTheme, when } from '@/theme';
import { QR, upiLink } from '@/qr';
import { pickProof, ProofImage, ProofPicked } from '@/proof';
import { Badge, Button, Empty, ErrorState, Field, ListRow, Notice, Screen, Section, Sheet, Skeleton, T, toast, useQuery } from '@/ui';

interface Payee { id: string; kind: 'BANK' | 'UPI'; label: string; accountName: string; bankName?: string; accountNumber?: string; ifsc?: string; branch?: string; upiId?: string }
interface Fee { id: string; payee: string; amount: string; purpose: string; utr: string; hasProof?: boolean; status: string; reviewNote?: string; createdAt: string }
const STATUS: Record<string, [string, 'warn' | 'ok' | 'bad']> = { SUBMITTED: ['Checking', 'warn'], VERIFIED: ['Received', 'ok'], REJECTED: ['Not confirmed', 'bad'] };

export default function Fees() {
  const t = useTheme();
  const payees = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { id kind label accountName bankName accountNumber ifsc branch upiId } }`);
  const mine = useQuery<{ feePayments: Fee[] }>(`{ feePayments(limit:50) { id payee amount purpose utr hasProof status reviewNote createdAt } }`);
  const [form, setForm] = useState<Payee | null>(null);
  const [show, setShow] = useState<Fee | null>(null);
  const list = payees.data?.payeeAccounts ?? [];
  const Line = ({ k, v }: { k: string; v?: string }) => (v ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: S[3], paddingVertical: 6 }}><T c="text2">{k}</T><T w="600" selectable style={{ flexShrink: 1, textAlign: 'right' }}>{v}</T></View> : null);
  return (
    <Screen back title="Pay fees">
      <T c="text2">Course and subscription fees are paid to the account below. Pay, then tap “I’ve paid” and attach the payment screenshot. Long-press a detail to copy it.</T>
      {payees.error && !payees.data ? <ErrorState error={payees.error} retry={payees.refetch} /> : !payees.data ? <Skeleton /> : !list.length ? <Empty icon="wallet" title="No payment details yet">Your administrator hasn’t added them yet.</Empty> : list.map((p) => (
        <View key={p.id} style={{ borderWidth: 1, borderColor: t.line, borderRadius: 16, padding: S[4], gap: S[2] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T w="700">{p.label}</T><Badge text={p.kind === 'UPI' ? 'UPI' : 'Bank transfer'} /></View>
          <Line k="Name" v={p.accountName} />
          {p.accountNumber && <><Line k="Account number" v={p.accountNumber} /><Line k="IFSC" v={p.ifsc} /><Line k="Bank" v={p.bankName} /><Line k="Branch" v={p.branch} /></>}
          {p.upiId && <Line k="UPI ID" v={p.upiId} />}
          {p.upiId && (
            <View style={{ alignItems: 'center', gap: S[2], paddingVertical: S[2] }}>
              <View style={{ padding: 8, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: t.line }}><QR value={upiLink(p.upiId, p.accountName)} size={200} /></View>
              <T v="sm" c="text2">Scan with any UPI app: GPay, PhonePe, Paytm, BHIM</T>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: S[2], marginTop: S[2] }}>
            {p.upiId && <View style={{ flex: 1 }}><Button block title="Pay with UPI app" onPress={() => { void Linking.openURL(upiLink(p.upiId!, p.accountName)).catch(() => toast('No UPI app found on this phone', true)); }} /></View>}
            <View style={{ flex: 1 }}><Button block kind="primary" title="I’ve paid" onPress={() => setForm(p)} /></View>
          </View>
        </View>
      ))}
      {(mine.data?.feePayments.length ?? 0) > 0 && (
        <Section title="Your payments">
          {mine.data!.feePayments.map((f) => {
            const [label, tone] = STATUS[f.status] ?? [f.status, 'warn'];
            return <ListRow key={f.id} onPress={f.hasProof ? () => setShow(f) : undefined} title={`₹${inr(f.amount)} · ${f.purpose}`} sub={`Ref ${f.utr} · ${when(f.createdAt)}${f.hasProof ? ' · tap to see screenshot' : ''}${f.reviewNote ? ` · ${f.reviewNote}` : ''}`} right={<Badge text={label} tone={tone} />} />;
          })}
        </Section>
      )}
      {show && <Sheet visible title="Payment screenshot" sub={`₹${inr(show.amount)} · ref ${show.utr}`} onClose={() => setShow(null)}><ProofImage id={show.id} height={420} /></Sheet>}
      {form && <PaidSheet payee={form} onClose={() => setForm(null)} onDone={() => { setForm(null); void mine.refetch(); }} />}
    </Screen>
  );
}

function PaidSheet({ payee, onClose, onDone }: { payee: Payee; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [utr, setUtr] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = /^\d{1,9}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && purpose.trim().length >= 2 && /^[A-Za-z0-9]{6,30}$/.test(utr.trim()) && !!proof;
  const pick = async () => {
    setReading(true); setErr(null);
    try { const d = await pickProof(); if (d) setProof(d); } catch (e) { setErr((e as Error).message); } finally { setReading(false); }
  };
  return (
    <Sheet visible title="Tell us about your payment" sub={`Paid to ${payee.label}. We’ll check it against our bank statement.`} onClose={onClose}>
      <Field label="Amount paid (₹)" keyboardType="decimal-pad" value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} />
      <Field label="What it’s for" placeholder="e.g. Course fee, November batch" maxLength={120} value={purpose} onChangeText={setPurpose} />
      <Field label="UTR / reference number" placeholder="From your bank or UPI app" autoCapitalize="characters" maxLength={30} value={utr} onChangeText={(v) => setUtr(v.replace(/\s/g, ''))} hint="The 12-digit UPI reference, or the bank transfer UTR." />
      <View style={{ gap: S[2] }}>
        <T v="sm" c="text2" w="500">Payment screenshot</T>
        {proof ? <ProofPicked uri={proof} onChange={() => void pick()} onRemove={() => setProof(null)} /> : (
          <Button icon="download" title={reading ? 'Preparing…' : 'Choose screenshot'} busy={reading} onPress={() => void pick()} />
        )}
        <T v="xs" c="text3">The success screen from your UPI or bank app, showing the amount and reference.</T>
      </View>
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Submit" busy={busy} disabled={!ok} onPress={async () => {
        setBusy(true); setErr(null);
        try { await gql(`mutation($p:ID!,$a:String!,$w:String!,$u:String!,$s:String!){ submitFeePayment(payeeAccountId:$p, amount:$a, purpose:$w, utr:$u, proof:$s){ id } }`, { p: payee.id, a: amount, w: purpose, u: utr.trim(), s: proof }); toast('Thanks! We’ll confirm it shortly.'); onDone(); }
        catch (e) { setErr((e as Error).message); setBusy(false); }
      }} />
    </Sheet>
  );
}
