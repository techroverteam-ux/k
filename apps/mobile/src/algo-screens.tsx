/**
 * Automated trading (paper) on mobile: strategy list with Stop all, create/edit from a template, and a detail
 * screen with the backtest report, start/stop and the live event log. Conditions themselves are edited on the
 * web (the rule builder needs more room); everything else works here.
 */
import { router } from 'expo-router';
import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { gql } from './api';
import {
  describe, INTERVALS, PERIODS, REASON, RUN_FIELDS, rupees, STRATEGY_FIELDS, TEMPLATES,
  type Interval, type Metrics as BtMetrics, type Rules, type Run, type Strategy, type Trade,
} from './algo';
import { Icon } from './icons';
import { BellButton, useLiveQuotes } from './screens';
import { inr, R, S, shortSymbol, useTheme } from './theme';
import {
  Badge, Button, Chips, Divider, Empty, ErrorState, Field, IconMark, Lines, ListRow, Mark, Metrics, Notice, Row, Screen, SearchBox, Section,
  Sheet, Skeleton, Spread, T, Tabs, tap, toast, useQuery, VList,
} from './ui';

interface Inst { id: string; symbol: string; name: string; exchange: string; segment: string }
const LIST_Q = `{ strategies { ${STRATEGY_FIELDS} } }`;

function StatusPill({ s }: { s: Strategy }) {
  if (s.status === 'RUNNING') return <Badge text="● Running" tone="ok" />;
  if (s.status === 'STOPPED') return <Badge text="Stopped" />;
  return <Badge text="Draft" tone="info" />;
}
const tonePnl = (v?: string) => (!v || v === '0.00' ? 'text2' : v.startsWith('-') ? 'neg' : 'pos') as 'text2' | 'neg' | 'pos';

/* ============================================================== list */
const StrategyRow = memo(function StrategyRow({ s }: { s: Strategy }) {
  const pnl = s.today?.pnl ?? '0.00';
  return (
    <ListRow onPress={() => router.push(`/algo/${s.id}`)} label={`${s.name}, ${s.status.toLowerCase()}`}
      left={<Mark text={s.instrument ? shortSymbol(s.instrument.symbol) : '?'} />}
      title={<Row gap={6}><T w="600" numberOfLines={1} style={{ flexShrink: 1 }}>{s.name}</T><StatusPill s={s} /></Row>}
      sub={`${s.instrument ? shortSymbol(s.instrument.symbol) : '—'} · ${INTERVALS.find((i) => i.v === s.interval)?.label} · ${s.position === 0 ? 'flat' : `position ${s.position > 0 ? '+' : ''}${s.position}`} · ${s.today?.orders ?? 0}/${s.maxOrdersPerDay} orders today`}
      right={<View style={{ alignItems: 'flex-end' }}><T v="num" c={tonePnl(pnl)}>₹{inr(pnl)}</T><T v="xs">today</T></View>} />
  );
});

export function AlgoListScreen() {
  const q = useQuery<{ strategies: Strategy[] }>(LIST_Q, undefined, 5000);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = q.data?.strategies ?? [];
  const running = list.filter((s) => s.status === 'RUNNING');
  const header = (
    <>
      <T v="sm" c="text2">Rules that trade for you, with the same checks as your own orders.</T>
      <Row>
        <Button block kind="primary" icon="plus" title="New strategy" onPress={() => router.push('/algo/new')} />
        {running.length > 0 && <Button block kind="sell" icon="alert" title={`Stop all (${running.length})`} onPress={() => setAsk(true)} />}
      </Row>
      {list.length > 0 && <T v="h3">Your strategies</T>}
    </>
  );
  const empty = q.loading && !q.data ? <Skeleton /> : q.error && !q.data ? <ErrorState error={q.error} retry={q.refetch} /> : (
    <View style={{ gap: S[3] }}>
      <T v="h3">Start from a template</T>
      {TEMPLATES.map((t) => (
        <Pressable key={t.key} onPress={() => router.push(`/algo/new?t=${t.key}`)} accessibilityRole="button" accessibilityLabel={`Use template ${t.name}`}>
          {({ pressed }) => <TemplateCard name={t.name} blurb={t.blurb} rules={t.rules} pressed={pressed} />}
        </Pressable>
      ))}
    </View>
  );
  return (
    <Screen back title="Algo trading" scroll={false} right={<BellButton />}>
      <VList data={list} keyOf={(s) => s.id} header={header} empty={empty} render={(s) => <StrategyRow s={s} />}
        footer={list.length ? <T v="xs" style={{ textAlign: 'center', marginTop: S[4] }}>Past results don’t predict future ones.</T> : null} />
      <Sheet visible={ask} title="Stop all strategies?" sub="Kill switch" onClose={() => setAsk(false)}>
        <Notice tone="warn">{`All ${running.length} running ${running.length === 1 ? 'strategy stops' : 'strategies stop'} now, and any position they hold is closed with a market order.`}</Notice>
        <Row>
          <Button block title="Cancel" onPress={() => setAsk(false)} />
          <Button block kind="sell" title="Stop all" busy={busy} onPress={async () => {
            setBusy(true);
            try { const d = await gql<{ stopAllStrategies: number }>(`mutation{ stopAllStrategies }`); toast(`Stopped ${d.stopAllStrategies} and closed their positions`); } catch (e) { toast((e as Error).message, true); }
            setBusy(false); setAsk(false); void q.refetch();
          }} />
        </Row>
      </Sheet>
    </Screen>
  );
}

