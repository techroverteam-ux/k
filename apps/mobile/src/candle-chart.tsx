/**
 * Trading-style price chart for the instrument screen (same features as the web chart).
 * - Candles or a close line; timeframes 1m / 5m / 15m / 1H / 1D; IST times.
 * - Drag sideways to pan, pinch to zoom (or the − / + buttons). Older candles load as you pan back.
 * - Tap or long-press to show a crosshair with the candle's date and O/H/L/C; drag to move it; tap again to hide.
 * - Calendar sheet: pick a day on a month grid, or a quick range. Old dates switch to daily candles.
 * - Full screen view. The forming candle updates live from the quote stream.
 * Built on react-native-svg and PanResponder, so it needs no extra native modules and also runs on web.
 * Prices and history come from the simulated feed in this build.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Platform, Pressable, View, useWindowDimensions, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { gql } from './api';
import { Icon, type IconName } from './icons';
import type { Quote } from './screens';
import { R, S, useTheme, type Theme } from './theme';
import { Chips, Row, Sheet, Spread, T } from './ui';

type Interval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
type Style = 'candles' | 'line';
interface Candle { t: number; open: string; high: string; low: string; close: string }
/** t = real epoch ms of the bucket start. */
interface Bar { t: number; o: number; h: number; l: number; c: number }

const IST_MS = 19_800_000;
const DAY = 86_400_000;
const STEP: Record<Interval, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, D1: DAY };
const LABEL: Record<Interval, string> = { M1: '1m', M5: '5m', M15: '15m', H1: '1H', D1: '1D' };
const PAGE = 500;
const START_COUNT = 60; // candles in view on load
const MIN_COUNT = 12;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const Q = `query($i:ID!,$v:CandleInterval!,$n:Int,$b:Float){ candles(instrumentId:$i, interval:$v, limit:$n, before:$b){ t open high low close } }`;
const AXIS_W = 58; // right price axis
const FONT = Platform.OS === 'web' ? 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : undefined;
const TIME_H = 18; // bottom time axis

