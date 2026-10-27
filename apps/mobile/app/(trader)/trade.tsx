import { useMemo, useState } from 'react';
import { BellButton, LedgerList, RequestsList, StatementBlock, SummaryBlock } from '@/screens';
import { View } from 'react-native';
import { inr, toneOfValue } from '@/theme';
import { Chips, ErrorState, Field, Metrics, Row, Screen, Section, T, Tabs, useQuery } from '@/ui';

/** Funds: balance, add/withdraw, P&L by period, transaction history. */
export default function Funds() {
  const [p, setP] = useState<'d' | 'w' | 'm' | 'c'>('d');
  const [tab, setTab] = useState<'tx' | 'req'>('tx');
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [cf, setCf] = useState(ymd(new Date(Date.now() - 6 * 86_400_000)));
  const [ct, setCt] = useState(ymd(new Date()));
  const okDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());
  const badRange = p === 'c' && (!okDate(cf) || !okDate(ct) || cf > ct);
  const r = useMemo(() => {
    if (p === 'c' && !badRange) return { f: new Date(`${cf}T00:00:00`).toISOString(), t: new Date(new Date(`${ct}T00:00:00`).getTime() + 86_400_000).toISOString() };
    const from = new Date(); from.setHours(0, 0, 0, 0);
    if (p === 'w') from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    if (p === 'm') from.setDate(1);
    return { f: from.toISOString(), t: new Date(Date.now() + 60_000).toISOString() };
  }, [p, cf, ct, badRange]);
  const s = useQuery<{ periodSummary: { realizedPnl: string; brokerage: string; trades: number; volume: string } }>(`query($f:DateTime!,$t:DateTime!){ periodSummary(from:$f,to:$t){ realizedPnl brokerage trades volume } }`, r);
  const d = s.data?.periodSummary;
  return (
    <Screen title="Funds" right={<BellButton />} onRefresh={s.refetch}>
      <SummaryBlock actions title="Available balance" />
      <Section title="Profit & loss" action={<Chips value={p} onChange={setP} items={[{ k: 'd', label: 'Today' }, { k: 'w', label: 'Week' }, { k: 'm', label: 'Month' }, { k: 'c', label: 'Custom' }]} />}>
        {p === 'c' && (
          <View style={{ gap: 4 }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}><Field label="From (YYYY-MM-DD)" value={cf} onChangeText={setCf} maxLength={10} keyboardType="numbers-and-punctuation" /></View>
              <View style={{ flex: 1 }}><Field label="To (YYYY-MM-DD)" value={ct} onChangeText={setCt} maxLength={10} keyboardType="numbers-and-punctuation" /></View>
            </Row>
            {badRange && <T v="xs" c="neg">Enter dates as YYYY-MM-DD, with the start on or before the end.</T>}
          </View>
        )}
        {s.error && !d ? <ErrorState error={s.error} retry={s.refetch} /> : (
          <Metrics items={[
            { k: 'Realised P&L', v: d ? inr(d.realizedPnl, true) : '…', tone: toneOfValue(d?.realizedPnl) },
            { k: 'Brokerage', v: d ? `₹${inr(d.brokerage)}` : '…' },
            { k: 'Trades', v: d?.trades ?? '…' },
            { k: 'Turnover', v: d ? `₹${inr(d.volume)}` : '…' },
          ]} />
        )}
      </Section>
      <StatementBlock />
      <Tabs value={tab} onChange={setTab} items={[{ k: 'tx', label: 'Transactions' }, { k: 'req', label: 'Fund requests' }]} />
      {tab === 'tx' ? <LedgerList /> : <RequestsList />}
    </Screen>
  );
}
