'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { Chips, Confirm, ErrorState, SkeletonRows, useToast } from '@/components/ui';
import { BacktestCharts } from '@/components/BacktestCharts';
import { gql } from '@/lib/api';
import {
  BLANK_RULES, conditionLabel, defaultOperand, describe, INTERVALS, OPERAND_TYPES, OPS, PERIODS, REASON, RUN_FIELDS, rupees, STRATEGY_FIELDS, TEMPLATES,
  type Condition, type Interval, type Metrics, type Operand, type Rules, type Run, type Strategy, type Trade,
} from '@/lib/algo';
import { inr, shortSymbol } from '@/lib/format';

interface Inst { id: string; symbol: string; name: string; exchange: string; segment: string }
interface Draft { name: string; instrument: Inst | null; interval: Interval; rules: Rules; quantity: string; maxDailyLoss: string; maxOrdersPerDay: string }
interface Ev { id: string; at: string; kind: string; message: string; pnl?: string }

function StrategyPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const isNew = id === 'new';
  const [s, setS] = useState<Strategy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>(''); // JSON of the saved draft, to detect edits
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (isNew) {
          const t = TEMPLATES.find((x) => x.key === sp.get('t'));
          let inst: Inst | null = null;
          const iid = sp.get('instrument');
          if (iid) inst = (await gql<{ instrument: Inst }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment } }`, { id: iid })).instrument;
          const d: Draft = { name: t ? t.name : 'My strategy', instrument: inst, interval: t?.interval ?? 'M15', rules: structuredClone(t?.rules ?? BLANK_RULES), quantity: '1', maxDailyLoss: '2000', maxOrdersPerDay: '20' };
          if (alive) { setDraft(d); setSaved(''); }
        } else {
          const r = await gql<{ strategy: Strategy }>(`query($id:ID!){ strategy(id:$id){ ${STRATEGY_FIELDS} } }`, { id });
          if (!alive) return;
          setS(r.strategy);
          const d = fromStrategy(r.strategy);
          setDraft(d);
          setSaved(JSON.stringify(d));
        }
      } catch (e) {
        if (alive) setError(e as { message: string; code?: string });
      }
    })();
    return () => { alive = false; };
  }, [id, isNew, sp]);

  // keep live status fresh while running
  useEffect(() => {
    if (isNew || !s || s.status !== 'RUNNING') return;
    const h = setInterval(async () => {
      try { setS((await gql<{ strategy: Strategy }>(`query($id:ID!){ strategy(id:$id){ ${STRATEGY_FIELDS} } }`, { id })).strategy); } catch { /* keep last */ }
    }, 5000);
    return () => clearInterval(h);
  }, [id, isNew, s?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const running = s?.status === 'RUNNING';

  const save = useCallback(async (): Promise<Strategy | null> => {
    if (!draft) return null;
    setFormErr(null);
    if (!draft.instrument) { setFormErr('Pick an instrument.'); return null; }
    setSaving(true);
    try {
      const input = {
        id: isNew ? undefined : id, name: draft.name.trim() || 'My strategy', instrumentId: draft.instrument.id, interval: draft.interval,
        rules: JSON.stringify(draft.rules), quantity: Number(draft.quantity) || 0, maxDailyLoss: draft.maxDailyLoss || '0', maxOrdersPerDay: Number(draft.maxOrdersPerDay) || 0,
      };
      const r = await gql<{ saveStrategy: Strategy }>(`mutation($i:SaveStrategyInput!){ saveStrategy(input:$i){ ${STRATEGY_FIELDS} } }`, { i: input });
      setS(r.saveStrategy);
      const d = fromStrategy(r.saveStrategy);
      setDraft(d);
      setSaved(JSON.stringify(d));
      if (isNew) router.replace(`/trader/algo/${r.saveStrategy.id}`);
      else toast(`Saved as version ${r.saveStrategy.version}`);
      return r.saveStrategy;
    } catch (e) {
      setFormErr((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [draft, id, isNew, router, toast]);

  if (error) return <ErrorState error={error} />;
  if (!draft) return <SkeletonRows rows={8} />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setRules = (patch: Partial<Rules>) => set({ rules: { ...draft.rules, ...patch } });

  return (
    <div className="stack algo-page" style={{ gap: 28 }}>
      <Link href="/trader/algo" className="t2 sm row" style={{ gap: 4 }}><Icon name="chevronLeft" size={16} />All strategies</Link>

      <header className="algo-head">
        <div className="algo-title">
          <input className="algo-name" value={draft.name} maxLength={80} aria-label="Strategy name" disabled={running} onChange={(e) => set({ name: e.target.value })} />
          <div className="t3 sm">{s ? `Version ${s.version}${dirty ? ' · unsaved changes' : ''}` : 'Not saved yet'}</div>
        </div>
        <StatusBadge s={s} />
        {!running && <button className="btn" disabled={saving || (!dirty && !isNew)} onClick={() => void save()}>{saving ? 'Saving…' : isNew ? 'Save' : 'Save changes'}</button>}
        {s && <LiveControls s={s} dirty={dirty} onChange={setS} save={save} />}
      </header>

      {formErr && <div className="notice err" role="alert"><Icon name="alert" size={18} /><span>{formErr}</span></div>}
      {running && <div className="notice info"><Icon name="info" size={18} /><span>The strategy is running. Stop it to change its rules.</span></div>}

      <div className="algo-grid">
        <section className="section panel algo-card" aria-label="Rules">
          <h2>Rules</h2>
          <fieldset disabled={running} className="stack" style={{ gap: 18, border: 0, padding: 0, margin: 0 }}>
            <div className="algo-row2">
              <label className="field"><span>Instrument</span><InstrumentPicker value={draft.instrument} onChange={(instrument) => set({ instrument })} /></label>
              <label className="field"><span>Quantity per trade</span><input className="input num" inputMode="numeric" value={draft.quantity} onChange={(e) => set({ quantity: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></label>
            </div>
            <div className="field"><span>Timeframe (candle size the rules look at)</span>
              <Chips label="Timeframe" value={draft.interval} onChange={(v) => set({ interval: v })} items={INTERVALS.map((i) => ({ v: i.v, label: i.label }))} />
            </div>
            <div className="field"><span>Direction</span>
              <div className="seg" role="group" aria-label="Direction">
                <button type="button" aria-pressed={draft.rules.side === 'LONG'} onClick={() => setRules({ side: 'LONG' })}>Buy first (long)</button>
                <button type="button" aria-pressed={draft.rules.side === 'SHORT'} onClick={() => setRules({ side: 'SHORT' })}>Sell first (short)</button>
              </div>
            </div>

            <Conditions title="Enter when ALL of these are true" list={draft.rules.entry} min={1} onChange={(entry) => setRules({ entry })} />
            <Conditions title="Exit when ANY of these is true" list={draft.rules.exit} min={0} onChange={(exit) => setRules({ exit })} />

            <div className="algo-row2">
              <Pct label="Stop-loss" hint="% against the trade" value={draft.rules.stopLossPct} onChange={(v) => setRules({ stopLossPct: v })} />
              <Pct label="Take-profit" hint="% in favour" value={draft.rules.takeProfitPct} onChange={(v) => setRules({ takeProfitPct: v })} />
            </div>

            <div className="field"><span>Guardrails</span>
              <div className="algo-row2">
                <label className="field"><span className="t3 sm">Stop for the day after losing (₹)</span><input className="input num" inputMode="decimal" value={draft.maxDailyLoss} onChange={(e) => set({ maxDailyLoss: e.target.value.replace(/[^\d.]/g, '').slice(0, 12) })} /></label>
                <label className="field"><span className="t3 sm">Max orders per day</span><input className="input num" inputMode="numeric" value={draft.maxOrdersPerDay} onChange={(e) => set({ maxOrdersPerDay: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></label>
              </div>
            </div>
          </fieldset>
          <div className="algo-summary"><Icon name="info" size={16} /><span>{describe(draft.rules, Number(draft.quantity) || 0, draft.instrument ? shortSymbol(draft.instrument.symbol) : 'the instrument')}</span></div>
        </section>

        <div className="stack" style={{ gap: 24, minWidth: 0 }}>
          <Backtest s={s} draft={draft} dirty={dirty} save={save} />
          {s && s.status !== 'DRAFT' && <Live s={s} />}
        </div>
      </div>
    </div>
  );
}

function fromStrategy(s: Strategy): Draft {
  return {
    name: s.name,
    instrument: s.instrument ? { id: s.instrument.id, symbol: s.instrument.symbol, name: s.instrument.name, exchange: s.instrument.exchange, segment: s.instrument.segment } : null,
    interval: s.interval,
    rules: JSON.parse(s.rules) as Rules,
    quantity: String(s.quantity),
    maxDailyLoss: s.maxDailyLoss.replace(/\.00$/, ''),
    maxOrdersPerDay: String(s.maxOrdersPerDay),
  };
}

function StatusBadge({ s }: { s: Strategy | null }) {
  if (!s) return <span className="badge info">New</span>;
  if (s.status === 'RUNNING') return <span className="badge ok"><span className="live-dot" aria-hidden />Running</span>;
  if (s.status === 'STOPPED') return <span className="badge" title={s.stopReason}>Stopped</span>;
  return <span className="badge info">Draft</span>;
}

/* ======================================================================= rule builder */

function Conditions({ title, list, min, onChange }: { title: string; list: Condition[]; min: number; onChange: (l: Condition[]) => void }) {
  const add = () => onChange([...list, { left: defaultOperand('price'), op: 'crossesAbove', right: defaultOperand('ema') }]);
  return (
    <div className="field">
      <span>{title}</span>
      <div className="stack" style={{ gap: 8 }}>
        {list.length === 0 && <div className="t3 sm">None. The trade closes on stop-loss or take-profit only.</div>}
        {list.map((c, k) => (
          <div key={k} className="cond">
            <OperandEditor value={c.left} onChange={(left) => onChange(list.map((x, j) => (j === k ? { ...x, left } : x)))} />
            <select className="input cond-op" aria-label="Comparison" value={c.op} onChange={(e) => onChange(list.map((x, j) => (j === k ? { ...x, op: e.target.value as Condition['op'] } : x)))}>
              {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <OperandEditor value={c.right} onChange={(right) => onChange(list.map((x, j) => (j === k ? { ...x, right } : x)))} />
            <button type="button" className="icon-btn" aria-label={`Remove condition: ${conditionLabel(c)}`} disabled={list.length <= min} onClick={() => onChange(list.filter((_, j) => j !== k))}><Icon name="x" size={18} /></button>
          </div>
        ))}
        {list.length < 5 && <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="plus" size={16} />Add condition</button>}
      </div>
    </div>
  );
}

function OperandEditor({ value, onChange }: { value: Operand; onChange: (o: Operand) => void }) {
  const num = (v: string, lo: number, hi: number, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback; };
  return (
    <div className="operand">
      <select className="input" aria-label="Indicator" value={value.type} onChange={(e) => onChange(defaultOperand(e.target.value as Operand['type']))}>
        {OPERAND_TYPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {value.type === 'price' && (
        <select className="input" aria-label="Price field" value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value as typeof value.field })}>
          {['close', 'open', 'high', 'low'].map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
        </select>
      )}
      {(value.type === 'ema' || value.type === 'sma' || value.type === 'rsi' || value.type === 'bb') && (
        <input className="input num w-period" aria-label="Period" inputMode="numeric" value={value.period} onChange={(e) => onChange({ ...value, period: num(e.target.value, 2, 200, value.period) })} title="Period (candles)" />
      )}
      {value.type === 'bb' && (
        <select className="input" aria-label="Band" value={value.band} onChange={(e) => onChange({ ...value, band: e.target.value as typeof value.band })}>
          <option value="upper">upper</option><option value="middle">middle</option><option value="lower">lower</option>
        </select>
      )}
      {value.type === 'number' && (
        <input className="input num w-value" aria-label="Value" inputMode="decimal" defaultValue={value.value} onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange({ ...value, value: n }); }} />
      )}
    </div>
  );
}

function Pct({ label, hint, value, onChange }: { label: string; hint: string; value?: number; onChange: (v?: number) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  return (
    <label className="field">
      <span>{label} <span className="t3 sm">({hint}, optional)</span></span>
      <div className="input-suffix">
        <input className="input num" inputMode="decimal" placeholder="Off" value={text}
          onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
          onBlur={() => { const n = Number(text); onChange(text === '' || !Number.isFinite(n) || n <= 0 ? undefined : n); }} />
        <span className="t3">%</span>
      </div>
    </label>
  );
}

function InstrumentPicker({ value, onChange }: { value: Inst | null; onChange: (i: Inst) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Inst[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const h = setTimeout(() => gql<{ searchInstruments: Inst[] }>(`query($q:String!){ searchInstruments(query:$q, limit:8){ id symbol name exchange segment } }`, { q }).then((d) => setHits(d.searchInstruments)).catch(() => setHits([])), 180);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <input className="input" placeholder={value ? `${shortSymbol(value.symbol)} · ${value.exchange}` : 'Search, e.g. NIFTY'} value={open ? q : value ? `${shortSymbol(value.symbol)} · ${value.name.replace(/ — .*/, '')}` : q}
        onFocus={() => { setOpen(true); setQ(''); }} onChange={(e) => { setQ(e.target.value); setOpen(true); }} aria-label="Instrument" />
      {open && hits && (
        <ul className="suggest" role="listbox" style={{ listStyle: 'none', margin: 0 }}>
          {hits.length === 0 ? <li className="t2 sm" style={{ padding: '12px 16px' }}>No match.</li> : hits.map((h) => (
            <li key={h.id} role="option" aria-selected={value?.id === h.id} onMouseDown={(e) => { e.preventDefault(); onChange(h); setOpen(false); setQ(''); }}>
              <span className="mark" aria-hidden>{shortSymbol(h.symbol).slice(0, 2)}</span>
              <span className="grow"><span className="w6">{shortSymbol(h.symbol)}</span><span className="t3" style={{ display: 'block' }}>{h.name}</span></span>
              <span className="badge">{h.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ======================================================================= backtest */

function Backtest({ s, draft, dirty, save }: { s: Strategy | null; draft: Draft; dirty: boolean; save: () => Promise<Strategy | null> }) {
  const periods = PERIODS[draft.interval];
  const [days, setDays] = useState(periods[periods.length - 1].days);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!periods.some((p) => p.days === days)) setDays(periods[periods.length - 1].days); }, [draft.interval]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s) return;
    gql<{ strategyRuns: Run[] }>(`query($id:ID!){ strategyRuns(strategyId:$id, limit:10){ ${RUN_FIELDS} } }`, { id: s.id }).then((d) => { setRuns(d.strategyRuns); setSel((cur) => cur ?? d.strategyRuns[0] ?? null); }).catch(() => undefined);
  }, [s?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      let st = s;
      if (!st || dirty) st = await save();
      if (!st) return;
      const r = await gql<{ backtestStrategy: Run }>(`mutation($id:ID!,$d:Float!){ backtestStrategy(id:$id, days:$d){ ${RUN_FIELDS} } }`, { id: st.id, d: days });
      setRuns((l) => [r.backtestStrategy, ...l].slice(0, 10));
      setSel(r.backtestStrategy);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const m: Metrics | null = sel ? JSON.parse(sel.metrics) : null;
  const trades: Trade[] = sel ? JSON.parse(sel.trades) : [];
  const equity: [number, number][] = sel ? JSON.parse(sel.equity) : [];
  return (
    <section className="section panel algo-card" aria-label="Backtest">
      <div className="spread"><h2>Backtest</h2>{runs.length > 1 && (
        <select className="input" style={{ width: 'auto' }} aria-label="Previous runs" value={sel?.id ?? ''} onChange={(e) => setSel(runs.find((r) => r.id === e.target.value) ?? null)}>
          {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · v{r.version} · {INTERVALS.find((i) => i.v === r.interval)?.label}</option>)}
        </select>
      )}</div>
      <p className="t2 sm">Replays the rules on stored candles: signals on a candle’s close fill at the next candle’s open; stop-loss and take-profit fill inside the candle; brokerage included.</p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <Chips label="Backtest period" value={String(days)} onChange={(v) => setDays(Number(v))} items={periods.map((p) => ({ v: String(p.days), label: p.label }))} />
        <button className="btn btn-primary" disabled={busy || !draft.instrument} onClick={() => void run()}>{busy ? 'Running…' : dirty || !s ? 'Save & run backtest' : 'Run backtest'}</button>
      </div>
      {err && <div className="notice err" role="alert"><Icon name="alert" size={18} /><span>{err}</span></div>}
      {!sel ? (
        <div className="state" style={{ padding: '32px 16px' }}><div className="ico"><Icon name="trend" size={22} /></div><h3>No backtest yet</h3><div className="sm">Pick a period and run one to see how these rules would have done.</div></div>
      ) : m && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="t3 sm">{fmtDate(sel.from)} – {fmtDate(sel.to)} · {m.candles.toLocaleString('en-IN')} candles · quantity {sel.quantity} · rules v{sel.version}{s && sel.version !== s.version ? ' (older version)' : ''}</div>
          <div className="bt-metrics">
            <BigMetric k="Net P&L" v={rupees(m.netPnl, true)} tone={m.netPnl > 0 ? 'pos' : m.netPnl < 0 ? 'neg' : ''} sub={`Buy & hold: ${rupees(m.buyHoldPnl, true)}`} />
            <BigMetric k="Win rate" v={`${m.winRate.toFixed(0)}%`} sub={`${m.wins} won · ${m.losses} lost`} />
            <BigMetric k="Max drawdown" v={rupees(-m.maxDrawdown)} tone={m.maxDrawdown > 0 ? 'neg' : ''} sub={`${m.maxConsecutiveLosses} losses in a row at worst`} />
            <BigMetric k="Profit factor" v={m.profitFactor === null ? '∞' : m.profitFactor.toFixed(2)} sub={`${m.trades} trades · in a trade ${m.exposurePct.toFixed(0)}% of the time`} />
          </div>
          <dl className="facts bt-facts">
            {[
              ['Average win', rupees(m.avgWin)], ['Average loss', rupees(m.avgLoss)], ['Largest win', rupees(m.largestWin)], ['Largest loss', rupees(m.largestLoss)],
              ['Gross profit', rupees(m.grossProfit)], ['Gross loss', rupees(-m.grossLoss)], ['Brokerage', rupees(m.fees)], ['Sharpe (per trade)', m.sharpePerTrade === null ? '—' : m.sharpePerTrade.toFixed(2)],
            ].map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}
          </dl>
          <BacktestCharts instrumentId={s?.instrumentId ?? draft.instrument?.id ?? ''} interval={sel.interval} from={Date.parse(sel.from)} to={Date.parse(sel.to)} trades={trades} equity={equity} />
          <Trades trades={trades} interval={sel.interval} />
          <p className="t3 sm">Simulated history; past performance doesn’t guarantee future results.</p>
        </div>
      )}
    </section>
  );
}

function BigMetric({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div className="bt-metric">
      <div className="t3 sm">{k}</div>
      <div className={`num w6 ${tone ?? ''}`} style={{ fontSize: 22 }}>{v}</div>
      {sub && <div className="t3 sm">{sub}</div>}
    </div>
  );
}

function Trades({ trades, interval }: { trades: Trade[]; interval: Interval }) {
  const [all, setAll] = useState(false);
  if (!trades.length) return <p className="t2 sm">No trades: the entry rules never all held in this period.</p>;
  const list = [...trades].reverse();
  const shown = all ? list : list.slice(0, 10);
  const when = (ms: number) => { const d = new Date(ms); const day = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...(interval === 'D1' ? { year: '2-digit' } : {}) }); return interval === 'D1' ? day : `${day} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`; };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ fontSize: 15 }}>Trades</h3>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Entry</th><th className="r">Price</th><th>Exit</th><th className="r">Price</th><th>Reason</th><th className="r">P&L</th></tr></thead>
          <tbody>
            {shown.map((t, k) => (
              <tr key={k}>
                <td className="sm nowrap">{when(t.entryAt)}</td><td className="r num">{rupees(t.entryPrice)}</td>
                <td className="sm nowrap">{when(t.exitAt)}</td><td className="r num">{rupees(t.exitPrice)}</td>
                <td className="sm">{REASON[t.reason]}</td>
                <td className={`r num w6 ${t.pnl > 0 ? 'pos' : 'neg'}`}>{rupees(t.pnl, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > 10 && <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${list.length} trades`}</button>}
    </div>
  );
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/* ======================================================================= live */