const toBar = (c: Candle): Bar => ({ t: c.t, o: +c.open, h: +c.high, l: +c.low, c: +c.close });
const bucket = (ms: number, step: number) => Math.floor((ms + IST_MS) / step) * step - IST_MS;
const ist = (ms: number) => { const d = new Date(ms + IST_MS); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const two = (n: number) => String(n).padStart(2, '0');
const dateLabel = (ms: number) => { const p = ist(ms); return `${p.d} ${MONTHS[p.mo]} ${p.y}`; };
const whenLabel = (ms: number, iv: Interval) => { const p = ist(ms); return iv === 'D1' ? dateLabel(ms) : `${p.d} ${MONTHS[p.mo]}, ${two(p.h)}:${two(p.mi)}`; };
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const istMidnight = (y: number, mo: number, d: number) => Date.UTC(y, mo, d) - IST_MS;

export function CandleChart({ instrumentId, quote, tickSize }: { instrumentId: string; quote?: Quote; tickSize: number }) {
  const t = useTheme();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [interval, setIv] = useState<Interval>('M5');
  const [style, setStyle] = useState<Style>('candles');
  const [bars, setBars] = useState<Bar[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadedIv, setLoadedIv] = useState<Interval | null>(null); // timeframe of the candles in `bars`
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ end: 0, count: START_COUNT }); // end = index just past the right edge
  const [cross, setCross] = useState<number | null>(null); // bar index under the crosshair
  const [calOpen, setCalOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);
  const older = useRef({ busy: false, done: false });
  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;
  const pending = useRef<{ from: number; to: number } | null>(null);

  const fetchPage = useCallback(
    async (iv: Interval, before?: number) => (await gql<{ candles: Candle[] }>(Q, { i: instrumentId, v: iv, n: PAGE, b: before })).candles.map(toBar),
    [instrumentId],
  );

  const load = useCallback(async () => {
    const g = ++gen.current;
    setState('loading');
    setLoadedIv(null);
    setCross(null);
    older.current = { busy: false, done: false };
    try {
      const page = await fetchPage(interval);
      if (g !== gen.current) return;
      if (page.length < PAGE) older.current.done = true;
      setBars(page);
      setView({ end: page.length + 2, count: Math.min(START_COUNT, Math.max(MIN_COUNT, page.length)) });
      setError(null);
      setLoadedIv(interval);
      setState('ready');
    } catch (e) {
      if (g === gen.current) {
        setError((e as Error).message);
        setState('error');
      }
    }
  }, [fetchPage, interval]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Prepend one page of older candles, keeping the view on the same candles. */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const o = older.current;
    const first = barsRef.current[0];
    if (o.busy || o.done || !first) return false;
    o.busy = true;
    const g = gen.current;
    try {
      const page = await fetchPage(interval, first.t);
      if (g !== gen.current) return false;
      const fresh = page.filter((b) => b.t < first.t); // never overlap what's loaded
      if (page.length < PAGE) o.done = true;
      if (!fresh.length) { o.done = true; return false; }
      const merged = [...fresh, ...barsRef.current];
      barsRef.current = merged;
      setBars(merged);
      setView((v) => ({ ...v, end: v.end + fresh.length }));
      setCross((c) => (c === null ? c : c + fresh.length));
      return true;
    } catch {
      return false;
    } finally {
      o.busy = false;
    }
  }, [fetchPage, interval]);

  useEffect(() => {
    if (state === 'ready' && loadedIv === interval && view.end - view.count < 15) void loadOlder();
  }, [view, state, loadOlder, loadedIv, interval]);

  // Live: update the forming candle or start a new one.
  useEffect(() => {
    if (state !== 'ready' || loadedIv !== interval || !quote?.ltp) return;
    const price = Number(quote.ltp);
    const tb = bucket(Date.parse(quote.ts) || Date.now(), STEP[interval]);
    setBars((list) => {
      const last = list[list.length - 1];
      if (last && tb < last.t) return list;
      const atLatest = view.end >= list.length;
      const next = last && last.t === tb
        ? [...list.slice(0, -1), { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price }]
        : [...list, { t: tb, o: price, h: price, l: price, c: price }];
      if (next.length > list.length && atLatest) setView((v) => ({ ...v, end: v.end + 1 }));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.ltp, quote?.ts, interval, state]);

  // A date jump that needed a timeframe switch finishes once the new candles are in.
  useEffect(() => {
    if (state === 'ready' && loadedIv === interval && pending.current) {
      const p = pending.current;
      pending.current = null;
      void showRange(p.from, p.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, interval, loadedIv]);

  /* ------------------------------------------------------------ view controls */
  const zoom = (f: number) =>
    setView((v) => {
      const n = barsRef.current.length;
      const count = Math.min(Math.max(v.count * f, MIN_COUNT), Math.max(n + 4, MIN_COUNT));
      const latest = v.end >= n;
      const end = latest ? v.end : v.end - (v.count - count) / 2;
      return { end, count };
    });
  const latest = () => setView({ end: barsRef.current.length + 2, count: START_COUNT });

  async function showRange(from: number, to: number) {
    setCalOpen(false);
    if (interval !== 'D1') {
      // Is there anything for that day at this timeframe? One small request.
      const probe = await gql<{ candles: Candle[] }>(Q, { i: instrumentId, v: interval, n: 1, b: to }).catch(() => null);
      const covered = !probe || (probe.candles.length > 0 && probe.candles[0].t >= from);
      if (!covered) {
        setNote(`Intraday candles aren't kept that far back. Showing daily candles around ${dateLabel(from)}.`);
        pending.current = { from, to };
        setIv('D1');
        return;
      }
    }
    while (barsRef.current.length && barsRef.current[0].t > from) if (!(await loadOlder())) break;
    const list = barsRef.current;
    if (!list.length) return;
    let a = list.findIndex((b) => b.t >= from);
    let b = list.findIndex((x) => x.t >= to);
    if (a < 0) a = list.length - 1;
    if (b < 0) b = list.length;
    let count = Math.max(MIN_COUNT, b - a);
    if (interval === 'D1' && to - from <= DAY) { a = Math.max(0, a - 15); b = Math.min(list.length, b + 15); count = b - a; }
    setView({ end: a + count, count });
    setCross(null);
  }

  const pick = (from: number, to: number, iv: Interval) => {
    setNote(null);
    if (iv !== interval) {
      pending.current = { from, to };
      setCalOpen(false);
      setIv(iv);
    } else void showRange(from, to);
  };

  /* ------------------------------------------------------------ render */
  const chartH = full ? Math.max(260, win.height - insets.top - insets.bottom - 130) : Math.round(Math.min(Math.max(win.height * 0.42, 280), 440));
  const tools = (
    <View style={{ gap: S[2] }}>
      <Chips value={interval} onChange={(v) => { setNote(null); setIv(v); }} items={(Object.keys(LABEL) as Interval[]).map((k) => ({ k, label: LABEL[k] }))} />
      <Spread>
        <Row gap={S[1]}>
          <ToolBtn t={t} icon="candles" label="Candles" on={style === 'candles'} onPress={() => setStyle('candles')} />
          <ToolBtn t={t} icon="trend" label="Line" on={style === 'line'} onPress={() => setStyle('line')} />
        </Row>
        <Row gap={S[1]}>
          <ToolBtn t={t} icon="minus" label="Zoom out" onPress={() => zoom(1.4)} />
          <ToolBtn t={t} icon="plus" label="Zoom in" onPress={() => zoom(0.7)} />
          <ToolBtn t={t} icon="latest" label="Back to latest" onPress={latest} />
          <ToolBtn t={t} icon="calendar" label="Go to date" on={calOpen} onPress={() => setCalOpen(true)} />
          <ToolBtn t={t} icon={full ? 'collapse' : 'expand'} label={full ? 'Exit full screen' : 'Full screen'} onPress={() => setFull((f) => !f)} />
        </Row>
      </Spread>
      {note ? (
        <Pressable onPress={() => setNote(null)} accessibilityRole="button" accessibilityLabel="Dismiss note" style={{ flexDirection: 'row', gap: S[2], padding: S[2], borderRadius: R.md, backgroundColor: t.bg2 }}>
          <Icon name="info" size={16} color={t.text2} /><T v="xs" style={{ flex: 1 }}>{note}</T>
        </Pressable>
      ) : null}
    </View>
  );

  const body = (
    <Plot
      t={t}
      bars={bars}
      view={view}
      setView={setView}
      cross={cross}
      setCross={setCross}
      height={chartH}
      style={style}
      interval={interval}
      tick={tickSize}
      state={state}
      error={error}
      retry={() => void load()}
    />
  );

  return (
    <View style={{ gap: S[3] }}>
      {tools}
      {!full && body}
      <T v="xs">Times in IST. Drag to pan, pinch to zoom, tap for the crosshair. Simulated prices and history for paper trading, not real market data.</T>
      <Modal visible={full} animationType="fade" onRequestClose={() => setFull(false)} supportedOrientations={['portrait', 'landscape']}>
        <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + S[2], paddingBottom: insets.bottom + S[2], paddingHorizontal: S[3], gap: S[3] }}>
          {tools}
          {full && body}
        </View>
        <Calendar visible={calOpen && full} interval={interval} onClose={() => setCalOpen(false)} onPick={pick} />
      </Modal>
      <Calendar visible={calOpen && !full} interval={interval} onClose={() => setCalOpen(false)} onPick={pick} />
    </View>
  );
}

/* ======================================================================= plot */

function Plot(p: {
  t: Theme; bars: Bar[]; view: { end: number; count: number }; setView: (f: (v: { end: number; count: number }) => { end: number; count: number }) => void;
  cross: number | null; setCross: (c: number | null) => void; height: number; style: Style; interval: Interval; tick: number;
  state: 'loading' | 'ready' | 'error'; error: string | null; retry: () => void;
}) {
  const { t, bars, view, height, style, interval } = p;
  const [w, setW] = useState(0);
  const plotW = Math.max(1, w - AXIS_W);
  const plotH = height - TIME_H;
  const bw = plotW / view.count; // pixels per candle
  const startF = view.end - view.count;
  const from = Math.max(0, Math.floor(startF));
  const to = Math.min(bars.length, Math.ceil(view.end));
  const vis = bars.slice(from, to);
  const x = (i: number) => (i - startF + 0.5) * bw;

  const scale = useMemo(() => {
    if (!vis.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of vis) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    const pad = (hi - lo || hi * 0.001 || 1) * 0.08;
    lo -= pad; hi += pad;
    const priceH = plotH * 0.86; // bottom 14% holds the range bars
    const top = 40; // room for the OHLC legend above the highest candle
    return { lo, hi, y: (v: number) => top + ((hi - v) / (hi - lo)) * (priceH - top), priceH, maxRange: Math.max(...vis.map((b) => b.h - b.l)) || 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis.length ? vis[0] : null, vis.length ? vis[vis.length - 1] : null, vis.length, plotH, from, to, bars]);

  // ----- gestures: one finger pans (or moves the crosshair when it's on), two fingers pinch
  const g = useRef({ mode: 'none' as 'none' | 'pan' | 'pinch' | 'cross', x0: 0, end0: 0, count0: 0, dist0: 0, moved: false, longTimer: 0 as unknown as ReturnType<typeof setTimeout> });
  const live = useRef(p);
  live.current = p;
  const idxAt = (px: number) => {
    const { view: v, bars: b } = live.current;
    const pw = Math.max(1, wRef.current - AXIS_W);
    const i = Math.round((px / pw) * v.count + (v.end - v.count) - 0.5);
    return Math.max(0, Math.min(b.length - 1, i));
  };
  const wRef = useRef(0);
  wRef.current = w;
  const dist = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: (_e, s) => Math.abs(s.dx) > Math.abs(s.dy) || s.numberActiveTouches > 1,
        onPanResponderTerminationRequest: () => g.current.mode === 'none',
        onPanResponderGrant: (e) => {
          const s = g.current;
          const v = live.current.view;
          s.x0 = e.nativeEvent.locationX;
          s.end0 = v.end;
          s.count0 = v.count;
          s.moved = false;
          s.mode = live.current.cross !== null ? 'cross' : 'none';
          clearTimeout(s.longTimer);
          // Long-press turns the crosshair on even when it was off.
          s.longTimer = setTimeout(() => {
            if (!s.moved && s.mode === 'none') {
              s.mode = 'cross';
              live.current.setCross(idxAt(s.x0));
            }
          }, 350);
        },
        onPanResponderMove: (e, gs) => {
          const s = g.current;
          if (Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4) s.moved = true;
          if (gs.numberActiveTouches > 1) {
            const d = dist(e);
            if (s.mode !== 'pinch') { s.mode = 'pinch'; s.dist0 = d; s.count0 = live.current.view.count; s.end0 = live.current.view.end; return; }
            if (!s.dist0 || !d) return;
            const n = live.current.bars.length;
            const count = Math.min(Math.max((s.count0 * s.dist0) / d, MIN_COUNT), Math.max(n + 4, MIN_COUNT));
            const latest = s.end0 >= n;
            live.current.setView(() => ({ count, end: latest ? s.end0 : s.end0 - (s.count0 - count) / 2 }));
            return;
          }
          if (s.mode === 'cross') { live.current.setCross(idxAt(s.x0 + gs.dx)); return; }
          if (s.mode === 'none' && s.moved) s.mode = 'pan';
          if (s.mode === 'pan') {
            const pw = Math.max(1, wRef.current - AXIS_W);
            const per = pw / s.count0;
            const n = live.current.bars.length;
            const end = Math.min(Math.max(s.end0 - gs.dx / per, Math.min(s.count0, n)), n + s.count0 * 0.5);
            live.current.setView((v) => ({ ...v, end }));
          }
        },
        onPanResponderRelease: () => {
          const s = g.current;
          clearTimeout(s.longTimer);
          // A plain tap toggles the crosshair.
          if (!s.moved && s.mode !== 'pinch') {
            if (live.current.cross !== null && s.mode === 'cross') live.current.setCross(null);
            else if (s.mode === 'none') live.current.setCross(idxAt(s.x0));
          }
          s.mode = 'none';
        },
        onPanResponderTerminate: () => {
          clearTimeout(g.current.longTimer);
          g.current.mode = 'none';
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const lastBar = bars[bars.length - 1];
  const shown = p.cross !== null ? bars[p.cross] : lastBar;
  const ch = shown ? shown.c - shown.o : 0;

  // axis ticks
  const priceTicks = scale ? niceTicks(scale.lo, scale.hi, 5) : [];
  const timeTicks: number[] = [];
  if (vis.length) {
    const every = Math.max(1, Math.round(vis.length / Math.max(2, Math.floor(plotW / 90))));
    for (let i = from; i < to; i++) if ((i - from) % every === Math.floor(every / 2)) timeTicks.push(i);
  }
  const spanMs = vis.length ? vis[vis.length - 1].t - vis[0].t : 0;
  const tickLabel = (i: number, k: number) => {
    const q = ist(bars[i].t);
    const prevI = timeTicks[k - 1];
    const prev = prevI !== undefined ? ist(bars[prevI].t) : null;
    if (interval === 'D1') {
      if (spanMs > 120 * DAY) return q.mo === 0 || (prev && prev.y !== q.y) ? String(q.y) : MONTHS[q.mo];
      return `${q.d} ${MONTHS[q.mo]}`;
    }
    return !prev || prev.d !== q.d ? `${q.d} ${MONTHS[q.mo]}` : `${two(q.h)}:${two(q.mi)}`;
  };

  return (
    <View style={{ height, borderWidth: 1, borderColor: t.line, borderRadius: R.lg, overflow: 'hidden', backgroundColor: t.bg }} onLayout={onLayout} {...responder.panHandlers}
      accessibilityLabel={shown ? `Price chart, ${LABEL[interval]} candles. Latest ${fmt(lastBar?.c ?? 0)}.` : 'Price chart'}>
      {w > 0 && scale && p.state === 'ready' ? (
        <Svg width={w} height={height}>
          {/* grid + price labels */}
          {priceTicks.map((v) => (
            <G key={`p${v}`}>
              <Line x1={0} x2={plotW} y1={scale.y(v)} y2={scale.y(v)} stroke={t.line} strokeWidth={1} />
              <SvgText fontFamily={FONT} x={plotW + 6} y={scale.y(v) + 4} fontSize={10} fill={t.text3}>{fmt(v)}</SvgText>
            </G>
          ))}
          {timeTicks.map((i, k) => (
            <G key={`t${i}`}>
              <Line x1={x(i)} x2={x(i)} y1={0} y2={plotH} stroke={t.line} strokeWidth={1} />
              <SvgText fontFamily={FONT} x={x(i)} y={height - 5} fontSize={10} fill={t.text3} textAnchor="middle">{tickLabel(i, k)}</SvgText>
            </G>
          ))}
          <Line x1={plotW} x2={plotW} y1={0} y2={height} stroke={t.line} />
          <Line x1={0} x2={w} y1={plotH} y2={plotH} stroke={t.line} />
          {/* range bars (high − low) along the bottom */}
          {vis.map((b, k) => {
            const i = from + k;
            const rh = ((b.h - b.l) / scale.maxRange) * (plotH * 0.12);
            return <Rect key={`r${b.t}`} x={x(i) - Math.max(1, bw * 0.35)} y={plotH - rh} width={Math.max(1, bw * 0.7)} height={rh} fill={b.c >= b.o ? t.pos : t.neg} opacity={0.22} />;
          })}
          {style === 'candles' ? (
            vis.map((b, k) => {
              const i = from + k;
              const up = b.c >= b.o;
              const col = up ? t.pos : t.neg;
              const top = scale.y(Math.max(b.o, b.c));
              const bodyH = Math.max(1, Math.abs(scale.y(b.o) - scale.y(b.c)));
              const cw = Math.max(1, bw * 0.68);
              return (
                <G key={`c${b.t}`}>
                  <Line x1={x(i)} x2={x(i)} y1={scale.y(b.h)} y2={scale.y(b.l)} stroke={col} strokeWidth={1} />
                  <Rect x={x(i) - cw / 2} y={top} width={cw} height={bodyH} fill={col} />
                </G>
              );
            })
          ) : (
            <Path d={vis.map((b, k) => `${k ? 'L' : 'M'}${x(from + k).toFixed(1)},${scale.y(b.c).toFixed(1)}`).join(' ')} stroke={t.brand} strokeWidth={2} fill="none" strokeLinejoin="round" />
          )}
          {/* last price line + label */}
          {lastBar && (() => {
            const y = Math.min(Math.max(scale.y(lastBar.c), 8), scale.priceH);
            const col = lastBar.c >= lastBar.o ? t.pos : t.neg;
            return (
              <G>
                <Line x1={0} x2={plotW} y1={y} y2={y} stroke={col} strokeDasharray="2 3" strokeWidth={1} />
                <Rect x={plotW + 1} y={y - 9} width={AXIS_W - 2} height={18} rx={3} fill={col} />
                <SvgText fontFamily={FONT} x={plotW + 5} y={y + 4} fontSize={10} fontWeight="600" fill="#fff">{fmt(lastBar.c)}</SvgText>
              </G>
            );
          })()}
          {/* crosshair */}
          {p.cross !== null && bars[p.cross] && p.cross >= from && p.cross < to && (
            <G>
              <Line x1={x(p.cross)} x2={x(p.cross)} y1={0} y2={plotH} stroke={t.text3} strokeDasharray="3 3" />
              <Line x1={0} x2={plotW} y1={scale.y(bars[p.cross].c)} y2={scale.y(bars[p.cross].c)} stroke={t.text3} strokeDasharray="3 3" />
              <Rect x={Math.min(Math.max(x(p.cross) - 46, 0), plotW - 92)} y={plotH + 1} width={92} height={TIME_H - 2} rx={3} fill={t.text2} />
              <SvgText fontFamily={FONT} x={Math.min(Math.max(x(p.cross), 46), plotW - 46)} y={height - 5} fontSize={10} fill={t.bg} textAnchor="middle">{whenLabel(bars[p.cross].t, interval)}</SvgText>
            </G>
          )}
        </Svg>
      ) : null}

      {/* legend */}
      {shown && p.state === 'ready' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, left: 8, right: AXIS_W + 4, flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 0 }}>
          <T v="xs" c="text2" w="600">{whenLabel(shown.t, interval)}</T>
          <T v="xs">O {fmt(shown.o)}</T>
          <T v="xs">H {fmt(shown.h)}</T>
          <T v="xs">L {fmt(shown.l)}</T>
          <T v="xs">C {fmt(shown.c)}</T>
          <T v="xs" c={ch >= 0 ? 'pos' : 'neg'}>{ch >= 0 ? '+' : ''}{fmt(ch)} ({ch >= 0 ? '+' : ''}{shown.o ? ((ch / shown.o) * 100).toFixed(2) : '0.00'}%)</T>
        </View>
      ) : null}
      {p.state === 'loading' && <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}><T v="sm" c="text2">Loading chart…</T></View>}
      {p.state === 'error' && (
        <Pressable onPress={p.retry} accessibilityRole="button" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: S[2], padding: S[4] }}>
          <T v="sm" c="neg">Couldn't load the chart.</T>
          <T v="xs">{p.error ?? ''}</T>
          <T v="sm" c="brand" w="600">Tap to try again</T>
        </Pressable>
      )}
    </View>
  );
}