function TemplateCard({ name, blurb, rules, pressed }: { name: string; blurb: string; rules: Rules; pressed?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ padding: S[4], gap: 6, borderWidth: 1, borderColor: pressed ? t.brand : t.line, borderRadius: R.lg, backgroundColor: pressed ? t.bg2 : t.bg }}>
      <Spread><T w="600">{name}</T><Icon name="chevronRight" size={18} color={t.text3} /></Spread>
      <T v="sm" c="text2">{blurb}</T>
      <T v="xs">{describe(rules, 1, 'NIFTY')}</T>
    </View>
  );
}

/** Small entry card for Home. */
export function AlgoCard() {
  const t = useTheme();
  const q = useQuery<{ strategies: { id: string; status: string; today?: { pnl: string } }[] }>(`{ strategies { id status today { pnl } } }`, undefined, 15000);
  const list = q.data?.strategies ?? [];
  const running = list.filter((s) => s.status === 'RUNNING');
  const pnl = running.reduce((a, s) => a + Number(s.today?.pnl ?? 0), 0).toFixed(2);
  return (
    <Pressable onPress={() => router.push('/algo')} accessibilityRole="button" accessibilityLabel="Algo trading"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: S[3], padding: S[4], borderWidth: 1, borderColor: t.line, borderRadius: R.lg, backgroundColor: pressed ? t.bg2 : t.bg })}>
      <IconMark icon="activity" tone="brand" />
      <View style={{ flex: 1 }}>
        <T w="600">Algo trading</T>
        <T v="xs">{running.length ? `${running.length} running · today ₹${inr(pnl)}` : list.length ? `${list.length} saved · none running` : 'Build, backtest and run rules'}</T>
      </View>
      <Icon name="chevronRight" size={18} color={t.text3} />
    </Pressable>
  );
}

