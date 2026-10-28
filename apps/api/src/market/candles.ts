/**
 * OHLC candle history for the SIMULATED feed: an in-memory window of recent candles, backed by Postgres.
 *
 * - Live ticks are folded into 1-minute bars as they happen. MarketDataService saves changed bars to
 *   Postgres every minute (candles_1m for minutes, candles_1d for whole days) and restores them at start-up,
 *   so history and the last price survive restarts. Minutes older than the memory window are read from Postgres.
 * - The first time an instrument has no stored history, it gets a synthetic back-history so charts aren't empty:
 *     · daily bars for the past year, ending at the previous close;
 *     · 1-minute bars for the last 5 days, one day at a time between those daily closes, then today from the
 *       previous close to the current price.
 *   It is generated from a per-instrument seed, so it is the same wherever it is generated.
 * - 5m / 15m / 1h candles are aggregated from 1-minute bars. 1D uses daily bars for days before the memory
 *   window and the 1-minute bars for the days inside it, so intraday and daily views agree.
 * - The simulated feed runs every day, so the history has no weekend gaps either.
 *
 * Buckets are aligned to India Standard Time (UTC+05:30), so hourly candles start on the hour IST and
 * daily candles start at IST midnight. Prices are integer paise, like the rest of the money model.
 * Everything here is simulated and is labelled that way in the API and the UI.
 */

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '1D';

export interface Bar {
  /** Bucket start, epoch milliseconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export const MIN = 60_000;
export const DAY = 86_400_000;
const IST = 330 * MIN;
/** Days of 1-minute bars kept in memory (older ones are read from Postgres). */
export const MEMORY_DAYS = 3;
const MINUTE_BARS = MEMORY_DAYS * 24 * 60;
const BACKFILL_MINUTE_DAYS = 5;
const BACKFILL_DAYS = 365;
export const SIZE: Record<Exclude<CandleInterval, '1D'>, number> = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN };

/** Start of the IST-aligned bucket of `size` ms that contains `t`. */
export function bucketStart(t: number, size: number): number {
  return Math.floor((t + IST) / size) * size - IST;
}

/** Small deterministic PRNG (mulberry32) so back-history is stable across restarts. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Standard normal sample (Box–Muller). */
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const snap = (v: number, tick: number) => Math.max(tick, Math.round(v / tick) * tick);

/**
 * Price path of `n + 1` points from `from` to `to`: a random walk with step volatility `vol`
 * (fraction of price), bent so it lands exactly on `to` (a Brownian bridge in log space).
 */
function bridge(r: () => number, n: number, from: number, to: number, vol: number): number[] {
  const steps = Array.from({ length: n }, () => gauss(r) * vol);
  const walk = [0];
  for (const s of steps) walk.push(walk[walk.length - 1] + s);
  const target = Math.log(to / from);
  const end = walk[n];
  return walk.map((w, k) => from * Math.exp(w + ((target - end) * k) / n));
}

/** Turn consecutive closes into bars with plausible wicks. */
function barsFromPath(r: () => number, path: number[], times: number[], tick: number, wick: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 1; k < path.length; k++) {
    const o = snap(path[k - 1], tick);
    const c = snap(path[k], tick);
    const top = Math.max(o, c);
    const bot = Math.min(o, c);
    const h = snap(top * (1 + Math.abs(gauss(r)) * wick), tick);
    const l = snap(bot * (1 - Math.abs(gauss(r)) * wick), tick);
    out.push({ t: times[k - 1], o, h: Math.max(h, top), l: Math.min(l, bot), c });
  }
  return out;
}

export class CandleStore {
  private minutes = new Map<string, Bar[]>();
  private daily = new Map<string, Bar[]>();

  has(id: string) {
    return this.minutes.has(id);
  }

  /**
   * Create the synthetic back-history for one instrument (once). Returns every generated 1-minute bar
   * (more than the memory window keeps) so the caller can store them.
   */
  seed(id: string, ltpMinor: number, prevCloseMinor: number, tickMinor: number, now = Date.now()): Bar[] {
    if (this.minutes.has(id)) return [];
    const tick = Math.max(1, tickMinor);
    const r = rng(hash(id));
    const today = bucketStart(now, DAY);
    const minuteStart = today - BACKFILL_MINUTE_DAYS * DAY;

    // Daily closes for the past year, ending at yesterday's close.
    const days = Array.from({ length: BACKFILL_DAYS }, (_, k) => today - (BACKFILL_DAYS - k) * DAY);
    const first = prevCloseMinor * Math.exp(gauss(r) * 0.08); // a year-ago level, typically within ±8%
    const dPath = bridge(r, days.length, first, prevCloseMinor, 0.011);
    const dBars = barsFromPath(r, dPath, days, tick, 0.006);
    // Older days stay as daily bars; the last few days are rebuilt from minutes below.
    this.daily.set(id, dBars.filter((b) => b.t < minuteStart));

    // 1-minute bars, one day at a time, each running from the previous day's close to that day's close, so the
    // daily view of those days keeps the same closes. Today runs from yesterday's close to the current price.
    const end = bucketStart(now, MIN);
    const mins: Bar[] = [];
    for (let day = minuteStart; day <= today; day += DAY) {
      const idx = dBars.findIndex((b) => b.t === day);
      const open = idx > 0 ? dBars[idx - 1].c : idx === 0 ? dBars[0].o : prevCloseMinor;
      const isToday = day === today;
      const close = isToday ? ltpMinor : dBars[idx]?.c ?? prevCloseMinor;
      const n = ((isToday ? end : day + DAY) - day) / MIN;
      if (n < 1) continue;
      // ~0.05% per minute on past days (a 2–3% daily range, bounded by the bridge); a little livelier today so it
      // blends into the live simulated feed.
      const path = bridge(r, n, open, close, isToday ? 0.001 : 0.0005);
      const times = Array.from({ length: n }, (_, k) => day + k * MIN);
      mins.push(...barsFromPath(r, path, times, tick, isToday ? 0.0004 : 0.0002));
    }
    this.minutes.set(id, mins);
    const generated = mins.map((b) => ({ ...b }));
    this.trim(id);
    return generated;
  }

