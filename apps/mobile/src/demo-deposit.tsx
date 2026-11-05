/**
 * DEMO ONLY: what a broker's "add funds" screen will look like (bank, QR, UTR, screenshot).
 * The details below are fixed sample values, not a real account, and the QR is a placeholder that can't be scanned.
 * Nothing typed or attached here is sent anywhere: practice funds are still only added by a Super Admin's approval.
 * Replace this with a licensed payment gateway once the company is a SEBI-registered broker.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { pickProof, ProofPicked } from './proof';
import { R, S, useTheme } from './theme';
import { Button, Field, Notice, T } from './ui';

const DEMO_BANK: [string, string][] = [
  ['Account name', 'The K Securities (DEMO)'],
  ['Bank', 'DEMO BANK'],
  ['Account no.', '0000 0000 0000'],
  ['IFSC', 'DEMO0000000'],
  ['UPI ID', 'not-a-real-upi (demo)'],
];

export function DemoDepositDetails() {
  const t = useTheme();
  const [utr, setUtr] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pick = async () => {
    setErr(null);
    try { const u = await pickProof(); if (u) setShot(u); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <View style={{ gap: S[3], borderWidth: 1, borderStyle: 'dashed', borderColor: t.line2, borderRadius: R.md, padding: S[3] }}>
      <Notice tone="warn">Demo preview: sample details, not a real account. Don’t send money. Practice funds are added when a Super Admin approves.</Notice>
      <View style={{ flexDirection: 'row', gap: S[3] }}>
        <View accessible accessibilityLabel="Demo QR placeholder, not scannable"
          style={{ width: 88, height: 88, borderRadius: R.md, backgroundColor: t.bg3, alignItems: 'center', justifyContent: 'center' }}>
          <T w="700" c="text2">DEMO QR</T>
          <T v="xs" c="text3">not scannable</T>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          {DEMO_BANK.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: S[2] }}>
              <T v="xs" c="text2">{k}</T>
              <T v="xs" w="600" style={{ flexShrink: 1, textAlign: 'right' }}>{v}</T>
            </View>
          ))}
        </View>
      </View>
      <Field label="UTR / transaction no. (demo)" value={utr} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. 431298765012"
        onChangeText={(v) => setUtr(v.replace(/[^A-Za-z0-9]/g, '').slice(0, 22))} />
      {shot ? <ProofPicked uri={shot} onChange={pick} onRemove={() => setShot(null)} /> : <Button size="sm" icon="plus" title="Attach screenshot (demo)" onPress={pick} />}
      {err ? <Notice tone="err">{err}</Notice> : null}
      <T v="xs" c="text3">Demo only: the UTR and screenshot stay on this screen and aren’t sent.</T>
    </View>
  );
}