/* ============================================================== create / edit */
export function AlgoEditScreen({ id, templateKey, instrumentId }: { id?: string; templateKey?: string; instrumentId?: string }) {
  const tpl = TEMPLATES.find((x) => x.key === templateKey) ?? TEMPLATES[0];
  const existing = useQuery<{ strategy: Strategy }>(`query($id:ID!){ strategy(id:$id){ ${STRATEGY_FIELDS} } }`, { id: id ?? '' }, undefined, !id);
  const [ready, setReady] = useState(!id);
  const [key, setKey] = useState(tpl.key);
  const [name, setName] = useState(tpl.name);
  const [inst, setInst] = useState<Inst | null>(null);
  const [interval, setIv] = useState<Interval>(tpl.interval);
  const [rules, setRules] = useState<Rules>(structuredClone(tpl.rules));
  const [qty, setQty] = useState('1');
  const [sl, setSl] = useState(tpl.rules.stopLossPct !== undefined ? String(tpl.rules.stopLossPct) : '');
  const [tp, setTp] = useState(tpl.rules.takeProfitPct !== undefined ? String(tpl.rules.takeProfitPct) : '');
  const [loss, setLoss] = useState('2000');
  const [maxOrders, setMaxOrders] = useState('20');
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!instrumentId || id) return;
    gql<{ instrument: Inst }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment } }`, { id: instrumentId }).then((d) => setInst(d.instrument)).catch(() => undefined);
  }, [instrumentId, id]);
  useEffect(() => {
    const s = existing.data?.strategy;
    if (!id || !s || ready) return;
    const r = JSON.parse(s.rules) as Rules;
    setName(s.name); setIv(s.interval); setRules(r); setQty(String(s.quantity));
    setSl(r.stopLossPct !== undefined ? String(r.stopLossPct) : ''); setTp(r.takeProfitPct !== undefined ? String(r.takeProfitPct) : '');
    setLoss(s.maxDailyLoss.replace(/\.00$/, '')); setMaxOrders(String(s.maxOrdersPerDay));
    if (s.instrument) setInst(s.instrument);
    setReady(true);
  }, [existing.data, id, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const useTemplate = (k: string) => {
    const t = TEMPLATES.find((x) => x.key === k)!;
    setKey(k); setName(t.name); setIv(t.interval); setRules(structuredClone(t.rules));
    setSl(t.rules.stopLossPct !== undefined ? String(t.rules.stopLossPct) : ''); setTp(t.rules.takeProfitPct !== undefined ? String(t.rules.takeProfitPct) : '');
  };
  const pct = (v: string) => { const n = Number(v); return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : n; };
  const finalRules: Rules = { ...rules, stopLossPct: pct(sl), takeProfitPct: pct(tp) };
  const save = async () => {
    setErr(null);
    if (!inst) { setErr('Pick an instrument.'); return; }
    setBusy(true);
    try {
      const d = await gql<{ saveStrategy: Strategy }>(`mutation($i:SaveStrategyInput!){ saveStrategy(input:$i){ id } }`, {
        i: { id, name: name.trim() || tpl.name, instrumentId: inst.id, interval, rules: JSON.stringify(finalRules), quantity: Number(qty) || 0, maxDailyLoss: loss || '0', maxOrdersPerDay: Number(maxOrders) || 0 },
      });
      tap();
      toast(id ? 'Saved as a new version' : 'Strategy saved');
      if (id) router.back(); else router.replace(`/algo/${d.saveStrategy.id}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (id && !ready) return <Screen back title="Edit strategy">{existing.error ? <ErrorState error={existing.error} retry={existing.refetch} /> : <Skeleton />}</Screen>;
  const running = existing.data?.strategy.status === 'RUNNING';
  return (
    <Screen back title={id ? 'Edit strategy' : 'New strategy'}>
      {running && <Notice tone="warn">Stop the strategy before editing it.</Notice>}
      {!id && (
        <Section title="Template">
          <Chips value={key} onChange={useTemplate} items={TEMPLATES.map((t) => ({ k: t.key, label: t.name }))} />
          <T v="xs">{TEMPLATES.find((t) => t.key === key)?.blurb}</T>
        </Section>
      )}
      <Field label="Name" value={name} maxLength={80} onChangeText={setName} />
      <View style={{ gap: 6 }}>
        <T v="sm" c="text2" w="500">Instrument</T>
        <Pressable onPress={() => setPick(true)} accessibilityRole="button" accessibilityLabel={inst ? `Instrument ${shortSymbol(inst.symbol)}. Change` : 'Pick an instrument'}>
          {({ pressed }) => <InstrumentBox inst={inst} pressed={pressed} />}
        </Pressable>
      </View>
      <View style={{ gap: 6 }}><T v="sm" c="text2" w="500">Timeframe (candle size the rules look at)</T><Chips value={interval} onChange={setIv} items={INTERVALS.map((i) => ({ k: i.v, label: i.label }))} /></View>
      <View style={{ gap: 6 }}>
        <T v="sm" c="text2" w="500">Direction</T>
        <Chips value={rules.side} onChange={(side) => setRules({ ...rules, side })} items={[{ k: 'LONG', label: 'Buy first (long)' }, { k: 'SHORT', label: 'Sell first (short)' }]} />
      </View>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}><Field label="Stop-loss %" keyboardType="decimal-pad" placeholder="Off" value={sl} onChangeText={(v) => setSl(v.replace(/[^\d.]/g, '').slice(0, 5))} /></View>
        <View style={{ flex: 1 }}><Field label="Take-profit %" keyboardType="decimal-pad" placeholder="Off" value={tp} onChangeText={(v) => setTp(v.replace(/[^\d.]/g, '').slice(0, 5))} /></View>
      </Row>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}><Field label="Quantity per trade" keyboardType="number-pad" value={qty} onChangeText={(v) => setQty(v.replace(/\D/g, '').slice(0, 6))} /></View>
        <View style={{ flex: 1 }}><Field label="Max orders / day" keyboardType="number-pad" value={maxOrders} onChangeText={(v) => setMaxOrders(v.replace(/\D/g, '').slice(0, 3))} /></View>
      </Row>
      <Field label="Stop for the day after losing" prefix="₹" keyboardType="decimal-pad" value={loss} onChangeText={(v) => setLoss(v.replace(/[^\d.]/g, '').slice(0, 12))} />
      <Notice>{describe(finalRules, Number(qty) || 0, inst ? shortSymbol(inst.symbol) : 'the instrument')}</Notice>
      <T v="xs">Entry and exit conditions come from the template. To change them, edit the strategy on the web.</T>
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title={id ? 'Save changes' : 'Save strategy'} busy={busy} disabled={running} onPress={save} />
      <InstrumentPicker visible={pick} onClose={() => setPick(false)} onPick={(i) => { setInst(i); setPick(false); }} />
    </Screen>
  );
}

