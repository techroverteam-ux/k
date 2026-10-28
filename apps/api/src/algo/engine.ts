import type { Bar } from '../market/candles';
import type { Condition, Operand, Rules } from './rules';

/**
 * Strategy engine shared by the backtester and the live runner, so a backtest and a live run of the same
 * rules make the same decisions on the same candles.
 *
 * Signals are evaluated on CLOSED candles, in rupees (so "Close is above 25000" means ₹25,000; RSI is 0–100).
 * Money (fills, P&L, fees) stays in integer paise.
 */

export type Series = (number | null)[];

// ------------------------------------------------------------------ indicators
export function sma(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; // seeded with the SMA
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) out[i] = e = v[i] * k + e * (1 - k);
  return out;
}

/** Wilder's RSI. */
export function rsi(v: number[], n: number): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function bollinger(v: number[], n: number, mult: number, band: 'upper' | 'middle' | 'lower'): Series {
  const mid = sma(v, n);
  return mid.map((m, i) => {
    if (m === null) return null;
    if (band === 'middle') return m;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m) ** 2;
    const sd = Math.sqrt(s / n);
    return band === 'upper' ? m + mult * sd : m - mult * sd;
  });
}

/** Indicator values for every candle; prices in rupees. Cached per operand. */
export class Indicators {
  private cache = new Map<string, Series>();
  private readonly close: number[];
  constructor(private readonly bars: Bar[]) {
    this.close = bars.map((b) => b.c / 100);
  }
  series(o: Operand): Series {
    const key = JSON.stringify(o);
    let s = this.cache.get(key);
    if (s) return s;
    switch (o.type) {
      case 'price': s = this.bars.map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c })[o.field] / 100); break;
      case 'sma': s = sma(this.close, o.period); break;
      case 'ema': s = ema(this.close, o.period); break;
      case 'rsi': s = rsi(this.close, o.period); break;
      case 'bb': s = bollinger(this.close, o.period, o.mult, o.band); break;
      case 'number': s = this.bars.map(() => o.value); break;
    }
    this.cache.set(key, s);
    return s;
  }
}

/** Is the condition true on candle i (a closed candle)? Needs values for i and, for crosses, i − 1. */
export function holds(ind: Indicators, c: Condition, i: number): boolean {
  const L = ind.series(c.left), R = ind.series(c.right);
  const l = L[i], r = R[i];
  if (l === null || r === null) return false;
  if (c.op === 'above') return l > r;
  if (c.op === 'below') return l < r;
  const lp = L[i - 1], rp = R[i - 1];
  if (lp === null || rp === null || lp === undefined || rp === undefined) return false;
  return c.op === 'crossesAbove' ? lp <= rp && l > r : lp >= rp && l < r;
}

export const entrySignal = (ind: Indicators, rules: Rules, i: number) => rules.entry.every((c) => holds(ind, c, i));
export const exitSignal = (ind: Indicators, rules: Rules, i: number) => rules.exit.some((c) => holds(ind, c, i));

/** Stop-loss / take-profit prices (paise) for a position entered at `entry`. */
export function stopLevels(rules: Rules, entry: number) {
  const long = rules.side === 'LONG';
  const sl = rules.stopLossPct === undefined ? null : Math.round(entry * (1 + ((long ? -1 : 1) * rules.stopLossPct) / 100));
  const tp = rules.takeProfitPct === undefined ? null : Math.round(entry * (1 + ((long ? 1 : -1) * rules.takeProfitPct) / 100));
  return { sl, tp };
}

// ------------------------------------------------------------------ backtest
export interface BacktestTrade {
  side: 'LONG' | 'SHORT';
  entryAt: number;
  entryPrice: number; // paise
  exitAt: number;
  exitPrice: number;
  reason: 'EXIT_RULE' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END';
  pnl: number; // paise, after fees
  fees: number;
  bars: number;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  netPnl: number; // paise
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number; // paise, on the mark-to-market equity curve
  maxConsecutiveLosses: number;
  fees: number;
  exposurePct: number; // % of candles in a position
  buyHoldPnl: number; // paise: buying `quantity` at the first candle and holding to the last
  sharpePerTrade: number | null;
  candles: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  /** [time ms, equity paise] mark-to-market, downsampled. */
  equity: [number, number][];
}

/**
 * Simulates the rules on candles (oldest first).
 * - A signal on candle i's close fills at candle i+1's open (no look-ahead).
 * - Stop-loss / take-profit are checked intrabar on later candles. A gap through the level fills at the open.
 *   If both levels fall inside one candle, the stop-loss is assumed to hit first (the cautious choice).
 * - Brokerage is charged per side at `feeBps` of turnover, like the platform's own fills.
 * - A position still open at the end is closed at the last close and marked "END".
 */
