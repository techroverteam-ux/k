import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gql } from '@/api';
import { DEVICE_NAME, homeFor, useAuth } from '@/auth';
import { S, useTheme } from '@/theme';
import { Button, Field, IconButton, Notice, T, toast } from '@/ui';

export default function Demo() {
  const t = useTheme();
  const { signIn } = useAuth();
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<{ sentTo: string; devCode?: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (wait > 0) { const h = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(h); } }, [wait]);
  const send = async () => {
    setBusy(true); setErr(null);
    try { const d = await gql(`mutation($p:String!){ requestDemoOtp(phone:$p){ sentTo resendAfterSec devCode } }`, { p: phone }); setSent(d.requestDemoOtp); setWait(d.requestDemoOtp.resendAfterSec); setCode(''); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql(`mutation($p:String!,$c:String!,$d:String){ verifyDemoOtp(phone:$p, code:$c, deviceName:$d){ accessToken refreshToken } }`, { p: phone, c: code, d: DEVICE_NAME });
      const me = await signIn(d.verifyDemoOtp.accessToken, d.verifyDemoOtp.refreshToken);
      if (me) { toast('Signed in. Welcome to your demo account!'); router.replace(homeFor(me.role)); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ paddingHorizontal: S[2], height: 56, justifyContent: 'center' }}><IconButton icon="chevronLeft" label="Back" onPress={() => (sent ? setSent(null) : router.back())} /></View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: S[6], paddingTop: S[2], gap: S[5] }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: S[2] }}>
            <T v="h1">{sent ? 'Verify your number' : 'Get a demo account'}</T>
            <T c="text2">{sent ? `Enter the 6-digit code sent to ${sent.sentTo}.` : 'Enter your mobile number. We’ll text you a one-time code.'}</T>
          </View>
          {!sent ? (
            <>
              <Field label="Mobile number" prefix="+91" keyboardType="phone-pad" maxLength={10} value={phone} onChangeText={(v) => setPhone(v.replace(/\D/g, ''))} textContentType="telephoneNumber" autoFocus />
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Send code" busy={busy} disabled={phone.length !== 10} onPress={send} />
            </>
          ) : (
            <>
              <Field label="6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} autoFocus />
              {sent.devCode ? <Notice>Development mode code: {sent.devCode}. Never shown in production.</Notice> : null}
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Verify and continue" busy={busy} disabled={code.length !== 6} onPress={verify} />
              <Button kind="ghost" title={wait ? `Resend code in ${wait}s` : 'Resend code'} disabled={!!wait || busy} onPress={send} />
            </>
          )}
          <T v="xs" style={{ textAlign: 'center' }}>Demo accounts use virtual money for practice only.</T>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
