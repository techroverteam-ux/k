'use client';
import { useEffect, useRef, useState } from 'react';
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { gql } from '@/lib/api';
import type { Interval, Trade } from '@/lib/algo';
import { Chips } from './ui';

/**
 * Backtest visuals: the equity curve (green above zero, red below), and the price candles of the tested
 * period with an arrow at every entry and exit. Times are shown in IST (shifted, like the main chart).
 */
const IST_S = 19_800;
const sec = (ms: number) => (Math.floor(ms / 1000) + IST_S) as UTCTimestamp;

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return { bg: v('--bg', '#fff'), text: v('--text-2', '#697080'), line: v('--line', '#ebedf0'), pos: v('--pos', '#08a77b'), neg: v('--neg', '#e14f3b'), info: v('--info', '#3a66d1') };
}

function baseChart(el: HTMLElement): IChartApi {
  const t = theme();
  return createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
    rightPriceScale: { borderColor: t.line },
    timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
    localization: { locale: 'en-IN', priceFormatter: (p: number) => p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
  });
}

export function BacktestCharts({ instrumentId, interval, from, to, trades, equity }: { instrumentId: string; interval: Interval; from: number; to: number; trades: Trade[]; equity: [number, number][] }) {
  const [view, setView] = useState<'equity' | 'trades'>('equity');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Chips label="Chart" value={view} onChange={setView} items={[{ v: 'equity', label: 'Equity curve' }, { v: 'trades', label: 'Trades on chart' }]} />
      <div className="bt-chart">
        {view === 'equity' ? <Equity equity={equity} /> : <TradesChart instrumentId={instrumentId} interval={interval} from={from} to={to} trades={trades} />}
      </div>
    </div>
  );
}

function Equity({ equity }: { equity: [number, number][] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const t = theme();
    const c = baseChart(box.current);
    const s = c.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: t.pos, topFillColor1: 'rgba(8,167,123,0.25)', topFillColor2: 'rgba(8,167,123,0.02)',
      bottomLineColor: t.neg, bottomFillColor1: 'rgba(225,79,59,0.02)', bottomFillColor2: 'rgba(225,79,59,0.25)',
      lineWidth: 2, priceLineVisible: false,
    });
    // Equity points can share a timestamp after downsampling; keep the last value per time.
    const pts = new Map<number, number>();
    for (const [ms, v] of equity) pts.set(sec(ms), v / 100);
    s.setData([...pts].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value })));
    c.timeScale().fitContent();
    return () => c.remove();
  }, [equity]);
  return <div ref={box} className="bt-canvas" role="img" aria-label="Equity curve of the backtest, in rupees" />;
}

function TradesChart({ instrumentId, interval, from, to, trades }: { instrumentId: string; interval: Interval; from: number; to: number; trades: Trade[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let chart: IChartApi | null = null;
    let alive = true;
    (async () => {
      try {
        // The tested candles (up to the most recent 1000 of them).
        type C = { t: number; open: string; high: string; low: string; close: string };
        const d = await gql<{ candles: C[] }>(`query($i:ID!,$v:CandleInterval!,$n:Int,$b:Float){ candles(instrumentId:$i, interval:$v, limit:$n, before:$b){ t open high low close } }`, { i: instrumentId, v: interval, n: 1000, b: to + 1 });
        if (!alive || !box.current) return;
        const bars = d.candles.filter((c) => c.t >= from);
        const t = theme();
        chart = baseChart(box.current);
        const s = chart.addSeries(CandlestickSeries, { upColor: t.pos, downColor: t.neg, borderVisible: false, wickUpColor: t.pos, wickDownColor: t.neg });
        s.setData(bars.map((b) => ({ time: sec(b.t), open: +b.open, high: +b.high, low: +b.low, close: +b.close })));
        const first = bars[0]?.t ?? from;
        const markers: SeriesMarker<Time>[] = [];
        for (const tr of trades) {
          const long = tr.side === 'LONG';
          if (tr.entryAt >= first) markers.push({ time: sec(tr.entryAt), position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: t.info });
          if (tr.exitAt >= first) markers.push({ time: sec(tr.exitAt), position: long ? 'aboveBar' : 'belowBar', shape: long ? 'arrowDown' : 'arrowUp', color: tr.pnl > 0 ? t.pos : t.neg, text: `${tr.pnl > 0 ? '+' : ''}${(tr.pnl / 100).toFixed(0)}` });
        }
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        createSeriesMarkers(s, markers);
        chart.timeScale().fitContent();
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; chart?.remove(); };
  }, [instrumentId, interval, from, to, trades]);
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div ref={box} className="bt-canvas" role="img" aria-label="Price candles of the tested period with entries and exits marked" />
      {state !== 'ready' && <div className="candle-chart-cover t3">{state === 'loading' ? 'Loading candles…' : 'Couldn’t load the candles.'}</div>}
    </div>
  );
}