function every1(i: number, bars: Bar[]) {
  const prev = bars[i - 1];
  return !!prev && ist(prev.t).mo !== ist(bars[i].t).mo;
}

/** Round price-axis ticks (1 / 2 / 2.5 / 5 × 10^n). */
function niceTicks(lo: number, hi: number, n: number) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/* ======================================================================= toolbar */

type ToolIcon = IconName | 'candles' | 'minus' | 'latest' | 'expand' | 'collapse';
const GLYPH: Partial<Record<ToolIcon, string>> = {
  minus: 'M5 12h14',
  latest: 'M13 6l6 6-6 6M5 6l6 6-6 6',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  candles: 'M7 3v3M7 17v4M17 4v4M17 18v3M5 6h4v11H5zM15 8h4v10h-4z',
};

function ToolBtn({ t, icon, label, onPress, on }: { t: Theme; icon: ToolIcon; label: string; onPress: () => void; on?: boolean }) {
  const d = GLYPH[icon];
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!on }} hitSlop={4}
      style={({ pressed }) => ({ width: 36, height: 34, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: on ? t.brand : t.line2, backgroundColor: on ? t.brandSoft : pressed ? t.bg3 : t.bg })}>
      {d ? (
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={on ? t.brand : t.text2} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d={d} /></Svg>
      ) : (
        <Icon name={icon as IconName} size={16} color={on ? t.brand : t.text2} strokeWidth={2} />
      )}
    </Pressable>
  );
}