function InstrumentBox({ inst, pressed }: { inst: Inst | null; pressed: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[3], minHeight: 52, padding: S[3], borderWidth: 1, borderColor: t.line2, borderRadius: R.md, backgroundColor: pressed ? t.bg2 : t.bg }}>
      {inst ? <Mark text={shortSymbol(inst.symbol)} /> : <Icon name="search" size={18} color={t.text3} />}
      <View style={{ flex: 1 }}>{inst ? <><T w="600">{shortSymbol(inst.symbol)}</T><T v="xs">{inst.name}</T></> : <T c="text3">Search, e.g. NIFTY</T>}</View>
      <Icon name="chevronRight" size={18} color={t.text3} />
    </View>
  );
}

function InstrumentPicker({ visible, onPick, onClose }: { visible: boolean; onPick: (i: Inst) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Inst[] | null>(null);
  useEffect(() => {
    if (!visible) return;
    const h = setTimeout(() => gql<{ searchInstruments: Inst[] }>(`query($q:String!){ searchInstruments(query:$q, limit:20){ id symbol name exchange segment } }`, { q: q.trim() }).then((d) => setRes(d.searchInstruments)).catch(() => setRes([])), q ? 180 : 0);
    return () => clearTimeout(h);
  }, [q, visible]);
  return (
    <Sheet visible={visible} title="Pick an instrument" onClose={onClose}>
      <SearchBox value={q} onChangeText={setQ} placeholder="Symbol or company" />
      {res === null ? <Skeleton rows={3} /> : !res.length ? <Empty icon="search" title={`No match for “${q}”`} /> : res.map((i) => (
        <ListRow key={i.id} onPress={() => { tap('select'); onPick(i); }} left={<Mark text={shortSymbol(i.symbol)} />} title={shortSymbol(i.symbol)} sub={i.name} right={<Badge text={i.exchange} />} />
      ))}
    </Sheet>
  );
}

/* ============================================================== detail */
export function AlgoDetailScreen({ id }: { id: string }) {
  const q = useQuery<{ strategy: Strategy }>(`query($id:ID!){ strategy(id:$id){ ${STRATEGY_FIELDS} } }`, { id }, 5000);
  const [tab, setTab] = useState<'bt' | 'live'>('bt');
  const s = q.data?.strategy;
  useEffect(() => { if (s && s.status === 'RUNNING') setTab('live'); }, [s?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Screen back title="Strategy">{q.error ? <ErrorState error={q.error} retry={q.refetch} /> : <Skeleton rows={6} />}</Screen>;
  const rules = JSON.parse(s.rules) as Rules;
  const symbol = s.instrument ? shortSymbol(s.instrument.symbol) : '';
  return (
    <Screen back title={s.name} right={s.status !== 'RUNNING' ? <Button size="sm" kind="ghost" title="Edit" onPress={() => router.push(`/algo/edit/${s.id}`)} /> : undefined}>
      <Row gap={S[2]} style={{ flexWrap: 'wrap' }}><StatusPill s={s} /><T v="xs">v{s.version} · {symbol} · {INTERVALS.find((i) => i.v === s.interval)?.label}</T></Row>
      {s.status === 'STOPPED' && s.stopReason ? <Notice tone="warn">{s.stopReason}</Notice> : null}
      <Notice>{describe(rules, s.quantity, symbol)}</Notice>
      <Controls s={s} onChange={() => void q.refetch()} />
      <Tabs value={tab} onChange={setTab} items={[{ k: 'bt', label: 'Backtest' }, { k: 'live', label: 'Live' }]} />
      {tab === 'bt' ? <Backtest s={s} /> : <Live s={s} />}
    </Screen>
  );
}

function Controls({ s, onChange }: { s: Strategy; onChange: () => void }) {
  const [ask, setAsk] = useState<'start' | 'stop' | 'delete' | null>(null);
  const [flatten, setFlatten] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rules = JSON.parse(s.rules) as Rules;
  const act = async () => {
    setBusy(true); setErr(null);
    try {
      if (ask === 'start') { await gql(`mutation($id:ID!){ startStrategy(id:$id){ id } }`, { id: s.id }); toast('Started. It acts when the next candle closes.'); }
      if (ask === 'stop') { await gql(`mutation($id:ID!,$f:Boolean){ stopStrategy(id:$id, flatten:$f){ id } }`, { id: s.id, f: flatten }); toast('Strategy stopped'); }
      if (ask === 'delete') { await gql(`mutation($id:ID!){ deleteStrategy(id:$id) }`, { id: s.id }); toast('Strategy deleted'); router.back(); }
      setAsk(null); onChange();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      {s.status === 'RUNNING'
        ? <Button kind="sell" size="lg" title="Stop strategy" onPress={() => { setErr(null); setAsk('stop'); }} />
        : <Row><Button block kind="buy" size="lg" icon="activity" title="Start" onPress={() => { setErr(null); setAsk('start'); }} /><Button title="Delete" kind="danger" size="lg" onPress={() => { setErr(null); setAsk('delete'); }} /></Row>}
      <Sheet visible={ask === 'start'} title={`Start “${s.name}”?`} sub="Automated trading rule" onClose={() => setAsk(null)}>
        <Lines lines={[
          ['Each trade', `${rules.side === 'LONG' ? 'Buy' : 'Sell'} ${s.quantity} at market`], ['Stop-loss / take-profit', `${rules.stopLossPct ?? '—'}% / ${rules.takeProfitPct ?? '—'}%`],
          ['Stops for the day after losing', `₹${inr(s.maxDailyLoss)}`], ['Max orders per day', s.maxOrdersPerDay],
        ]} />
        <Notice tone="warn">Orders will be executed automatically with the same checks as your own orders.</Notice>
        {err && <Notice tone="err">{err}</Notice>}
        <Row><Button block title="Cancel" onPress={() => setAsk(null)} /><Button block kind="buy" title="Start strategy" busy={busy} onPress={act} /></Row>
      </Sheet>
      <Sheet visible={ask === 'stop'} title={`Stop “${s.name}”?`} sub="It stops acting immediately" onClose={() => setAsk(null)}>
        <Lines lines={[['Open position', s.position === 0 ? 'None' : `${s.position > 0 ? '+' : ''}${s.position}`], ['P&L today', `₹${inr(s.today?.pnl ?? '0.00')}`]]} />
        {s.position !== 0 && <Chips value={flatten ? 'y' : 'n'} onChange={(v) => setFlatten(v === 'y')} items={[{ k: 'y', label: 'Close the position at market' }, { k: 'n', label: 'Keep it open' }]} />}
        {err && <Notice tone="err">{err}</Notice>}
        <Row><Button block title="Cancel" onPress={() => setAsk(null)} /><Button block kind="sell" title="Stop" busy={busy} onPress={act} /></Row>
      </Sheet>
      <Sheet visible={ask === 'delete'} title={`Delete “${s.name}”?`} sub="Its backtests and event log are deleted. Orders it placed stay in your history." onClose={() => setAsk(null)}>
        {err && <Notice tone="err">{err}</Notice>}
        <Row><Button block title="Keep" onPress={() => setAsk(null)} /><Button block kind="sell" title="Delete" busy={busy} onPress={act} /></Row>
      </Sheet>
    </>
  );
}

function Backtest({ s }: { s: Strategy }) {
  const periods = PERIODS[s.interval];
  const [days, setDays] = useState(String(periods[periods.length - 1].days));
  const runs = useQuery<{ strategyRuns: Run[] }>(`query($id:ID!){ strategyRuns(strategyId:$id, limit:5){ ${RUN_FIELDS} } }`, { id: s.id });
  const [fresh, setFresh] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = fresh ?? runs.data?.strategyRuns[0] ?? null;
  const go = async () => {
    setBusy(true); setErr(null);
    try { const d = await gql<{ backtestStrategy: Run }>(`mutation($id:ID!,$d:Float!){ backtestStrategy(id:$id, days:$d){ ${RUN_FIELDS} } }`, { id: s.id, d: Number(days) }); setFresh(d.backtestStrategy); tap(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const m: BtMetrics | null = run ? JSON.parse(run.metrics) : null;
  const trades: Trade[] = useMemo(() => (run ? JSON.parse(run.trades) : []), [run]);
  const equity: [number, number][] = useMemo(() => (run ? JSON.parse(run.equity) : []), [run]);
  return (
    <View style={{ gap: S[4] }}>
      <T v="sm" c="text2">Replays the rules on available chart history: signals fill at the next candle’s open; stop-loss and take-profit fill inside the candle; brokerage included. Available history resets when the market-data server restarts.</T>
      <Chips value={days} onChange={setDays} items={periods.map((p) => ({ k: String(p.days), label: p.label }))} />
      <Button kind="primary" title={busy ? 'Running…' : 'Run backtest'} busy={busy} onPress={go} />
      {err && <Notice tone="err">{err}</Notice>}
      {!run ? (runs.loading ? <Skeleton rows={2} /> : <Empty icon="trend" title="No backtest yet">Pick a period and run one to see how these rules would have done.</Empty>) : m && (
        <>
          <T v="xs">{new Date(run.from).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} – {new Date(run.to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · {m.candles} candles · qty {run.quantity} · rules v{run.version}</T>
          <Metrics items={[
            { k: 'Net P&L', v: rupees(m.netPnl, true), tone: m.netPnl > 0 ? 'pos' : m.netPnl < 0 ? 'neg' : 'flat' },
            { k: 'Win rate', v: `${m.winRate.toFixed(0)}% (${m.wins}/${m.trades})` },
            { k: 'Max drawdown', v: rupees(-m.maxDrawdown), tone: m.maxDrawdown > 0 ? 'neg' : 'flat' },
            { k: 'Profit factor', v: m.profitFactor === null ? '∞' : m.profitFactor.toFixed(2) },
          ]} />
          <Lines lines={[['Buy & hold', rupees(m.buyHoldPnl, true)], ['Average win / loss', `${rupees(m.avgWin)} / ${rupees(m.avgLoss)}`], ['Brokerage', rupees(m.fees)], ['In a trade', `${m.exposurePct.toFixed(0)}% of the time`]]} />
          <EquityCurve equity={equity} />
          <Section title="Trades">
            {!trades.length ? <T v="sm" c="text2">No trades: the entry rules never all held in this period.</T> : [...trades].reverse().slice(0, 30).map((t, k) => (
              <ListRow key={k} title={<Row gap={6}><T v="sm" w="600">{rupees(t.entryPrice)} → {rupees(t.exitPrice)}</T><Badge text={REASON[t.reason]} /></Row>}
                sub={`${new Date(t.entryAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · ${t.bars} candles`}
                right={<T v="num" c={t.pnl > 0 ? 'pos' : 'neg'}>{rupees(t.pnl, true)}</T>} />
            ))}
          </Section>
          <T v="xs">Past performance doesn’t guarantee future results.</T>
        </>
      )}
    </View>
  );
}

function EquityCurve({ equity }: { equity: [number, number][] }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const W = width - S[4] * 2, H = 160;
  const d = useMemo(() => {
    if (equity.length < 2) return null;
    const vs = equity.map((e) => e[1]);
    const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), span = hi - lo || 1;
    const y = (v: number) => 8 + (1 - (v - lo) / span) * (H - 16);
    const x = (k: number) => (k / (equity.length - 1)) * W;
    return { path: equity.map((e, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(e[1]).toFixed(1)}`).join(''), zero: y(0), up: vs[vs.length - 1] >= 0 };
  }, [equity, W]);
  if (!d) return null;
  return (
    <View style={{ gap: 6 }}>
      <T v="sm" c="text2" w="500">Equity curve</T>
      <View style={{ borderWidth: 1, borderColor: t.line, borderRadius: R.md, overflow: 'hidden' }}>
        <Svg width={W} height={H} accessibilityLabel="Equity curve of the backtest">
          <Line x1={0} x2={W} y1={d.zero} y2={d.zero} stroke={t.line2} strokeDasharray="4 4" />
          <Path d={d.path} stroke={d.up ? t.pos : t.neg} strokeWidth={2} fill="none" strokeLinejoin="round" />
        </Svg>
      </View>
    </View>
  );
}

function Live({ s }: { s: Strategy }) {
  const t = useTheme();
  const ev = useQuery<{ strategyEvents: { id: string; at: string; kind: string; message: string; pnl?: string }[] }>(`query($id:ID!){ strategyEvents(strategyId:$id, limit:50){ id at kind message pnl } }`, { id: s.id }, s.status === 'RUNNING' ? 5000 : undefined);
  const quote = useLiveQuotes(s.position !== 0 ? [s.instrumentId] : [])[s.instrumentId];
  const openPnl = s.position !== 0 && s.entryPrice && quote ? ((Number(quote.ltp) - Number(s.entryPrice)) * s.position).toFixed(2) : null;
  const pnl = s.today?.pnl ?? '0.00';
  const loss = -Math.min(0, Number(pnl));
  const used = Math.min(100, (loss / Math.max(1, Number(s.maxDailyLoss))) * 100);
  const toneOf = (k: string, p?: string): 'ok' | 'bad' | 'warn' | 'info' | undefined => (k === 'ENTRY' ? 'info' : k === 'EXIT' ? (p?.startsWith('-') ? 'bad' : 'ok') : k === 'BLOCKED' || k === 'ERROR' ? 'warn' : undefined);
  return (
    <View style={{ gap: S[4] }}>
      <Metrics items={[
        { k: 'Position', v: s.position === 0 ? 'Flat' : `${s.position > 0 ? '+' : ''}${s.position}${s.entryPrice ? ` @ ${inr(s.entryPrice)}` : ''}` },
        { k: 'Open P&L', v: openPnl ? inr(openPnl, true) : '—', tone: openPnl ? (Number(openPnl) >= 0 ? 'pos' : 'neg') : 'flat' },
        { k: 'Realised today', v: `₹${inr(pnl)}`, tone: pnl.startsWith('-') ? 'neg' : pnl === '0.00' ? 'flat' : 'pos' },
        { k: 'Orders today', v: `${s.today?.orders ?? 0} / ${s.maxOrdersPerDay}` },
      ]} />
      <View style={{ gap: 6 }}>
        <Spread><T v="sm" c="text2">Daily loss limit used</T><T v="xs">₹{loss.toFixed(2)} of ₹{inr(s.maxDailyLoss)}</T></Spread>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.bg3 }}><View style={{ width: `${used}%`, height: 6, borderRadius: 3, backgroundColor: used > 75 ? t.neg : t.brand }} /></View>
      </View>
      <Divider />
      <T v="h3">Event log</T>
      {ev.loading && !ev.data ? <Skeleton rows={3} /> : !ev.data?.strategyEvents.length ? <T v="sm" c="text2">Nothing yet.</T> : ev.data.strategyEvents.map((e) => (
        <ListRow key={e.id} title={<Row gap={6}><Badge text={e.kind.charAt(0) + e.kind.slice(1).toLowerCase()} tone={toneOf(e.kind, e.pnl)} /><T v="xs">{new Date(e.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</T></Row>}
          sub={<T v="sm" c="text2">{e.message}</T>} />
      ))}
    </View>
  );
}

