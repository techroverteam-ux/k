/**
 * The lock screen: shown when the app opens (or comes back after a while) on a phone with MPIN/fingerprint
 * unlock. A correct MPIN or fingerprint opens a new session; the server counts wrong MPINs and turns quick
 * unlock off after 5, after which this falls back to the password sign-in.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, gql, rememberSignedOut } from './api';
import { DEVICE_NAME, homeFor, useAuth } from './auth';
import { AUTH_FIELDS, ConflictPrompt, type AuthPayload } from './conflict';
import { Logo } from './icons';
import { Keypad, MPIN_LEN, PinDots, type PinHandle } from './pin';
import { biometry, readBioKey, type Biometry } from './quick';
import { S, useTheme } from './theme';
import { Button, Notice, T, toast } from './ui';

const UNLOCK = `mutation($d:ID!,$m:String,$k:String,$n:String){ quickUnlock(deviceId:$d, mpin:$m, bioKey:$k, deviceName:$n){ ${AUTH_FIELDS} } }`;

export function LockScreen() {
  const t = useTheme();
  const { quick, signIn, dropQuick, toPassword, unlocked } = useAuth();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState<Biometry | null>(null);
  const [conflict, setConflict] = useState<AuthPayload | null>(null);
  const dots = useRef<PinHandle>(null);
  const tried = useRef(false);
  const owner = quick?.owner;
  const first = owner?.displayName.split(' ')[0] ?? '';

  const finish = useCallback(async (a: string, r: string) => {
    const me = await signIn(a, r);
    if (!me) return;
    unlocked();
    router.replace(homeFor(me.role));
  }, [signIn, unlocked]);

  const submit = useCallback(async (v: { mpin?: string; bioKey?: string }) => {
    if (!quick) return;
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ quickUnlock: AuthPayload }>(UNLOCK, { d: quick.deviceId, m: v.mpin ?? null, k: v.bioKey ?? null, n: DEVICE_NAME });
      if (d.quickUnlock.sessionConflict) { setConflict(d.quickUnlock); return; }
      if (d.quickUnlock.accessToken) await finish(d.quickUnlock.accessToken, d.quickUnlock.refreshToken!);
    } catch (e) {
      const x = e as ApiError;
      setPin('');
      if (x.reason === 'QUICK_UNLOCK_OFF') {
        // Too many wrong MPINs, revoked by an admin, password changed…: back to the password.
        await dropQuick();
        rememberSignedOut(x.message);
        toPassword();
        return;
      }
      dots.current?.shake();
      setErr(x.message);
    } finally { setBusy(false); }
  }, [quick, finish, dropQuick, toPassword]);

  const askBio = useCallback(async () => {
    const k = await readBioKey(`Unlock ${first ? `as ${first}` : 'the app'}`);
    if (k === 'locked') { setErr('Too many fingerprint attempts. Use your MPIN for now.'); return; }
    if (k === 'gone') { setErr('Fingerprint unlock isn’t available any more on this phone. Use your MPIN, then turn it on again in Profile.'); setBio((b) => (b ? { ...b, available: false } : b)); return; }
    if (k) await submit({ bioKey: k });
  }, [first, submit]);

  useEffect(() => { void biometry().then(setBio); }, []);
  // Offer the fingerprint straight away, once.
  useEffect(() => {
    if (!tried.current && owner?.biometric && bio?.available) { tried.current = true; void askBio(); }
  }, [owner?.biometric, bio?.available, askBio]);

  const onPin = (v: string) => {
    setPin(v); setErr(null);
    if (v.length === MPIN_LEN) void submit({ mpin: v });
  };

  if (!quick) return null;
  const canBio = !!owner?.biometric && !!bio?.available;
  return (
    <SafeAreaView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.bg, zIndex: 50 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: S[6], gap: S[4], justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
        {conflict ? (
          <ConflictPrompt p={conflict} onDone={finish} onCancel={() => setConflict(null)} />
        ) : (
          <>
            <View style={{ alignItems: 'center', gap: S[3] }}>
              <Logo size={52} brand={t.brand} />
              <T v="h2" style={{ textAlign: 'center' }}>Welcome back{first ? `, ${first}` : ''}</T>
              <T c="text2" style={{ textAlign: 'center' }}>{busy ? 'Unlocking…' : canBio ? `Enter your MPIN or use ${bio!.label}` : 'Enter your MPIN'}</T>
            </View>
            <PinDots ref={dots} value={pin} error={!!err} />
            <View style={{ minHeight: 44, justifyContent: 'center' }}>{err ? <Notice tone="err">{err}</Notice> : null}</View>
            <Keypad value={pin} onChange={onPin} disabled={busy} onBiometric={canBio ? () => void askBio() : undefined} biometricLabel={bio?.label} />
            <View style={{ alignItems: 'center', gap: S[1], marginTop: S[2] }}>
              <Button kind="ghost" title="Forgot MPIN? Sign in with password" onPress={toPassword} />
              <Button kind="ghost" size="sm" title={`Not ${first || 'you'}? Use another account`} onPress={async () => { await dropQuick(); toast('MPIN unlock removed from this phone'); toPassword(); }} />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
