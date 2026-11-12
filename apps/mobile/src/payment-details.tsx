import { useEffect, useRef, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { QR, upiLink } from './qr';
import { pickProof, ProofPicked } from './proof';
import { inr, S } from './theme';
import { Button, Chips, DateField, Empty, ErrorState, Field, Lines, Notice, Skeleton, T, toast, useQuery } from './ui';

export interface Payee {
  id: string;
  kind: 'BANK' | 'UPI';
  label: string;
  accountName: string;
  bankName?: string;
  accountNumber?: string;
  ifsc?: string;
  branch?: string;
  upiId?: string;
  status: string;
}
export const PAYEE_FIELDS = 'id kind label accountName bankName accountNumber ifsc branch upiId status';
export interface PaymentDraft {
  payeeAccountId: string;
  payerName: string;
  utr: string;
  paidOn: string;
  proof?: string;
}
export const newPaymentDraft = (): PaymentDraft => ({
  payeeAccountId: '',
  payerName: '',
  utr: '',
  paidOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
});
export const paymentInput = (p: PaymentDraft) => ({
  payeeAccountId: p.payeeAccountId,
  payerName: p.payerName.trim(),
  utr: p.utr.trim().toUpperCase(),
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
    return 'Enter a valid payment date that is not in the future (YYYY-MM-DD).';
  return '';
}
export function ReceivingAccount({ payee }: { payee: Payee }) {
  return (
    <View style={{ gap: S[2] }}>
      <T w="600">{payee.label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: S[2] }}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {[
            ['Account holder', payee.accountName],
            ['Bank', payee.bankName],
            ['Account number', payee.accountNumber],
            ['IFSC', payee.ifsc],
            ['Branch', payee.branch],
            ['UPI ID', payee.upiId],
          ]
            .filter(([, v]) => !!v)
            .map(([k, v]) => (
              <View key={k}>
                <T v="xs" c="text2">
                  {k}
                </T>
                <T v="sm" w="600" selectable>
                  {v}
                </T>
              </View>
            ))}
        </View>
        {payee.upiId && (
          <View style={{ width: 128, alignItems: 'center', gap: S[2] }}>
            <QR value={upiLink(payee.upiId, payee.accountName)} size={128} />
            <Button
              size="sm"
              title="Open UPI app"
              onPress={() =>
                void Linking.openURL(upiLink(payee.upiId!, payee.accountName)).catch(() =>
                  toast('Open a UPI app and pay using the ID shown.', true),
                )
              }
            />
          </View>
        )}
      </View>
    </View>
  );
}
export function ReceivingAccountPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery<{ payeeAccounts: Payee[] }>(`{ payeeAccounts { ${PAYEE_FIELDS} } }`);
  const accounts = (q.data?.payeeAccounts ?? []).filter((p) => p.status === 'ACTIVE');
  useEffect(() => {
    if (!value && accounts[0]) onChange(accounts[0].id);
  }, [value, q.data]);
  if (!q.data && q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (!q.data) return <Skeleton rows={2} />;
  if (!accounts.length)
    return (
      <Empty icon="wallet" title="Payment details unavailable">
        The Super Admin needs to add an active bank account or UPI ID.
      </Empty>
    );
  const selected = accounts.find((p) => p.id === value);
  return (
    <View style={{ gap: S[3] }}>
      <T w="600">Pay the Super Admin</T>
      <Chips value={value} onChange={onChange} items={accounts.map((p) => ({ k: p.id, label: p.label }))} />
      {selected ? (
        <ReceivingAccount payee={selected} />
      ) : (
        <Notice tone="err">Choose an active receiving account.</Notice>
      )}
      <T v="xs" c="text2">
        After paying, enter the reference from the bank or UPI app. The Super Admin verifies it before approval.
      </T>
    </View>
  );
}
export function PaymentReferenceFields({
  value,
  onChange,
  onBusyChange,
}: {
  value: PaymentDraft;
  onChange: (p: PaymentDraft) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  const pick = async () => {
    setBusy(true);
    onBusyChange?.(true);
    try {
      const proof = await pickProof();
      if (proof) onChange({ ...latest.current, proof });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <View style={{ gap: S[3] }}>
      <Field
        label="Payer name"
        maxLength={120}
        value={value.payerName}
        onChangeText={(payerName) => onChange({ ...value, payerName })}
        placeholder="Name on the paying account"
      />
      <Field
        label="UTR / payment reference"
        maxLength={30}
        autoCapitalize="characters"
        autoCorrect={false}
        value={value.utr}
        onChangeText={(utr) => onChange({ ...value, utr: utr.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })}
      />
      <DateField
        label="Payment date"
        max={newPaymentDraft().paidOn}
        value={value.paidOn}
        onChange={(paidOn) => onChange({ ...value, paidOn })}
      />
      {value.proof ? (
        <ProofPicked
          uri={value.proof}
          onChange={() => void pick()}
          onRemove={() => onChange({ ...value, proof: undefined })}
        />
      ) : (
        <Button title="Attach screenshot (optional)" icon="file" busy={busy} onPress={() => void pick()} />
      )}
    </View>
  );
}

export interface PaymentEvidence {
  id: string;
  userId: string;
  payeeAccountId: string;
  payee: string;
  accountName: string;
  bankName?: string;
  accountNumber?: string;
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
function EvidenceProof({ id }: { id: string }) {
  const q = useQuery<{ paymentEvidenceProof: string }>(`query($id:ID!){ paymentEvidenceProof(id:$id) }`, { id });
  return q.error ? (
    <ErrorState error={q.error} retry={q.refetch} />
  ) : q.data ? (
    <Image
      source={{ uri: q.data.paymentEvidenceProof }}
      style={{ width: '100%', height: 260 }}
      resizeMode="contain"
      accessibilityLabel="Payment screenshot"
    />
  ) : (
    <Skeleton rows={2} />
  );
}
export function PaymentEvidenceDetails({ evidence }: { evidence: PaymentEvidence }) {
  const [show, setShow] = useState(false);
  const lines = [
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
  ].filter(([, v]) => !!v) as [string, string][];
  return (
    <View style={{ gap: S[3] }}>
      <T w="600">Submitted payment</T>
      <Lines lines={lines} />
      {evidence.hasProof ? (
        <Button title={show ? 'Hide screenshot' : 'View payment screenshot'} onPress={() => setShow(!show)} />
      ) : (
        <T v="xs" c="text2">
          No screenshot attached.
        </T>
      )}
      {show && <EvidenceProof id={evidence.id} />}
    </View>
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
  if (!q.data) return <Skeleton rows={2} />;
  return q.data.openingPayment ? (
    <PaymentEvidenceDetails evidence={q.data.openingPayment} />
  ) : (
    <Notice tone="warn">
      No payment details were attached. Verify the payment before approving an opening balance.
    </Notice>
  );
}
