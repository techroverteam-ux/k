'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { gql } from '@/lib/api';
import { Icon } from './icons';
import type { Quote } from './trading';
import { Chips, ErrorState } from './ui';

/**
 * Trading-style price chart.
 * - Candles or a close line; timeframes 1m / 5m / 15m / 1H / 1D.
 * - Zoom with the + / − buttons, the mouse wheel, a trackpad pinch, or the + / − / 0 keys. Drag to pan.
 * - Calendar: jump to any date, or pick a quick range. Older candles load automatically as you scroll back.
 * - Expand button opens the chart full screen (Esc closes it).
 * - Crosshair with an OHLC legend that includes the candle's date and time. All times are IST.
 * - The forming candle updates live from the quote stream.
 * Prices and history come from the simulated feed in this build.
 */

type Interval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
type Style = 'candles' | 'line';
interface Candle { t: number; open: string; high: string; low: string; close: string }
interface Bar { time: UTCTimestamp; open: number; high: number; low: number; close: number }

const IST_S = 19_800; // UTC+05:30. The chart renders UTC, so every time is shifted to read as IST.
const DAY_MS = 86_400_000;
const STEP_MS: Record<Interval, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, D1: DAY_MS };
const LABEL: Record<Interval, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1H', D1: '1D' };
const VISIBLE = 120; // candles in view on load
const PAGE = 500; // candles per request
const Q = `query($i:ID!,$v:CandleInterval!,$n:Int,$b:Float){ candles(instrumentId:$i, interval:$v, limit:$n, before:$b){ t open high low close } }`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toBar = (c: Candle): Bar => ({ time: (Math.floor(c.t / 1000) + IST_S) as UTCTimestamp, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
const barMs = (b: Bar) => (b.time - IST_S) * 1000; // real epoch ms of a bar's start
const bucketSec = (ms: number, step: number) => (Math.floor((ms + IST_S * 1000) / step) * step) / 1000; // IST-shifted
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const two = (n: number) => String(n).padStart(2, '0');
/** IST-shifted chart time → parts (read in UTC because the shift is already applied). */
const parts = (t: number) => { const d = new Date(t * 1000); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const dateLabel = (t: number) => { const p = parts(t); return `${p.d} ${MONTHS[p.mo]} ${p.y}`; };
const timeLabel = (t: number, iv: Interval) => { const p = parts(t); return iv === 'D1' ? dateLabel(t) : `${p.d} ${MONTHS[p.mo]} ${p.y}, ${two(p.h)}:${two(p.mi)}`; };
/** "2026-10-28" in IST → epoch ms of that IST midnight. */
const istMidnight = (ymd: string) => Date.parse(`${ymd}T00:00:00+05:30`);
const istYmd = (ms: number) => new Date(ms + IST_S * 1000).toISOString().slice(0, 10);

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    bg: v('--bg', '#ffffff'),
    text: v('--text-2', '#697080'),
    line: v('--line', '#ebedf0'),
    cross: v('--text-3', '#9a9fac'),
    pos: v('--pos', '#08a77b'),
    neg: v('--neg', '#e14f3b'),
    brand: v('--brand', '#08a77b'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

export function CandleChart({ instrumentId, quote, tickSize }: { instrumentId: string; quote?: Quote; tickSize: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const line = useRef<ISeriesApi<'Line'> | null>(null);
  const range = useRef<ISeriesApi<'Histogram'> | null>(null);
  const bars = useRef<Bar[]>([]);
  const gen = useRef(0); // bumps on every reload, so late responses for an old timeframe are ignored
  const older = useRef<{ busy: boolean; done: boolean }>({ busy: false, done: false });
  const ivRef = useRef<Interval>('M5');
  const pending = useRef<{ fromMs: number; toMs: number } | null>(null); // a date jump waiting for a timeframe switch
  const [interval, setIntervalV] = useState<Interval>('M5');
  const [style, setStyle] = useState<Style>('candles');
  const [last, setLast] = useState<Bar | null>(null);
  const [hover, setHover] = useState<Bar | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  ivRef.current = interval;

  const fetchPage = useCallback(
    async (iv: Interval, before?: number) => (await gql<{ candles: Candle[] }>(Q, { i: instrumentId, v: iv, n: PAGE, b: before })).candles.map(toBar),
    [instrumentId],
  );

  const paint = useCallback((b: Bar[]) => {
    const t = theme();
    candles.current?.setData(b);
    line.current?.setData(b.map((x) => ({ time: x.time, value: x.close })));
    range.current?.setData(rangeData(b, t.pos, t.neg));
  }, []);

  /** Prepend one page of older candles, keeping the view where it is. Returns false when history is exhausted. */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const o = older.current;
    if (o.busy || o.done || !bars.current.length) return !o.done;
    o.busy = true;
    setLoadingOlder(true);
    const g = gen.current;
    try {
      const page = await fetchPage(ivRef.current, barMs(bars.current[0]));
      if (g !== gen.current) return false;
      if (!page.length) {
        o.done = true;
        return false;
      }
      const ts = chart.current?.timeScale();
      const r = ts?.getVisibleLogicalRange();
      bars.current = [...page, ...bars.current];
      paint(bars.current);
      if (ts && r) ts.setVisibleLogicalRange({ from: r.from + page.length, to: r.to + page.length });
      if (page.length < PAGE) o.done = true;
      return true;
    } catch {
      return false;
    } finally {
      o.busy = false;
      setLoadingOlder(false);
    }
  }, [fetchPage, paint]);

  // Create the chart once.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const t = theme();
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.1, bottom: 0.14 } },
      timeScale: {
        borderColor: t.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 9,
        minBarSpacing: 1,
        fixLeftEdge: true, // no empty space before the first candle; older ones load as you reach it
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const p = parts(time as number);
          if (type === TickMarkType.Year) return String(p.y);
          if (type === TickMarkType.Month) return `${MONTHS[p.mo]} ${String(p.y).slice(2)}`;
          if (type === TickMarkType.DayOfMonth) return `${p.d} ${MONTHS[p.mo]}`;
          return `${two(p.h)}:${two(p.mi)}`;
        },
      },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      kineticScroll: { touch: true, mouse: false },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.cross, labelBackgroundColor: t.text }, horzLine: { color: t.cross, labelBackgroundColor: t.text } },
      localization: { locale: 'en-IN', priceFormatter: fmt, timeFormatter: (time: Time) => timeLabel(time as number, ivRef.current) },
    });
    const pf = { type: 'price' as const, precision: 2, minMove: tickSize > 0 ? tickSize : 0.05 };
    candles.current = c.addSeries(CandlestickSeries, { upColor: t.pos, downColor: t.neg, borderVisible: false, wickUpColor: t.pos, wickDownColor: t.neg, priceFormat: pf });
    line.current = c.addSeries(LineSeries, { color: t.brand, lineWidth: 2, visible: false, priceFormat: pf, crosshairMarkerRadius: 4 });
    // Candle range (high − low) as a faint histogram along the bottom: the feed has no volume, so this shows activity instead.
    range.current = c.addSeries(HistogramSeries, { priceScaleId: 'range', priceFormat: pf, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('range').applyOptions({ scaleMargins: { top: 0.88, bottom: 0 }, visible: false });
    c.subscribeCrosshairMove((p) => {
      const d = p.time && candles.current ? (p.seriesData.get(candles.current) as CandlestickData<UTCTimestamp> | undefined) : undefined;
      setHover(d ? { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close } : null);
    });
    // Load older candles when the user scrolls close to the start of what's loaded.
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 40) void loadOlder();
    });
    chart.current = c;

    // Follow the app theme (Profile → Preferences) and the system setting.
    const restyle = () => {
      const n = theme();
      c.applyOptions({
        layout: { background: { type: ColorType.Solid, color: n.bg }, textColor: n.text },
        grid: { vertLines: { color: n.line }, horzLines: { color: n.line } },
        rightPriceScale: { borderColor: n.line },
        timeScale: { borderColor: n.line },
        crosshair: { vertLine: { color: n.cross, labelBackgroundColor: n.text }, horzLine: { color: n.cross, labelBackgroundColor: n.text } },
      });
      candles.current?.applyOptions({ upColor: n.pos, downColor: n.neg, wickUpColor: n.pos, wickDownColor: n.neg });
      line.current?.applyOptions({ color: n.brand });
      range.current?.setData(rangeData(bars.current, n.pos, n.neg));
    };
    const mo = new MutationObserver(restyle);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', restyle);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', restyle);
      c.remove();
      chart.current = candles.current = line.current = range.current = null;
    };
  }, [tickSize, loadOlder]);

  // Load the latest page for the instrument and timeframe.
  const load = useCallback(
    async (fresh: boolean) => {
      const g = fresh ? ++gen.current : gen.current;
      if (fresh) {
        setState('loading');
        older.current = { busy: false, done: false };
      }
      try {
        const page = await fetchPage(interval);
        if (g !== gen.current) return;
        if (fresh || !bars.current.length) {
          bars.current = page;
          if (page.length < PAGE) older.current.done = true;
        } else {
          // Background refresh: replace the overlapping tail, keep older pages already loaded.
          const from = page[0]?.time ?? Infinity;
          bars.current = [...bars.current.filter((b) => b.time < from), ...page];
        }
        paint(bars.current);
        if (fresh) showLatest();
        setLast(bars.current[bars.current.length - 1] ?? null);
        setError(null);
        setState('ready');
      } catch (e) {
        if (fresh && g === gen.current) {
          setError(e as { message: string; code?: string });
          setState('error');
        }
      }
    },
    [fetchPage, interval, paint],
  );

  useEffect(() => {
    setHover(null);
    void load(true);
    // Re-sync now and then, and when the tab comes back, in case ticks were missed while it was hidden.
    const every = setInterval(() => void load(false), 5 * 60_000);
    const vis = () => document.visibilityState === 'visible' && void load(false);
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(every);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [load]);

  useEffect(() => {
    candles.current?.applyOptions({ visible: style === 'candles' });
    line.current?.applyOptions({ visible: style === 'line' });
  }, [style]);

  // Live: update the forming candle (or start a new one) from each quote.
  useEffect(() => {
    if (state !== 'ready' || !quote?.ltp) return;
    const price = Number(quote.ltp);
    const ms = Date.parse(quote.ts) || Date.now();
    const time = bucketSec(ms, STEP_MS[interval]) as UTCTimestamp;
    const list = bars.current;
    const prev = list[list.length - 1];
    if (prev && time < prev.time) return;
    const bar: Bar = prev && prev.time === time
      ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price }
      : { time, open: price, high: price, low: price, close: price };
    if (prev && prev.time === time) list[list.length - 1] = bar;
    else list.push(bar);
    candles.current?.update(bar);
    line.current?.update({ time, value: price });
    const t = theme();
    range.current?.update(rangeData([bar], t.pos, t.neg)[0]);
    setLast(bar);
  }, [quote?.ltp, quote?.ts, interval, state]);

  // Resize cleanly when the chart is expanded or collapsed; Esc collapses; lock page scroll while expanded.
  useEffect(() => {
    if (!expanded) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.chart-cal-pop')) toggleExpanded(); };
    document.addEventListener('keydown', key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  /* ----------------------------------------------------------------- view controls */
  function showLatest() {
    const n = bars.current.length;
    chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE), to: n + 4 });
    chart.current?.priceScale('right').applyOptions({ autoScale: true });
  }

  function zoom(factor: number) {
    const ts = chart.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const n = bars.current.length;
    const span = r.to - r.from;
    const next = Math.min(Math.max(span * factor, 8), Math.max(n + 20, 40));
    const atLatest = r.to >= n - 2;
    // Keep the newest candle pinned when you are looking at it; otherwise zoom around the middle.
    const to = atLatest ? r.to : (r.from + r.to) / 2 + next / 2;
    ts.setVisibleLogicalRange({ from: to - next, to });
    if (factor > 1 && to - next < 40) void loadOlder();
  }

  /** Show [fromMs, toMs) on the chart, loading older pages first if needed. */
  async function showRange(fromMs: number, toMs: number, iv: Interval) {
    setCalOpen(false);
    // Intraday history is kept for a few days only; dates before it open in daily candles.
    if (iv !== 'D1' && !(bars.current.length && barMs(bars.current[0]) <= fromMs)) {
      const covered = await hasCandles(iv, fromMs, toMs);
      if (!covered) {
        setNote(`Intraday candles aren't kept that far back. Showing daily candles around ${dateLabel(fromMs / 1000 + IST_S)}.`);
        pending.current = { fromMs, toMs };
        setIntervalV('D1');
        return;
      }
    }
    while (bars.current.length && barMs(bars.current[0]) > fromMs) {
      if (!(await loadOlder())) break;
    }
    const ts = chart.current?.timeScale();
    if (!ts || !bars.current.length) return;
    const fromT = bucketSec(fromMs, STEP_MS[iv]);
    const toT = bucketSec(Math.min(toMs, Date.now()), STEP_MS[iv]);
    // Pad daily views so a single day still shows some context around it.
    const pad = iv === 'D1' && toMs - fromMs <= DAY_MS ? 15 * 86_400 : 0;
    try {
      ts.setVisibleRange({ from: (fromT - pad) as UTCTimestamp, to: (toT + pad) as UTCTimestamp });
    } catch {
      showLatest();
    }
  }
  useEffect(() => {
    if (state === 'ready' && pending.current) {
      const p = pending.current;
      pending.current = null;
      void showRange(p.fromMs, p.toMs, interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, interval]);

  /** Is there at least one candle in [fromMs, toMs)? One small request. */
  async function hasCandles(iv: Interval, fromMs: number, toMs: number) {
    try {
      const d = await gql<{ candles: Candle[] }>(Q, { i: instrumentId, v: iv, n: 1, b: toMs });
      return d.candles.length > 0 && d.candles[0].t >= fromMs;
    } catch {
      return true; // let the normal path try
    }
  }

  /** Expand or collapse, keeping the same candles in view once the chart has resized. */
  function toggleExpanded() {
    const r = chart.current?.timeScale().getVisibleLogicalRange();
    setExpanded((v) => !v);
    if (r) requestAnimationFrame(() => requestAnimationFrame(() => chart.current?.timeScale().setVisibleLogicalRange(r)));
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(0.7); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(1.4); }
    else if (e.key === '0') { e.preventDefault(); showLatest(); }
  };

  const shown = hover ?? last;
  const ch = shown ? shown.close - shown.open : 0;
  const chPct = shown && shown.open ? (ch / shown.open) * 100 : 0;
  const todayYmd = istYmd(Date.now());

  return (
    <section className={`section chart-panel${expanded ? ' is-expanded' : ''}`} aria-label="Price chart">
      <div className="chart-tools">
        <Chips label="Timeframe" value={interval} onChange={(v) => { setNote(null); setIntervalV(v); }} items={(Object.keys(LABEL) as Interval[]).map((v) => ({ v, label: LABEL[v] }))} />
        <div className="chart-tools-right">
          <Chips label="Chart type" value={style} onChange={setStyle} items={[
            { v: 'candles', label: <span className="row" style={{ gap: 6 }}><CandleGlyph /><span className="hide-sm">Candles</span></span>, title: 'Candles' },
            { v: 'line', label: <span className="row" style={{ gap: 6 }}><Icon name="trend" size={14} /><span className="hide-sm">Line</span></span>, title: 'Line' },
          ]} />
          <div className="chart-btns" role="group" aria-label="Chart view">
            <ToolBtn label="Zoom out (−)" onClick={() => zoom(1.4)}><Glyph d="M5 12h14" /></ToolBtn>
            <ToolBtn label="Zoom in (+)" onClick={() => zoom(0.7)}><Glyph d="M12 5v14M5 12h14" /></ToolBtn>
            <ToolBtn label="Back to latest (0)" onClick={showLatest}><Glyph d="M13 6l6 6-6 6M5 6l6 6-6 6" /></ToolBtn>
            <div className="chart-cal">
              <ToolBtn label="Go to date" pressed={calOpen} onClick={() => setCalOpen((v) => !v)}><Icon name="calendar" size={16} /></ToolBtn>
              {calOpen && (
                <CalendarPopover
                  interval={interval}
                  today={todayYmd}
                  onClose={() => setCalOpen(false)}
                  onPick={(fromMs, toMs, iv) => {
                    setNote(null);
                    if (iv !== interval) {
                      pending.current = { fromMs, toMs };
                      setCalOpen(false);
                      setIntervalV(iv);
                    } else void showRange(fromMs, toMs, iv);
                  }}
                />
              )}
            </div>
            <ToolBtn label={expanded ? 'Exit full screen (Esc)' : 'Full screen'} onClick={toggleExpanded}>
              <Glyph d={expanded ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
            </ToolBtn>
          </div>
        </div>
      </div>

      {note && <div className="chart-note sm" role="status"><Icon name="info" size={16} />{note}<button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setNote(null)}>Dismiss</button></div>}

      <div className="candle-chart" tabIndex={0} onKeyDown={onKey} aria-label="Price chart. Use plus and minus to zoom, 0 for the latest candles.">
        <div ref={box} className="candle-chart-canvas" />
        {shown && state === 'ready' && (
          <div className="ohlc num" aria-live="off">
            <span className="ohlc-time">{timeLabel(shown.time, interval)}</span>
            <span><b>O</b> {fmt(shown.open)}</span>
            <span><b>H</b> {fmt(shown.high)}</span>
            <span><b>L</b> {fmt(shown.low)}</span>
            <span><b>C</b> {fmt(shown.close)}</span>
            <span className={ch >= 0 ? 'pos' : 'neg'}>{ch >= 0 ? '+' : ''}{fmt(ch)} ({ch >= 0 ? '+' : ''}{chPct.toFixed(2)}%)</span>
          </div>
        )}
        {loadingOlder && state === 'ready' && <div className="chart-older t3 sm">Loading older candles…</div>}
        {state === 'loading' && <div className="candle-chart-cover t3">Loading chart…</div>}
        {state === 'error' && <div className="candle-chart-cover"><ErrorState error={error} retry={() => void load(true)} /></div>}
      </div>

      <p className="t3 sm">Times in IST. Zoom with − / + (or scroll, pinch, + / − keys), drag to pan, double-click the time axis to reset. Simulated prices and history for paper trading, not real market data.</p>
    </section>
  );
}

