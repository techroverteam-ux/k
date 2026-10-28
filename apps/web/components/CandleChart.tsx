'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { gql } from '@/lib/api';
import { Icon } from './icons';
import type { Quote } from './trading';
import { Chips, ErrorState } from './ui';

/**
 * Trading-style price chart: OHLC candles (or a close line), timeframes, crosshair with an OHLC legend,
 * zoom and pan, live updates of the forming candle from the quote stream.
 * Times are shown in IST. Prices and history come from the simulated feed in this build.
 */

type Interval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
type Style = 'candles' | 'line';
interface Candle { t: number; open: string; high: string; low: string; close: string }
interface Bar { time: UTCTimestamp; open: number; high: number; low: number; close: number }

const IST_S = 19_800; // UTC+05:30 in seconds. The chart renders UTC, so times are shifted to read as IST.
const STEP_MS: Record<Interval, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, D1: 86_400_000 };
const VISIBLE = 120; // candles in view on load; zoom out to see the rest
const LIMIT = 500;
const Q = `query($i:ID!,$v:CandleInterval!,$n:Int){ candles(instrumentId:$i, interval:$v, limit:$n){ t open high low close } }`;

const toBar = (c: Candle): Bar => ({ time: (Math.floor(c.t / 1000) + IST_S) as UTCTimestamp, open: +c.open, high: +c.high, low: +c.low, close: +c.close });
const bucketSec = (ms: number, step: number) => (Math.floor((ms + IST_S * 1000) / step) * step) / 1000; // already IST-shifted
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const [interval, setIntervalV] = useState<Interval>('M5');
  const [style, setStyle] = useState<Style>('candles');
  const [last, setLast] = useState<Bar | null>(null);
  const [hover, setHover] = useState<Bar | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  // Create the chart once.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const t = theme();
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontFamily: t.font, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.08, bottom: 0.14 } },
      timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 9, minBarSpacing: 2 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.cross, labelBackgroundColor: t.text }, horzLine: { color: t.cross, labelBackgroundColor: t.text } },
      localization: { locale: 'en-IN', priceFormatter: fmt },
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
  }, [tickSize]);

  // Load history for the instrument and timeframe.
  const load = useCallback(
    async (fit: boolean) => {
      if (fit) setState('loading');
      try {
        const d = await gql<{ candles: Candle[] }>(Q, { i: instrumentId, v: interval, n: LIMIT });
        const b = d.candles.map(toBar);
        bars.current = b;
        const t = theme();
        candles.current?.setData(b);
        line.current?.setData(b.map((x) => ({ time: x.time, value: x.close })));
        range.current?.setData(rangeData(b, t.pos, t.neg));
        if (fit && b.length) chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, b.length - VISIBLE), to: b.length + 4 });
        setLast(b[b.length - 1] ?? null);
        setError(null);
        setState('ready');
      } catch (e) {
        if (fit) {
          setError(e as { message: string; code?: string });
          setState('error');
        }
      }
    },
    [instrumentId, interval],
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

  const shown = hover ?? last;
  const ch = shown ? shown.close - shown.open : 0;
  const chPct = shown && shown.open ? (ch / shown.open) * 100 : 0;

  return (
    <section className="section" aria-label="Price chart">
      <div className="spread chart-tools">
        <Chips label="Timeframe" value={interval} onChange={setIntervalV} items={[
          { v: 'M1', label: '1m' },
          { v: 'M5', label: '5m' },
          { v: 'M15', label: '15m' },
          { v: 'H1', label: '1H' },
          { v: 'D1', label: '1D' },
        ]} />
        <Chips label="Chart type" value={style} onChange={setStyle} items={[
          { v: 'candles', label: <span className="row" style={{ gap: 6 }}><CandleGlyph />Candles</span> },
          { v: 'line', label: <span className="row" style={{ gap: 6 }}><Icon name="trend" size={14} />Line</span> },
        ]} />
      </div>

      <div className="candle-chart">
        <div ref={box} className="candle-chart-canvas" role="img" aria-label={shown ? `Price chart. Latest ${fmt(shown.close)}.` : 'Price chart'} />
        {shown && state === 'ready' && (
          <div className="ohlc num" aria-live="off">
            <span><b>O</b> {fmt(shown.open)}</span>
            <span><b>H</b> {fmt(shown.high)}</span>
            <span><b>L</b> {fmt(shown.low)}</span>
            <span><b>C</b> {fmt(shown.close)}</span>
            <span className={ch >= 0 ? 'pos' : 'neg'}>{ch >= 0 ? '+' : ''}{fmt(ch)} ({ch >= 0 ? '+' : ''}{chPct.toFixed(2)}%)</span>
          </div>
        )}
        {state === 'loading' && <div className="candle-chart-cover t3">Loading chart…</div>}
        {state === 'error' && <div className="candle-chart-cover"><ErrorState error={error} retry={() => void load(true)} /></div>}
      </div>

      <p className="t3 sm">Times in IST. Scroll or pinch to zoom, drag to pan. Simulated prices and history for paper trading, not real market data.</p>
    </section>
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
