/** Concurrent-login prompt: the account is already signed in elsewhere; offer to sign that device out and continue. */
import { useState } from 'react';
import { View } from 'react-native';
import { gql } from './api';
import { DEVICE_NAME } from './auth';
import { deviceLabel, stamp } from './activity';
import { S } from './theme';
import { Button, IconMark, ListRow, Notice, T } from './ui';

export const AUTH_FIELDS = 'accessToken refreshToken sessionConflict conflictToken conflictLimit activeSessions { id deviceName userAgent ip lastUsedAt }';
export interface AuthPayload { accessToken?: string; refreshToken?: string; sessionConflict?: boolean; conflictToken?: string; conflictLimit?: number; activeSessions?: { id: string; deviceName?: string; userAgent?: string; ip?: string; lastUsedAt: string }[] }

export function ConflictPrompt({ p, onDone, onCancel }: { p: AuthPayload; onDone: (a: string, r: string) => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = p.activeSessions?.length ?? 0;
  return (
    <View style={{ gap: S[4] }}>
      <T v="h1">Already signed in</T>
      <T c="text2">{(p.conflictLimit ?? 1) > 1 ? `Your account can be signed in on ${p.conflictLimit} devices at once, and it already is.` : 'Your account is signed in on another device. You can sign that device out and continue here.'}</T>
      <View>
        {p.activeSessions?.map((x) => (
          <ListRow key={x.id} left={<IconMark icon="device" />} title={x.deviceName || deviceLabel(x.userAgent)} sub={`IP ${x.ip ?? '—'} · last active ${stamp(x.lastUsedAt)}`} />
        ))}
      </View>
      <Notice tone="warn">Continuing here signs {n === 1 ? 'that device' : 'those devices'} out straight away. If you don’t recognise {n === 1 ? 'it' : 'them'}, continue and then change your password.</Notice>
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Sign out other device & continue" busy={busy} onPress={async () => {
        setBusy(true); setErr(null);
        try {
          const d = await gql<{ forceLogin: AuthPayload }>(`mutation($t:String!,$d:String){ forceLogin(conflictToken:$t, deviceName:$d){ ${AUTH_FIELDS} } }`, { t: p.conflictToken, d: DEVICE_NAME });
          if (d.forceLogin.accessToken) await onDone(d.forceLogin.accessToken, d.forceLogin.refreshToken!);
        } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />
      <Button size="lg" title="Cancel" onPress={onCancel} />
    </View>
  );
}
