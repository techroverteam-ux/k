/**
 * Turn on MPIN (and fingerprint) unlock for this phone: verify a one-time code once, choose an MPIN,
 * optionally add the fingerprint. Offered after signing in with a password; also from Profile.
 */
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { DEVICE_NAME, useAuth } from '@/auth';
import { Icon } from '@/icons';
import { Keypad, MPIN_LEN, PinDots, type PinHandle } from '@/pin';
import { biometry, saveQuickDevice, skipQuickSetup, type Biometry } from '@/quick';
import { S, useTheme } from '@/theme';
import { Button, Field, IconMark, ListRow, Notice, Screen, T, tap, toast } from '@/ui';

type Step = 'intro' | 'code' | 'pin' | 'confirm' | 'bio';
interface Challenge { method: 'SMS' | 'TOTP' | 'PASSWORD'; sentTo?: string | null; devCode?: string | null }
const WEAK = new Set(['1234', '4321', '0000', '1111', '1212']);

export default function QuickSetup() {
  const t = useTheme();
  const { me, reloadQuick } = useAuth();
  const [step, setStep] = useState<Step>('intro');
  const [ch, setCh] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [bio, setBio] = useState<Biometry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dots = useRef<PinHandle>(null);
  useEffect(() => { void biometry().then(setBio); }, []);

  if (!me) return null;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ beginDeviceTrust: Challenge }>(`mutation { beginDeviceTrust { method sentTo resendAfterSec devCode } }`);
      setCh(d.beginDeviceTrust); setCode(''); setStep('code');
      if (d.beginDeviceTrust.devCode) toast(`Development code: ${d.beginDeviceTrust.devCode}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const enable = async (biometric: boolean) => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ enableQuickUnlock: { deviceId: string; bioKey?: string | null } }>(
        `mutation($c:String!,$m:String!,$b:Boolean,$n:String){ enableQuickUnlock(code:$c, mpin:$m, biometric:$b, deviceName:$n){ deviceId bioKey } }`,
        { c: code, m: pin, b: biometric, n: DEVICE_NAME },
      );
      await saveQuickDevice(d.enableQuickUnlock.deviceId, { userId: me.id, username: me.username, displayName: me.displayName, biometric }, d.enableQuickUnlock.bioKey);
      const q = await reloadQuick();
      tap('heavy');
      toast(q?.owner.biometric ? `MPIN and ${bio?.label ?? 'fingerprint'} unlock are on` : 'MPIN unlock is on');
      router.back();
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      // A wrong or expired code: go back and get a new one. A rejected MPIN: choose again.
      if (/code|password/i.test(m)) setStep('code'); else { setPin(''); setPin2(''); setStep('pin'); }
    } finally { setBusy(false); }
  };

  const codeLabel = ch?.method === 'SMS' ? '6-digit code' : ch?.method === 'TOTP' ? 'Authenticator code' : 'Your password';
  return (
    <Screen back title="MPIN & fingerprint">
      {step === 'intro' && (
        <>
          <View style={{ alignItems: 'center', gap: S[3], paddingVertical: S[4] }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="fingerprint" size={38} color={t.brand} /></View>
            <T v="h2" style={{ textAlign: 'center' }}>Open the app with an MPIN{bio?.available ? ` or ${bio.label}` : ''}</T>
            <T c="text2" style={{ textAlign: 'center' }}>No more typing your password on this phone. We’ll confirm it’s you once with a one-time code.</T>
          </View>
          <ListRow left={<IconMark icon="lock" tone="brand" />} title="Checked by our server" sub="Your MPIN is never stored on the phone. 5 wrong tries turn it off." />
          <ListRow left={<IconMark icon="device" tone="brand" />} title="Only this phone" sub="Other phones and the web still need your password." />
          <ListRow left={<IconMark icon="shield" tone="brand" />} title="Locks itself" sub="When you open the app, and after 5 minutes away." />
          {err && <Notice tone="err">{err}</Notice>}
          <Button kind="primary" size="lg" title="Continue" busy={busy} onPress={send} />
          <Button kind="ghost" title="Not now" onPress={async () => { await skipQuickSetup(me.id); router.back(); }} />
        </>
      )}
      {step === 'code' && ch && (
        <>
          <T v="h3">Confirm it’s you</T>
          <T c="text2">{ch.method === 'SMS' ? `We sent a 6-digit code to ${ch.sentTo}.` : ch.method === 'TOTP' ? 'Enter the 6-digit code from your authenticator app.' : 'There’s no mobile number on your account, so confirm with your password.'}</T>
          <Field label={codeLabel} value={code} autoFocus secureTextEntry={ch.method === 'PASSWORD'}
            keyboardType={ch.method === 'PASSWORD' ? 'default' : 'number-pad'} textContentType={ch.method === 'PASSWORD' ? 'password' : 'oneTimeCode'} maxLength={ch.method === 'PASSWORD' ? 128 : 6}
            onChangeText={(v) => setCode(ch.method === 'PASSWORD' ? v : v.replace(/\D/g, ''))} />
          {err && <Notice tone="err">{err}</Notice>}
          <Button kind="primary" size="lg" title="Next" disabled={ch.method === 'PASSWORD' ? !code : code.length !== 6} onPress={() => { setErr(null); setPin(''); setPin2(''); setStep('pin'); }} />
          {ch.method === 'SMS' && <Button kind="ghost" title="Send a new code" busy={busy} onPress={send} />}
        </>
      )}
      {(step === 'pin' || step === 'confirm') && (
        <>
          <T v="h3" style={{ textAlign: 'center' }}>{step === 'pin' ? `Choose a ${MPIN_LEN}-digit MPIN` : 'Enter it again'}</T>
          <T c="text2" style={{ textAlign: 'center' }}>{step === 'pin' ? 'Avoid easy ones like 1234 or your birth year.' : 'To make sure you remember it.'}</T>
          <PinDots ref={dots} value={step === 'pin' ? pin : pin2} error={!!err} />
          <View style={{ minHeight: 44 }}>{err ? <Notice tone="err">{err}</Notice> : null}</View>
          <Keypad value={step === 'pin' ? pin : pin2} disabled={busy} onChange={(v) => {
            setErr(null);
            if (step === 'pin') {
              setPin(v);
              if (v.length === MPIN_LEN) {
                if (WEAK.has(v) || /^(\d)\1+$/.test(v)) { dots.current?.shake(); setErr('That MPIN is too easy to guess. Pick another.'); setPin(''); return; }
                setTimeout(() => setStep('confirm'), 120);
              }
            } else {
              setPin2(v);
              if (v.length === MPIN_LEN) {
                if (v !== pin) { dots.current?.shake(); setErr('The MPINs don’t match. Start again.'); setPin(''); setPin2(''); setStep('pin'); return; }
                if (bio?.available) setStep('bio'); else void enable(false);
              }
            }
          }} />
        </>
      )}
      {step === 'bio' && bio && (
        <>
          <View style={{ alignItems: 'center', gap: S[3], paddingVertical: S[4] }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="fingerprint" size={38} color={t.brand} /></View>
            <T v="h2" style={{ textAlign: 'center' }}>Use {bio.label} too?</T>
            <T c="text2" style={{ textAlign: 'center' }}>Unlock with {bio.label} and keep the MPIN as a backup. Anyone whose {bio.label === 'Face ID' || bio.label === 'Face unlock' ? 'face' : 'fingerprint'} is set up on this phone will be able to open the app.</T>
          </View>
          {err && <Notice tone="err">{err}</Notice>}
          <Button kind="primary" size="lg" icon="fingerprint" title={`Use ${bio.label}`} busy={busy} onPress={() => enable(true)} />
          <Button kind="ghost" title="MPIN only" disabled={busy} onPress={() => enable(false)} />
        </>
      )}
    </Screen>
  );
}
