import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Icon } from '@/icons';
import { BellButton, LedgerList, RequestsList, SearchButton, StatementBlock, SummaryBlock } from '@/screens';
import { View } from 'react-native';
import { inr, toneOfValue, useTheme } from '@/theme';
import { Chips, DateField, ErrorState, IconMark, ListRow, Metrics, Row, Screen, Section, T, Tabs, useQuery } from '@/ui';

/** Trade: balance, add/withdraw, P&L by period and transaction history. */
export default function Funds() {
  const t = useTheme();
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
    <Screen title="Trade" right={<><SearchButton /><BellButton /></>}>
      <SummaryBlock actions title="Available balance" />
      <ListRow onPress={() => router.push('/fees')} label="Pay fees" left={<IconMark icon="wallet" tone="brand" />} title="Pay fees" sub="Course & subscription fees by bank transfer or UPI" right={<Icon name="chevronRight" size={18} color={t.text3} />} />
      <Section title="Profit & loss" action={<Chips value={p} onChange={setP} items={[{ k: 'd', label: 'Today' }, { k: 'w', label: 'Week' }, { k: 'm', label: 'Month' }, { k: 'c', label: 'Custom' }]} />}>
        {p === 'c' && (
          <View style={{ gap: 4 }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <DateField label="From" value={cf} max={ct} onChange={setCf} />
              <DateField label="To" value={ct} min={cf} max={ymd(new Date())} onChange={setCt} />
            </Row>
            {badRange && <T v="xs" c="neg">Pick a start date on or before the end date.</T>}
          </View>
        )}
        {s.error && !d ? <ErrorState error={s.error} retry={s.refetch} /> : (
          <Metrics items={[
            { k: 'Realised P&L', v: d ? inr(d.realizedPnl, true) : '…', tone: toneOfValue(d?.realizedPnl) },
            { k: 'Trades', v: d?.trades ?? '…' },
            { k: 'Turnover', v: d ? `₹${inr(d.volume)}` : '…' },
          ]} />
        )}
      </Section>
      <StatementBlock />
      <Tabs value={tab} onChange={setTab} items={[{ k: 'tx', label: 'Transactions' }, { k: 'req', label: 'Fund requests' }]} />
      {tab === 'tx' ? <LedgerList /> : <RequestsList canCancel />}
    </Screen>
  );
}