function LiveControls({ s, dirty, onChange, save }: { s: Strategy; dirty: boolean; onChange: (s: Strategy) => void; save: () => Promise<Strategy | null> }) {
  const toast = useToast();
  const router = useRouter();
  const [ask, setAsk] = useState<'start' | 'stop' | 'delete' | null>(null);
  const [flatten, setFlatten] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rules = useMemo(() => JSON.parse(s.rules) as Rules, [s.rules]);
  const symbol = s.instrument ? shortSymbol(s.instrument.symbol) : '';

  const act = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (ask === 'start') {
        let st: Strategy | null = s;
        if (dirty) st = await save();
        if (!st) return;
        const r = await gql<{ startStrategy: Strategy }>(`mutation($id:ID!){ startStrategy(id:$id){ ${STRATEGY_FIELDS} } }`, { id: st.id });
        onChange(r.startStrategy);
        toast('Strategy started. It acts when the next candle closes.');
      } else if (ask === 'stop') {
        const r = await gql<{ stopStrategy: Strategy }>(`mutation($id:ID!,$f:Boolean){ stopStrategy(id:$id, flatten:$f){ ${STRATEGY_FIELDS} } }`, { id: s.id, f: flatten });
        onChange(r.stopStrategy);
        toast('Strategy stopped.');
      } else if (ask === 'delete') {
        await gql(`mutation($id:ID!){ deleteStrategy(id:$id) }`, { id: s.id });
        toast('Strategy deleted.');
        router.push('/trader/algo');
      }
      setAsk(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {s.status === 'RUNNING'
        ? <button className="btn btn-sell" onClick={() => { setErr(null); setAsk('stop'); }}>Stop</button>
        : <>
            <button className="btn btn-buy" onClick={() => { setErr(null); setAsk('start'); }}><Icon name="activity" size={16} />Start</button>
            <button className="icon-btn" aria-label="Delete strategy" title="Delete strategy" onClick={() => { setErr(null); setAsk('delete'); }}><Icon name="x" /></button>
          </>}
      {ask === 'start' && (
        <Confirm
          title={`Start “${s.name}”?`} sub="Paper trading on the simulated feed"
          lines={[
            ['Instrument', symbol], ['Timeframe', INTERVALS.find((i) => i.v === s.interval)?.label ?? s.interval], ['Each trade', `${rules.side === 'LONG' ? 'Buy' : 'Sell'} ${s.quantity} at market`],
            ['Stop-loss / take-profit', `${rules.stopLossPct ?? '—'}% / ${rules.takeProfitPct ?? '—'}%`], ['Stops for the day after losing', `₹${inr(s.maxDailyLoss)}`], ['Max orders per day', String(s.maxOrdersPerDay)],
          ]}
          warning={`${describe(rules, s.quantity, symbol)} Orders are simulated and use your virtual balance, with the same checks as manual orders.${dirty ? ' Your unsaved changes are saved first.' : ''}`}
          confirmLabel="Start strategy" tone="buy" pending={busy} error={err} onConfirm={act} onClose={() => setAsk(null)}
        />
      )}
      {ask === 'stop' && (
        <Confirm
          title={`Stop “${s.name}”?`} sub="It stops acting immediately"
          lines={[['Open position', s.position === 0 ? 'None' : `${s.position > 0 ? '+' : ''}${s.position} ${symbol}`], ['P&L today', `₹${inr(s.today?.pnl ?? '0.00')}`], ['Close the position', s.position === 0 ? '—' : <label key="f" className="row" style={{ gap: 6 }}><input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />Yes, at market</label>]]}
          confirmLabel="Stop strategy" tone="danger" pending={busy} error={err} onConfirm={act} onClose={() => setAsk(null)}
        />
      )}
      {ask === 'delete' && (
        <Confirm title={`Delete “${s.name}”?`} sub="Its backtests and event log are deleted too" lines={[['Orders it placed', 'Stay in your order history']]} confirmLabel="Delete" tone="danger" pending={busy} error={err} onConfirm={act} onClose={() => setAsk(null)} />
      )}
    </>
  );
}