/* ======================================================================= calendar */

function CalendarPopover({ interval, today, onPick, onClose }: { interval: Interval; today: string; onPick: (fromMs: number, toMs: number, iv: Interval) => void; onClose: () => void }) {
  const [day, setDay] = useState(today);
  const ref = useRef<HTMLDivElement>(null);
  const yearAgo = istYmd(Date.now() - 365 * DAY_MS);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const now = Date.now();
  const startToday = istMidnight(today);
  const intraday: { label: string; from: number; iv: Interval }[] = [
    { label: 'Today', from: startToday, iv: interval === 'D1' ? 'M5' : interval },
    { label: 'Yesterday', from: startToday - DAY_MS, iv: interval === 'D1' ? 'M5' : interval },
    { label: '3 days', from: startToday - 2 * DAY_MS, iv: interval === 'D1' || interval === 'M1' ? 'M15' : interval },
  ];
  const daily: { label: string; from: number; iv: Interval }[] = [
    { label: '1 month', from: now - 30 * DAY_MS, iv: 'D1' },
    { label: '3 months', from: now - 91 * DAY_MS, iv: 'D1' },
    { label: '6 months', from: now - 182 * DAY_MS, iv: 'D1' },
    { label: '1 year', from: now - 365 * DAY_MS, iv: 'D1' },
  ];
  const go = () => {
    if (!day) return;
    const from = istMidnight(day);
    onPick(from, from + DAY_MS, interval);
  };
  return (
    <div ref={ref} className="chart-cal-pop" role="dialog" aria-label="Go to date">
      <label className="sm t2" htmlFor="chart-day">Go to date</label>
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input id="chart-day" className="input" type="date" value={day} min={yearAgo} max={today} onChange={(e) => setDay(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} style={{ flex: 1 }} />
        <button className="btn btn-primary btn-sm" onClick={go} disabled={!day}>Go</button>
      </div>
      <div className="chart-cal-h">Intraday</div>
      <div className="chart-cal-chips">{intraday.map((p) => <button key={p.label} type="button" className="chip" onClick={() => onPick(p.from, now, p.iv)}>{p.label}</button>)}</div>
      <div className="chart-cal-h">Daily</div>
      <div className="chart-cal-chips">{daily.map((p) => <button key={p.label} type="button" className="chip" onClick={() => onPick(p.from, now, p.iv)}>{p.label}</button>)}</div>
      <p className="sm t3">Minute candles cover the last few days. Older dates open in daily candles.</p>
    </div>
  );
}

/* ======================================================================= bits */

function ToolBtn({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="chart-btn" title={label} aria-label={label} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function rangeData(b: Bar[], up: string, down: string) {
  return b.map((x) => ({ time: x.time, value: x.high - x.low, color: hexA(x.close >= x.open ? up : down, 0.28) }));
}

/** "#08a77b" → "rgba(8,167,123,a)". Leaves other colour formats unchanged. */
function hexA(hex: string, a: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
}

function CandleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 1.5v2M4 10.5v2M10 2.5v2.5M10 11v1.5" />
      <rect x="2.5" y="3.5" width="3" height="7" rx="0.6" />
      <rect x="8.5" y="5" width="3" height="6" rx="0.6" fill="currentColor" />
    </svg>
  );
}
