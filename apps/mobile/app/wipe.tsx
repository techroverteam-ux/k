/** Profile → Wipe out account: a fresh start. Confirmed with an SMS code or the password. */
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { gql } from '@/api';
import { useAuth } from '@/auth';
import { inr, S } from '@/theme';
import { Button, ErrorState, Field, Lines, Notice, Screen, Skeleton, T, tap, toast, useQuery } from '@/ui';

interface Preview { balance: string; resetTo: string; openPositions: number; openOrders: number; runningStrategies: number; pendingRequests: number; method: string }
const LABEL: Record<string, string> = { SMS: '6-digit code sent to your mobile', PASSWORD: 'Your password' };

export default function Wipe() {
  const { reload } = useAuth();
  const pv = useQuery<{ wipePreview: Preview }>(`{ wipePreview { balance resetTo openPositions openOrders runningStrategies pendingRequests method } }`);
  const [ch, setCh] = useState<{ method: string; sentTo?: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = pv.data?.wipePreview;

  const begin = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ beginAccountWipe: { method: string; sentTo?: string; devCode?: string } }>(`mutation { beginAccountWipe { method sentTo devCode } }`);
      setCh(d.beginAccountWipe); setCode('');
      if (d.beginAccountWipe.devCode) toast(`Development code: ${d.beginAccountWipe.devCode}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const wipe = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ wipeMyAccount: { balance: string } }>(`mutation($c:String!,$w:String!){ wipeMyAccount(code:$c, confirm:$w){ balance } }`, { c: code, w: typed });
      tap('heavy');
      toast(`Account wiped out. Balance ₹${inr(d.wipeMyAccount.balance)}`);
      await reload();
      router.replace('/');
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Screen back title="Wipe out account">
      {pv.error && !p ? <ErrorState error={pv.error} retry={pv.refetch} /> : !p ? <Skeleton /> : !ch ? (
        <>
          <T c="text2">Start fresh. Your orders, trades, ledger, statements, strategies, watchlist and notifications are cleared from your view. A Super Admin can still see everything.</T>
          <Lines lines={[
            ['Balance now', `₹${inr(p.balance)}`],
            ['Balance after', `₹${inr(p.resetTo)}`],
            ...(p.openOrders ? [['Pending orders', `${p.openOrders} will be cancelled`] as [string, string]] : []),
            ...(p.runningStrategies ? [['Running strategies', `${p.runningStrategies} will be stopped`] as [string, string]] : []),
            ...(p.pendingRequests ? [['Fund requests', `${p.pendingRequests} will be cancelled`] as [string, string]] : []),
          ]} />
          {p.openPositions > 0 && <Notice tone="err">You have {p.openPositions} open position{p.openPositions > 1 ? 's' : ''}. Exit {p.openPositions > 1 ? 'them' : 'it'} first.</Notice>}
          {err && <Notice tone="err">{err}</Notice>}
          <Button kind="sell" size="lg" title="Continue" busy={busy} disabled={p.openPositions > 0} onPress={begin} />
          {p.openPositions > 0 && <Button title="Go to positions" onPress={() => router.push('/(trader)/positions')} />}
        </>
      ) : (
        <>
          <Field label="Type WIPE to confirm" autoCapitalize="characters" autoCorrect={false} value={typed} onChangeText={setTyped} />
          {err && <Notice tone="err">{err}</Notice>}
          <Button kind="sell" size="lg" title="Wipe out" busy={busy} disabled={ typed.trim().toUpperCase() !== 'WIPE'} onPress={wipe} />
          {ch.method === 'SMS' && <Button kind="ghost" title="Send a new code" disabled={busy} onPress={begin} />}
          <View style={{ height: S[4] }} />
        </>
      )}
    </Screen>
  );
}