  /** Load stored history (both lists oldest first). Minutes should start at an IST midnight. */
  restore(id: string, minutes: Bar[], daily: Bar[]) {
    this.minutes.set(id, minutes);
    this.daily.set(id, daily);
    this.trim(id);
  }

  /** 1-minute bars starting at or after `t` (live objects; callers must not modify them). */
  minutesSince(id: string, t: number): Bar[] {
    const list = this.minutes.get(id) ?? [];
    let i = list.length;
    while (i > 0 && list[i - 1].t >= t) i--;
    return list.slice(i);
  }

  /** Every daily bar this store knows, oldest first: stored days plus days built from minutes. */
  allDaily(id: string): Bar[] {
    return this.candles(id, '1D', Number.MAX_SAFE_INTEGER);
  }

  /** Start of the in-memory minute window, or undefined when there are no minutes. */
  firstMinute(id: string): number | undefined {
    return this.minutes.get(id)?.[0]?.t;
  }

  last(id: string): Bar | undefined {
    const m = this.minutes.get(id);
    return m?.[m.length - 1] ?? this.daily.get(id)?.at(-1);
  }

  /** Drop whole days from the front of the minute window once it exceeds MEMORY_DAYS; they become daily bars. */
  private trim(id: string) {
    const list = this.minutes.get(id);
    if (!list || list.length <= MINUTE_BARS) return;
    const cutDay = bucketStart(list[list.length - MINUTE_BARS].t, DAY) + DAY;
    const cut = list.findIndex((b) => b.t >= cutDay);
    const drop = list.splice(0, cut < 0 ? list.length : cut);
    const daily = this.daily.get(id) ?? [];
    for (const d of aggregate(drop, DAY)) {
      const last = daily[daily.length - 1];
      if (!last || d.t > last.t) daily.push(d);
      else if (last.t === d.t) daily[daily.length - 1] = d;
    }
    this.daily.set(id, daily);
  }


  /** Fold a live trade price into the current 1-minute bar. */
  record(id: string, priceMinor: number, at = Date.now()) {
    let list = this.minutes.get(id);
    if (!list) this.minutes.set(id, (list = []));
    const t = bucketStart(at, MIN);
    const last = list[list.length - 1];
    if (last && last.t === t) {
      if (priceMinor > last.h) last.h = priceMinor;
      if (priceMinor < last.l) last.l = priceMinor;
      last.c = priceMinor;
    } else if (!last || t > last.t) {
      list.push({ t, o: priceMinor, h: priceMinor, l: priceMinor, c: priceMinor });
      if (list.length > MINUTE_BARS) this.trim(id);
    }
  }

  /**
   * Up to `limit` candles for an interval, oldest first, ending before `before` (epoch ms) when given —
   * the client pages back through history with it. Returned objects are copies.
   */
  candles(id: string, interval: CandleInterval, limit: number, before?: number): Bar[] {
    const mins = this.minutes.get(id) ?? [];
    let out: Bar[];
    if (interval === '1D') {
      // Days before the minute window come from daily bars; days inside it are built from minutes. If the
      // window starts part-way through a day (e.g. after a restart) and a stored daily bar exists for that day,
      // the stored bar is used for it, so no day appears twice.
      const daily = this.daily.get(id) ?? [];
      let cut = mins.length ? bucketStart(mins[0].t, DAY) : Infinity;
      if (mins.length && mins[0].t !== cut && daily.some((d) => d.t === cut)) cut += DAY;
      out = [...daily.filter((b) => b.t < cut).map((b) => ({ ...b })), ...aggregate(mins.filter((b) => b.t >= cut), DAY)];
    } else if (interval === '1m') out = mins.map((b) => ({ ...b }));
    else out = aggregate(mins, SIZE[interval]);
    if (before !== undefined) out = out.filter((b) => b.t < before);
    return out.slice(-limit);
  }
}

export function aggregate(bars: Bar[], size: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketStart(b.t, size);
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
    } else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}
