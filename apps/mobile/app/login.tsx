import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gql, takeSignedOutReason } from '@/api';
import { AUTH_FIELDS, ConflictPrompt, type AuthPayload } from '@/conflict';
import { DEVICE_NAME, homeFor, useAuth } from '@/auth';
import { Logo } from '@/icons';
import { S, useTheme } from '@/theme';
import { Button, Divider, Field, Notice, Row, T, toast } from '@/ui';

export default function Login() {
  const t = useTheme();
  const { signIn, settings } = useAuth();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [show, setShow] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<AuthPayload | null>(null);
  const [signedOut, setSignedOut] = useState<string | null>(null);
  useEffect(() => { const m = takeSignedOutReason(); if (m) setSignedOut(m); }, []);

  const finish = async (a: string, r: string) => {
    const me = await signIn(a, r);
    if (me) { toast(`Signed in. Welcome, ${me.displayName.split(' ')[0]}!`); router.replace(homeFor(me.role)); }
  };
  const done = async (p: AuthPayload) => {
    if (p.sessionConflict) { setConflict(p); return; }
    if (p.accessToken) await finish(p.accessToken, p.refreshToken!);
  };
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (mfaToken) {
        const d = await gql(`mutation($t:String!,$c:String!,$d:String){ completeMfaLogin(mfaToken:$t, code:$c, deviceName:$d){ ${AUTH_FIELDS} } }`, { t: mfaToken, c: code, d: DEVICE_NAME });
        await done(d.completeMfaLogin);
      } else {
        const d = await gql(`mutation($u:String!,$p:String!,$d:String){ login(username:$u, password:$p, deviceName:$d){ mfaRequired mfaToken ${AUTH_FIELDS} } }`, { u: u.trim(), p, d: DEVICE_NAME });
        if (d.login.mfaRequired) { setMfaToken(d.login.mfaToken); setCode(''); } else await done(d.login);
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: S[6], gap: S[5], justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
          {signedOut && !conflict && <Notice tone="warn">{signedOut}</Notice>}
          <View style={{ gap: S[4], marginBottom: S[4], display: conflict ? 'none' : 'flex' }}>
            <Row style={{ justifyContent: 'space-between' }}><Logo size={44} brand={t.brand} /></Row>
            <T v="h1">{mfaToken ? 'Two-step verification' : 'Welcome back'}</T>
            <T c="text2">{mfaToken ? 'Enter the 6-digit code from your authenticator app.' : `Sign in to ${settings?.appName ?? 'The K'} with the username your broker or administrator gave you.`}</T>
          </View>
          {conflict ? (
            <ConflictPrompt p={conflict} onDone={finish} onCancel={() => { setConflict(null); setMfaToken(null); setP(''); }} />
          ) : mfaToken ? (
            <>
              <Field label="6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} autoFocus />
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Verify and sign in" busy={busy} disabled={code.length !== 6} onPress={go} />
              <Button kind="ghost" title="Back" onPress={() => setMfaToken(null)} />
            </>
          ) : (
            <>
              <Field label="Username" autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" value={u} onChangeText={setU} maxLength={40} returnKeyType="next" />
              <View>
                <Field label="Password" secureTextEntry={!show} textContentType="password" autoComplete="password" value={p} onChangeText={setP} maxLength={128} returnKeyType="go" onSubmitEditing={() => u && p && void go()} />
                <Pressable onPress={() => setShow((s) => !s)} accessibilityRole="button" style={{ position: 'absolute', right: S[3], top: 34, height: 40, justifyContent: 'center' }} hitSlop={8}>
                  <T v="sm" c="brand" w="600">{show ? 'Hide' : 'Show'}</T>
                </Pressable>
              </View>
              {err && <Notice tone="err">{err}</Notice>}
              <Button kind="primary" size="lg" title="Sign in" busy={busy} disabled={!u || !p} onPress={go} />
              <View style={{ alignItems: 'flex-end', marginTop: -S[2] }}><Button kind="ghost" size="sm" title="Forgot password?" onPress={() => router.push('/forgot')} /></View>
              <Row><View style={{ flex: 1 }}><Divider /></View><T v="xs">or</T><View style={{ flex: 1 }}><Divider /></View></Row>
              <Row gap={S[3]}>
                {settings?.demoEnabled !== false && <Button block size="lg" title="Try a demo" onPress={() => router.push('/demo')} />}
                {settings?.signupEnabled !== false && <Button block size="lg" title="Create account" onPress={() => router.push('/signup')} />}
              </Row>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
