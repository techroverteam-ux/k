/**
 * OHLC candle history for the SIMULATED feed.
 *
 * - Live ticks are folded into 1-minute bars as they happen.
 * - At start-up each instrument gets a synthetic back-history so charts are not empty:
 *     · 1-minute bars for the last 24 hours, bridged from the previous close to the current price;
 *     · daily bars for about a year of weekdays, ending at the previous close.
 *   The back-history is generated from a per-instrument seed, so it looks the same after a restart.
 * - 5m / 15m / 1h candles are aggregated from the 1-minute bars; 1D uses the daily bars plus today's minutes.
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

const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const MINUTE_BARS = 3 * 24 * 60; // keep three days of 1-minute bars
const BACKFILL_MINUTES = 24 * 60;
const BACKFILL_DAYS = 260; // ~one year of weekdays
const SIZE: Record<Exclude<CandleInterval, '1D'>, number> = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN };

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

  /** Create the synthetic back-history for one instrument (once). */
  seed(id: string, ltpMinor: number, prevCloseMinor: number, tickMinor: number, now = Date.now()) {
    if (this.minutes.has(id)) return;
    const tick = Math.max(1, tickMinor);
    const r = rng(hash(id));

    // Daily bars: random walk backwards from yesterday's close, weekdays only.
    const today = bucketStart(now, DAY);
    const days: number[] = [];
    for (let d = today - DAY; days.length < BACKFILL_DAYS; d -= DAY) {
      const wd = new Date(d + IST).getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(d);
    }
    days.reverse();
    const first = prevCloseMinor * Math.exp(gauss(r) * 0.08); // a year-ago level, typically within ±8%
    const dPath = bridge(r, days.length, first, prevCloseMinor, 0.011);
    this.daily.set(id, barsFromPath(r, dPath, days, tick, 0.006));

    // 1-minute bars: the last 24 hours, from the previous close to the current price.
    const end = bucketStart(now, MIN);
    const times = Array.from({ length: BACKFILL_MINUTES }, (_, k) => end - (BACKFILL_MINUTES - k) * MIN);
    // Step volatility ~0.22% per minute, close to the live simulated feed, so history and live candles look alike.
    const mPath = bridge(r, BACKFILL_MINUTES, prevCloseMinor, ltpMinor, 0.0022);
    this.minutes.set(id, barsFromPath(r, mPath, times, tick, 0.0007));
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
      if (list.length > MINUTE_BARS) list.splice(0, list.length - MINUTE_BARS);
    }
  }

  /** The most recent `limit` candles for an interval, oldest first. Returned objects are copies. */
  candles(id: string, interval: CandleInterval, limit: number, now = Date.now()): Bar[] {
    const mins = this.minutes.get(id) ?? [];
    if (interval === '1m') return mins.slice(-limit).map((b) => ({ ...b }));
    if (interval === '1D') {
      const today = bucketStart(now, DAY);
      const past = (this.daily.get(id) ?? []).filter((b) => b.t < today);
      const cur = aggregate(mins.filter((b) => b.t >= today), DAY);
      return [...past.map((b) => ({ ...b })), ...cur].slice(-limit);
    }
    return aggregate(mins, SIZE[interval]).slice(-limit);
  }
}

function aggregate(bars: Bar[], size: number): Bar[] {
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
