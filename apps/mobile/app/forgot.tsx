import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gql } from '@/api';
import { S, useTheme } from '@/theme';
import { Button, Field, IconButton, Notice, T, toast } from '@/ui';

/** Forgot password: a code goes to the mobile number on the account; the answer never says whether the account exists. */
export default function Forgot() {
  const t = useTheme();
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState<{ message: string; devCode?: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (wait > 0) { const h = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(h); } }, [wait]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const send = () => run(async () => {
    const d = await gql(`mutation($u:String!){ requestPasswordReset(username:$u){ message resendAfterSec devCode } }`, { u: username.trim() });
    setSent(d.requestPasswordReset); setWait(d.requestPasswordReset.resendAfterSec); setCode('');
  });
  const reset = () => run(async () => {
    await gql(`mutation($u:String!,$c:String!,$p:String!){ resetPassword(username:$u, code:$c, newPassword:$p) }`, { u: username.trim(), c: code, p: pw });
    toast('Password changed. Sign in with your new password.');
    router.replace('/login');
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: S[2], height: 56, justifyContent: 'center' }}><IconButton icon="chevronLeft" label="Back" onPress={() => (sent ? setSent(null) : router.back())} /></View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: S[6], paddingTop: S[2], gap: S[5] }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: S[2] }}>
            <T v="h1">{sent ? 'Enter the code' : 'Reset your password'}</T>
            <T c="text2">{sent ? sent.message : 'We’ll text a code to the mobile number on your account.'}</T>
          </View>
          {!sent ? (
            <>
              <Field label="Username" autoCapitalize="none" autoCorrect={false} textContentType="username" value={username} onChangeText={setUsername} maxLength={40} autoFocus />
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Send code" busy={busy} disabled={!username.trim()} onPress={send} />
              <T v="xs" style={{ textAlign: 'center' }}>No mobile number on your account, or an administrator account? Ask your broker or administrator to reset it.</T>
            </>
          ) : (
            <>
              <Field label="6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} autoFocus />
              <Field label="New password" secureTextEntry textContentType="newPassword" value={pw} onChangeText={setPw} maxLength={128} hint="At least 10 characters, using three of: lowercase, uppercase, digits, symbols." />
              {sent.devCode ? <Notice>Development mode code: {sent.devCode}. Never shown in production.</Notice> : null}
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Set new password" busy={busy} disabled={code.length !== 6 || pw.length < 10} onPress={reset} />
              <Button kind="ghost" title={wait ? `Resend code in ${wait}s` : 'Resend code'} disabled={!!wait || busy} onPress={send} />
              <T v="xs" style={{ textAlign: 'center' }}>Changing your password signs you out on every device.</T>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