/* ======================================================================= calendar */

function Calendar({ visible, interval, onPick, onClose }: { visible: boolean; interval: Interval; onPick: (from: number, to: number, iv: Interval) => void; onClose: () => void }) {
  const t = useTheme();
  const now = Date.now();
  const today = ist(now);
  const [month, setMonth] = useState({ y: today.y, mo: today.mo });
  const [sel, setSel] = useState<{ y: number; mo: number; d: number } | null>(null);
  useEffect(() => {
    if (visible) { setMonth({ y: today.y, mo: today.mo }); setSel(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const earliest = now - 365 * DAY;
  const first = new Date(Date.UTC(month.y, month.mo, 1)).getUTCDay(); // 0 = Sunday
  const days = new Date(Date.UTC(month.y, month.mo + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, k) => k + 1)];
  while (cells.length % 7) cells.push(null);
  const canPrev = istMidnight(month.y, month.mo, 1) > earliest;
  const canNext = month.y < today.y || (month.y === today.y && month.mo < today.mo);
  const shift = (n: number) => setMonth((m) => { const d = new Date(Date.UTC(m.y, m.mo + n, 1)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() }; });
  const startToday = istMidnight(today.y, today.mo, today.d);
  const intraIv: Interval = interval === 'D1' ? 'M5' : interval;
  const quick: { label: string; from: number; iv: Interval }[] = [
    { label: 'Today', from: startToday, iv: intraIv },
    { label: 'Yesterday', from: startToday - DAY, iv: intraIv },
    { label: '3 days', from: startToday - 2 * DAY, iv: interval === 'D1' || interval === 'M1' ? 'M15' : interval },
    { label: '1 month', from: now - 30 * DAY, iv: 'D1' },
    { label: '3 months', from: now - 91 * DAY, iv: 'D1' },
    { label: '6 months', from: now - 182 * DAY, iv: 'D1' },
    { label: '1 year', from: now - 365 * DAY, iv: 'D1' },
  ];
  const cellW = `${100 / 7}%` as const;
  return (
    <Sheet visible={visible} title="Go to date" sub="Times are IST" onClose={onClose}>
      <Spread>
        <Pressable onPress={() => canPrev && shift(-1)} disabled={!canPrev} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8} style={{ opacity: canPrev ? 1 : 0.3, padding: S[2] }}>
          <Icon name="chevronLeft" size={20} color={t.text} />
        </Pressable>
        <T v="h3">{MONTHS[month.mo]} {month.y}</T>
        <Pressable onPress={() => canNext && shift(1)} disabled={!canNext} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={8} style={{ opacity: canNext ? 1 : 0.3, padding: S[2] }}>
          <Icon name="chevronRight" size={20} color={t.text} />
        </Pressable>
      </Spread>
      <View>
        <View style={{ flexDirection: 'row' }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, k) => <View key={k} style={{ width: cellW, alignItems: 'center', paddingVertical: 4 }}><T v="xs" c="text3">{d}</T></View>)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {cells.map((d, k) => {
            if (d === null) return <View key={k} style={{ width: cellW, height: 40 }} />;
            const ms = istMidnight(month.y, month.mo, d);
            const disabled = ms > now || ms + DAY < earliest;
            const isToday = ms === startToday;
            const on = sel && sel.y === month.y && sel.mo === month.mo && sel.d === d;
            return (
              <Pressable key={k} disabled={disabled} onPress={() => setSel({ y: month.y, mo: month.mo, d })} accessibilityRole="button"
                accessibilityLabel={`${d} ${MONTHS[month.mo]} ${month.y}`} accessibilityState={{ selected: !!on, disabled }}
                style={{ width: cellW, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.brand : 'transparent', borderWidth: isToday && !on ? 1 : 0, borderColor: t.brand, opacity: disabled ? 0.3 : 1 }}>
                  <T v="sm" w={on || isToday ? '600' : '400'} style={{ color: on ? t.brandInk : t.text }}>{String(d)}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Pressable disabled={!sel} onPress={() => sel && onPick(istMidnight(sel.y, sel.mo, sel.d), istMidnight(sel.y, sel.mo, sel.d) + DAY, interval)} accessibilityRole="button"
        style={({ pressed }) => ({ height: 44, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: sel ? (pressed ? t.brandPressed : t.brand) : t.bg3 })}>
        <T v="body" w="600" style={{ color: sel ? t.brandInk : t.text3 }}>{sel ? `Show ${sel.d} ${MONTHS[sel.mo]} ${sel.y}` : 'Pick a day'}</T>
      </Pressable>
      <T v="xs" c="text3">Quick ranges</T>
      <Row gap={S[2]} style={{ flexWrap: 'wrap' }}>
        {quick.map((q) => (
          <Pressable key={q.label} onPress={() => onPick(q.from, now, q.iv)} accessibilityRole="button"
            style={({ pressed }) => ({ height: 34, paddingHorizontal: S[3], borderRadius: R.pill, borderWidth: 1, borderColor: t.line2, backgroundColor: pressed ? t.bg3 : t.bg, justifyContent: 'center' })}>
            <T v="sm" c="text2" w="500">{q.label}</T>
          </Pressable>
        ))}
      </Row>
      <T v="xs">Minute candles cover the last few days. Older dates open in daily candles.</T>
    </Sheet>
  );
}