function Live({ s }: { s: Strategy }) {
  const [events, setEvents] = useState<Ev[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => gql<{ strategyEvents: Ev[] }>(`query($id:ID!){ strategyEvents(strategyId:$id, limit:50){ id at kind message pnl } }`, { id: s.id }).then((d) => alive && setEvents(d.strategyEvents)).catch(() => undefined);
    void load();
    const h = s.status === 'RUNNING' ? setInterval(load, 5000) : undefined;
    return () => { alive = false; if (h) clearInterval(h); };
  }, [s.id, s.status, s.updatedAt]);
  const pnl = s.today?.pnl ?? '0.00';
  const loss = -Math.min(0, Number(pnl));
  const lossPct = Math.min(100, (loss / Math.max(1, Number(s.maxDailyLoss))) * 100);
  return (
    <section className="section panel algo-card" aria-label="Live">
      <h2>Live</h2>
      <div className="bt-metrics">
        <BigMetric k="Status" v={s.status === 'RUNNING' ? 'Running' : s.status === 'STOPPED' ? 'Stopped' : 'Draft'} sub={s.status === 'RUNNING' && s.startedAt ? `since ${new Date(s.startedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : s.stopReason} />
        <BigMetric k="Position" v={s.position === 0 ? 'Flat' : `${s.position > 0 ? '+' : ''}${s.position}`} sub={s.entryPrice ? `entered @ ₹${inr(s.entryPrice)}` : undefined} />
        <BigMetric k="P&L today" v={`₹${inr(pnl)}`} tone={pnl.startsWith('-') ? 'neg' : pnl === '0.00' ? '' : 'pos'} sub="realised, after fees" />
        <BigMetric k="Orders today" v={`${s.today?.orders ?? 0} / ${s.maxOrdersPerDay}`} />
      </div>
      <div>
        <div className="spread sm"><span className="t2">Daily loss limit used</span><span className="num t2">₹{loss.toFixed(2)} of ₹{inr(s.maxDailyLoss)}</span></div>
        <div className="range" aria-label={`Daily loss limit ${lossPct.toFixed(0)}% used`}><div className="fill" style={{ width: `${lossPct}%`, background: lossPct > 75 ? 'var(--neg)' : undefined }} /></div>
      </div>
      <h3 style={{ fontSize: 15 }}>Event log</h3>
      {!events ? <SkeletonRows rows={3} /> : !events.length ? <p className="t3 sm">Nothing yet.</p> : (
        <ul className="events">
          {events.map((e) => (
            <li key={e.id}>
              <span className={`badge ${e.kind === 'ENTRY' ? 'info' : e.kind === 'EXIT' ? (e.pnl?.startsWith('-') ? 'bad' : 'ok') : e.kind === 'BLOCKED' || e.kind === 'ERROR' ? 'warn' : ''}`}>{e.kind.charAt(0) + e.kind.slice(1).toLowerCase()}</span>
              <span className="grow sm">{e.message}</span>
              <time className="t3 sm num">{new Date(e.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Page() {
  return <Suspense fallback={<SkeletonRows rows={8} />}><StrategyPage /></Suspense>;
}
