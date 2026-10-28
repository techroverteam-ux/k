/** Automated trading (paper): rule types, templates and labels shared by the strategy screens. */

export type Interval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
export type Operand =
  | { type: 'price'; field: 'open' | 'high' | 'low' | 'close' }
  | { type: 'sma' | 'ema'; period: number }
  | { type: 'rsi'; period: number }
  | { type: 'bb'; band: 'upper' | 'middle' | 'lower'; period: number; mult: number }
  | { type: 'number'; value: number };
export type Op = 'crossesAbove' | 'crossesBelow' | 'above' | 'below';
export interface Condition { left: Operand; op: Op; right: Operand }
export interface Rules { side: 'LONG' | 'SHORT'; entry: Condition[]; exit: Condition[]; stopLossPct?: number; takeProfitPct?: number }

export interface Strategy {
  id: string; name: string; instrumentId: string; interval: Interval; rules: string; quantity: number; version: number;
  status: 'DRAFT' | 'RUNNING' | 'STOPPED'; maxDailyLoss: string; maxOrdersPerDay: number; position: number; entryPrice?: string;
  entryAt?: string; startedAt?: string; stoppedAt?: string; stopReason?: string; updatedAt: string;
  instrument?: { id: string; symbol: string; name: string; exchange: string; segment: string; lotSize: number; tickSize: string } | null;
  today?: { pnl: string; orders: number };
}
export const STRATEGY_FIELDS = 'id name instrumentId interval rules quantity version status maxDailyLoss maxOrdersPerDay position entryPrice entryAt startedAt stoppedAt stopReason updatedAt instrument { id symbol name exchange segment lotSize tickSize } today { pnl orders }';

export interface Metrics {
  trades: number; wins: number; losses: number; winRate: number; netPnl: number; grossProfit: number; grossLoss: number; profitFactor: number | null;
  avgWin: number; avgLoss: number; largestWin: number; largestLoss: number; maxDrawdown: number; maxConsecutiveLosses: number; fees: number;
  exposurePct: number; buyHoldPnl: number; sharpePerTrade: number | null; candles: number;
}
export interface Trade { side: 'LONG' | 'SHORT'; entryAt: number; entryPrice: number; exitAt: number; exitPrice: number; reason: 'EXIT_RULE' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END'; pnl: number; fees: number; bars: number }
export interface Run { id: string; version: number; interval: Interval; from: string; to: string; quantity: number; metrics: string; trades: string; equity: string; createdAt: string }
export const RUN_FIELDS = 'id version interval from to quantity metrics trades equity createdAt';

export const INTERVALS: { v: Interval; label: string }[] = [
  { v: 'M1', label: '1m' }, { v: 'M5', label: '5m' }, { v: 'M15', label: '15m' }, { v: 'H1', label: '1H' }, { v: 'D1', label: '1D' },
];
/** Backtest periods that make sense for each candle size (minute history is kept for 30 days). */
export const PERIODS: Record<Interval, { days: number; label: string }[]> = {
  M1: [{ days: 1, label: '1 day' }, { days: 3, label: '3 days' }, { days: 7, label: '7 days' }],
  M5: [{ days: 3, label: '3 days' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }],
  M15: [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }],
  H1: [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }],
  D1: [{ days: 91, label: '3 months' }, { days: 182, label: '6 months' }, { days: 365, label: '1 year' }],
};

export const OPERAND_TYPES: { v: Operand['type']; label: string }[] = [
  { v: 'price', label: 'Price' }, { v: 'ema', label: 'EMA' }, { v: 'sma', label: 'SMA' }, { v: 'rsi', label: 'RSI' }, { v: 'bb', label: 'Bollinger band' }, { v: 'number', label: 'Value' },
];
export const OPS: { v: Op; label: string }[] = [
  { v: 'crossesAbove', label: 'crosses above' }, { v: 'crossesBelow', label: 'crosses below' }, { v: 'above', label: 'is above' }, { v: 'below', label: 'is below' },
];

