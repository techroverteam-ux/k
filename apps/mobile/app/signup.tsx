import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gql } from '@/api';
import { S, useTheme } from '@/theme';
import { Button, Field, IconButton, Notice, T } from '@/ui';

/** Create account: verify the mobile by OTP, choose sign-in details; a Super Admin approves the account. */
export default function Signup() {
  const t = useTheme();
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<{ sentTo: string; devCode?: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [f, setF] = useState({ displayName: '', username: '', email: '', password: '' });
  const [done, setDone] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (wait > 0) { const h = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(h); } }, [wait]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const send = () => run(async () => {
    const d = await gql(`mutation($p:String!){ requestSignupOtp(phone:$p){ sentTo resendAfterSec devCode } }`, { p: phone });
    setSent(d.requestSignupOtp); setWait(d.requestSignupOtp.resendAfterSec); setCode('');
  });
  const register = () => run(async () => {
    const d = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ username status } }`, { i: { ...f, email: f.email || undefined, phone, code } });
    setDone(d.registerTrader.username);
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: S[2], height: 56, justifyContent: 'center' }}><IconButton icon="chevronLeft" label="Back" onPress={() => (sent && !done ? setSent(null) : router.back())} /></View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: S[6], paddingTop: S[2], gap: S[5] }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: S[2] }}>
            <T v="h1">{done ? 'Request received' : sent ? 'Your details' : 'Create an account'}</T>
            <T c="text2">{done ? 'An administrator will review your account. You can sign in once it’s approved.' : sent ? `Enter the code sent to ${sent.sentTo} and choose your sign-in details.` : 'Start with your mobile number. We’ll text a code to verify it.'}</T>
          </View>
          {done ? (
            <>
              <Notice tone="ok">Your username is {done}. Your account shows as pending until it’s approved.</Notice>
              <Button kind="primary" size="lg" title="Back to sign in" onPress={() => router.replace('/login')} />
            </>
          ) : !sent ? (
            <>
              <Field label="Mobile number" prefix="+91" keyboardType="phone-pad" maxLength={10} value={phone} onChangeText={(v) => setPhone(v.replace(/\D/g, ''))} textContentType="telephoneNumber" autoFocus />
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Send code" busy={busy} disabled={phone.length !== 10} onPress={send} />
              <T v="xs" style={{ textAlign: 'center' }}>New accounts are reviewed by an administrator before first sign-in. Paper trading only.</T>
            </>
          ) : (
            <>
              <Field label="6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} autoFocus />
              <Field label="Full name" textContentType="name" value={f.displayName} onChangeText={(v) => setF({ ...f, displayName: v })} maxLength={120} />
              <Field label="Username" autoCapitalize="none" autoCorrect={false} textContentType="username" value={f.username} onChangeText={(v) => setF({ ...f, username: v.toLowerCase() })} maxLength={40} hint="4–40 characters, starting with a letter. Letters, digits, “.” and “_”." />
              <Field label="Email (optional)" autoCapitalize="none" keyboardType="email-address" textContentType="emailAddress" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} maxLength={254} />
              <Field label="Password" secureTextEntry textContentType="newPassword" value={f.password} onChangeText={(v) => setF({ ...f, password: v })} maxLength={128} hint="At least 10 characters, using three of: lowercase, uppercase, digits, symbols." />
              {sent.devCode ? <Notice>Development mode code: {sent.devCode}. Never shown in production.</Notice> : null}
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Create account" busy={busy} disabled={code.length !== 6 || !f.displayName || !f.username || f.password.length < 10} onPress={register} />
              <Button kind="ghost" title={wait ? `Resend code in ${wait}s` : 'Resend code'} disabled={!!wait || busy} onPress={send} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
