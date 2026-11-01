/** Profile → MPIN & fingerprint: status, change MPIN, fingerprint on/off, turn off. */
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { useAuth } from '@/auth';
import { Icon } from '@/icons';
import { Keypad, MPIN_LEN, PinDots, type PinHandle } from '@/pin';
import { biometry, forgetBiometric, type Biometry } from '@/quick';
import { S, useTheme, when } from '@/theme';
import { Button, ErrorState, IconMark, Lines, ListRow, Notice, Screen, Section, Sheet, Skeleton, T, toast, useQuery } from '@/ui';

export default function QuickSettings() {
  const t = useTheme();
  const { me, quick, reloadQuick, dropQuick } = useAuth();
  const [bio, setBio] = useState<Biometry | null>(null);
  const [change, setChange] = useState(false);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const mine = !!quick && quick.owner.userId === me?.id;
  const st = useQuery<{ trustedDevice: { biometric: boolean; deviceName?: string; createdAt: string; lastUsedAt?: string } | null }>(
    `query($d:ID!){ trustedDevice(deviceId:$d){ biometric deviceName createdAt lastUsedAt } }`, { d: quick?.deviceId }, undefined, !mine);
  useEffect(() => { void biometry().then(setBio); }, []);
  // The server turned it off (password changed, admin…): forget it here too.
  useEffect(() => { if (mine && st.data && !st.data.trustedDevice) void dropQuick(); }, [mine, st.data, dropQuick]);

  if (!mine) return (
    <Screen back title="MPIN & fingerprint">
      <View style={{ alignItems: 'center', gap: S[3], paddingVertical: S[6] }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.bg3, alignItems: 'center', justifyContent: 'center' }}><Icon name="fingerprint" size={38} color={t.text3} /></View>
        <T v="h3">Off on this phone</T>
        <T c="text2" style={{ textAlign: 'center' }}>Open the app with a {MPIN_LEN}-digit MPIN{bio?.available ? ` or ${bio.label}` : ''} instead of your password. You’ll confirm it’s you once with a one-time code.</T>
      </View>
      <Button kind="primary" size="lg" title="Set up" onPress={() => router.push('/quick-setup')} />
    </Screen>
  );
  const d = st.data?.trustedDevice;
  return (
    <Screen back title="MPIN & fingerprint">
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.refetch} /> : !d ? <Skeleton rows={3} /> : (
        <>
          <Notice tone="ok">MPIN unlock is on for this phone{quick.owner.biometric ? `, with ${bio?.label ?? 'fingerprint'}` : ''}.</Notice>
          <Lines lines={[['Phone', d.deviceName ?? 'This phone'], ['Turned on', when(d.createdAt)], ['Last unlocked', d.lastUsedAt ? when(d.lastUsedAt) : 'Not yet']]} />
          <Section title="Options">
            <ListRow onPress={() => setChange(true)} label="Change MPIN" left={<IconMark icon="key" />} title="Change MPIN" right={<Icon name="chevronRight" size={18} color={t.text3} />} />
            {bio?.available && (quick.owner.biometric
              ? <ListRow onPress={async () => { await forgetBiometric(); await reloadQuick(); toast(`${bio.label} unlock turned off`); }} label={`Turn off ${bio.label}`} left={<IconMark icon="fingerprint" />} title={`Turn off ${bio.label}`} sub="Keep using the MPIN" />
              : <ListRow onPress={() => router.push('/quick-setup')} label={`Add ${bio.label}`} left={<IconMark icon="fingerprint" tone="brand" />} title={`Add ${bio.label}`} sub="Set up again with a one-time code" right={<Icon name="chevronRight" size={18} color={t.text3} />} />)}
            <ListRow onPress={() => setOff(true)} label="Turn off MPIN unlock" left={<IconMark icon="lock" tone="neg" />} title={<T w="600" c="neg">Turn off MPIN unlock</T>} sub="You’ll sign in with your password again" />
          </Section>
          <T v="xs">The app locks when you open it and after 5 minutes in the background. Changing your password, or signing out other devices, turns MPIN unlock off on other phones.</T>
        </>
      )}
      {change && <ChangeMpinSheet deviceId={quick.deviceId} onClose={() => setChange(false)} />}
      {off && (
        <Sheet visible title="Turn off MPIN unlock?" sub="You’ll need your password to sign in on this phone." onClose={() => setOff(false)}>
          <View style={{ flexDirection: 'row', gap: S[3] }}>
            <View style={{ flex: 1 }}><Button block title="Cancel" onPress={() => setOff(false)} /></View>
            <View style={{ flex: 1 }}><Button block kind="sell" title="Turn off" busy={busy} onPress={async () => {
              setBusy(true);
              try { await gql(`mutation($d:ID!){ disableQuickUnlock(deviceId:$d) }`, { d: quick.deviceId }); } catch { /* forget it here anyway */ }
              await dropQuick(); setBusy(false); setOff(false); toast('MPIN unlock turned off'); router.back();
            }} /></View>
          </View>
        </Sheet>
      )}
    </Screen>
  );
}

function ChangeMpinSheet({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const [step, setStep] = useState<'cur' | 'new' | 'again'>('cur');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dots = useRef<PinHandle>(null);
  const value = step === 'cur' ? cur : step === 'new' ? next : again;
  const fail = (m: string) => { dots.current?.shake(); setErr(m); };
  return (
    <Sheet visible title="Change MPIN" sub={step === 'cur' ? 'Enter your current MPIN' : step === 'new' ? 'Choose a new MPIN' : 'Enter the new MPIN again'} onClose={onClose}>
      <PinDots ref={dots} value={value} error={!!err} />
      <View style={{ minHeight: 44 }}>{err ? <Notice tone="err">{err}</Notice> : null}</View>
      <Keypad value={value} disabled={busy} onChange={async (v) => {
        setErr(null);
        if (step === 'cur') { setCur(v); if (v.length === MPIN_LEN) setTimeout(() => setStep('new'), 120); return; }
        if (step === 'new') {
          setNext(v);
          if (v.length === MPIN_LEN) { if (/^(\d)\1+$/.test(v) || ['1234', '4321', '1212'].includes(v)) { fail('That MPIN is too easy to guess.'); setNext(''); } else setTimeout(() => setStep('again'), 120); }
          return;
        }
        setAgain(v);
        if (v.length < MPIN_LEN) return;
        if (v !== next) { fail('The new MPINs don’t match.'); setNext(''); setAgain(''); setStep('new'); return; }
        setBusy(true);
        try {
          await gql(`mutation($d:ID!,$a:String!,$b:String!){ changeMpin(deviceId:$d, currentMpin:$a, newMpin:$b) }`, { d: deviceId, a: cur, b: v });
          toast('MPIN changed'); onClose();
        } catch (e) { fail((e as Error).message); setCur(''); setNext(''); setAgain(''); setStep('cur'); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}