export function defaultOperand(type: Operand['type']): Operand {
  switch (type) {
    case 'price': return { type, field: 'close' };
    case 'ema': return { type, period: 21 };
    case 'sma': return { type, period: 20 };
    case 'rsi': return { type, period: 14 };
    case 'bb': return { type, band: 'upper', period: 20, mult: 2 };
    case 'number': return { type, value: 50 };
  }
}

export function operandLabel(o: Operand): string {
  switch (o.type) {
    case 'price': return o.field[0].toUpperCase() + o.field.slice(1);
    case 'sma': return `SMA(${o.period})`;
    case 'ema': return `EMA(${o.period})`;
    case 'rsi': return `RSI(${o.period})`;
    case 'bb': return `Bollinger ${o.band} (${o.period}, ${o.mult})`;
    case 'number': return String(o.value);
  }
}
export const conditionLabel = (c: Condition) => `${operandLabel(c.left)} ${OPS.find((o) => o.v === c.op)!.label} ${operandLabel(c.right)}`;

/** One-sentence description of the whole strategy. */
export function describe(r: Rules, qty: number, symbol: string): string {
  const act = r.side === 'LONG' ? 'Buy' : 'Sell';
  const parts = [`${act} ${qty} ${symbol} when ${r.entry.map(conditionLabel).join(' and ') || '…'}.`];
  const exits = [...r.exit.map(conditionLabel)];
  if (r.stopLossPct !== undefined) exits.push(`price moves ${r.stopLossPct}% against the trade (stop-loss)`);
  if (r.takeProfitPct !== undefined) exits.push(`price moves ${r.takeProfitPct}% in favour (take-profit)`);
  parts.push(exits.length ? `Close the trade when ${exits.join(', or ')}.` : 'Add a way to close the trade.');
  return parts.join(' ');
}

export const TEMPLATES: { key: string; name: string; blurb: string; interval: Interval; rules: Rules }[] = [
  {
    key: 'ema', name: 'EMA crossover', interval: 'M15', blurb: 'Trend-following: buy when the fast average crosses above the slow one.',
    rules: {
      side: 'LONG',
      entry: [{ left: { type: 'ema', period: 9 }, op: 'crossesAbove', right: { type: 'ema', period: 21 } }],
      exit: [{ left: { type: 'ema', period: 9 }, op: 'crossesBelow', right: { type: 'ema', period: 21 } }],
      stopLossPct: 0.5, takeProfitPct: 1,
    },
  },
  {
    key: 'rsi', name: 'RSI bounce', interval: 'M5', blurb: 'Mean reversion: buy when RSI climbs back above 30, sell when it reaches 60.',
    rules: {
      side: 'LONG',
      entry: [{ left: { type: 'rsi', period: 14 }, op: 'crossesAbove', right: { type: 'number', value: 30 } }],
      exit: [{ left: { type: 'rsi', period: 14 }, op: 'crossesAbove', right: { type: 'number', value: 60 } }],
      stopLossPct: 0.7,
    },
  },
  {
    key: 'bb', name: 'Bollinger breakout', interval: 'M15', blurb: 'Momentum: buy when price closes above the upper band, exit at the middle band.',
    rules: {
      side: 'LONG',
      entry: [{ left: { type: 'price', field: 'close' }, op: 'crossesAbove', right: { type: 'bb', band: 'upper', period: 20, mult: 2 } }],
      exit: [{ left: { type: 'price', field: 'close' }, op: 'crossesBelow', right: { type: 'bb', band: 'middle', period: 20, mult: 2 } }],
      stopLossPct: 0.6,
    },
  },
];

export const BLANK_RULES: Rules = TEMPLATES[0].rules;

/** Paise (number) → "₹1,234.50", with sign when asked. */
export function rupees(paise: number, sign = false): string {
  const v = paise / 100;
  const s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}₹${s}`;
}
export const REASON: Record<Trade['reason'], string> = { EXIT_RULE: 'Exit rule', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit', END: 'Still open at end' };