export function backtest(bars: Bar[], rules: Rules, quantity: number, feeBps: number, startIndex = 0): BacktestResult {
  const ind = new Indicators(bars);
  const long = rules.side === 'LONG';
  const dir = long ? 1 : -1;
  const fee = (px: number) => Math.round((px * quantity * feeBps) / 10_000);
  const trades: BacktestTrade[] = [];
  const equity: [number, number][] = [];
  let realized = 0;
  let pos: { entryAt: number; entryPrice: number; entryIdx: number; sl: number | null; tp: number | null; feeIn: number } | null = null;
  let pendingEntry = false;
  let pendingExit = false;
  let inPosBars = 0;
  let peak = 0, maxDd = 0;

  const close = (i: number, price: number, at: number, reason: BacktestTrade['reason']) => {
    const p = pos!;
    const fees = p.feeIn + fee(price);
    const pnl = dir * (price - p.entryPrice) * quantity - fees;
    realized += pnl;
    trades.push({ side: rules.side, entryAt: p.entryAt, entryPrice: p.entryPrice, exitAt: at, exitPrice: price, reason, pnl, fees, bars: i - p.entryIdx + 1 });
    pos = null;
  };

  for (let i = Math.max(1, startIndex); i < bars.length; i++) {
    const b = bars[i];
    // 1) orders decided on the previous close fill at this open
    if (pendingExit && pos) close(i, b.o, b.t, 'EXIT_RULE');
    if (pendingEntry && !pos) {
      const { sl, tp } = stopLevels(rules, b.o);
      pos = { entryAt: b.t, entryPrice: b.o, entryIdx: i, sl, tp, feeIn: fee(b.o) };
    }
    pendingEntry = pendingExit = false;
    // 2) stop-loss / take-profit inside this candle
    if (pos) {
      const p: NonNullable<typeof pos> = pos;
      const slHit = p.sl !== null && (long ? b.l <= p.sl : b.h >= p.sl);
      const tpHit = p.tp !== null && (long ? b.h >= p.tp : b.l <= p.tp);
      if (slHit) close(i, long ? Math.min(b.o, p.sl!) : Math.max(b.o, p.sl!), b.t, 'STOP_LOSS');
      else if (tpHit) close(i, long ? Math.max(b.o, p.tp!) : Math.min(b.o, p.tp!), b.t, 'TAKE_PROFIT');
    }
    if (pos) inPosBars++;
    // 3) signals on this candle's close
    if (pos) pendingExit = exitSignal(ind, rules, i);
    else pendingEntry = i < bars.length - 1 && entrySignal(ind, rules, i);
    // mark-to-market equity
    const open = pos ? dir * (b.c - pos.entryPrice) * quantity - pos.feeIn : 0;
    const eq = realized + open;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    equity.push([b.t, eq]);
  }
  if (pos && bars.length) {
    const last = bars[bars.length - 1];
    close(bars.length - 1, last.c, last.t, 'END');
    if (equity.length) equity[equity.length - 1] = [last.t, realized];
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  let streak = 0, maxStreak = 0;
  for (const t of trades) { streak = t.pnl <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const mean = trades.length ? realized / trades.length : 0;
  const sd = trades.length > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / (trades.length - 1)) : 0;
  const first = bars[Math.max(1, startIndex)] ?? bars[0];
  const last = bars[bars.length - 1];
  const counted = Math.max(1, bars.length - Math.max(1, startIndex));

  return {
    trades,
    equity: downsample(equity, 600),
    metrics: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      netPnl: realized,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      avgWin: wins.length ? Math.round(grossProfit / wins.length) : 0,
      avgLoss: losses.length ? -Math.round(grossLoss / losses.length) : 0,
      largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
      largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
      maxDrawdown: maxDd,
      maxConsecutiveLosses: maxStreak,
      fees: trades.reduce((a, t) => a + t.fees, 0),
      exposurePct: (inPosBars / counted) * 100,
      buyHoldPnl: first && last ? (last.c - first.o) * quantity : 0,
      sharpePerTrade: sd > 0 ? (mean / sd) * Math.sqrt(trades.length) : null,
      candles: counted,
    },
  };
}

function downsample(pts: [number, number][], max: number): [number, number][] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: [number, number][] = [];
  for (let k = 0; k < max; k++) out.push(pts[Math.floor(k * step)]);
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}
