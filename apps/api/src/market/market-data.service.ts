import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { roundToTick } from '../common/money';
import { DbService } from '../db/db';
import { instruments, type InstrumentRow } from '../db/schema';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { env } from '../config/env';
import { CandleRepo, type StoredBar } from './candle-repo';
import { DhanFeedService, DHAN_SEGMENT_MAP } from './dhan-feed.service';
import { bucketStart, CandleStore, DAY, MEMORY_DAYS, SIZE, type Bar, type CandleInterval } from './candles';

export interface Quote {
  instrumentId: string;
  symbol: string;
  ltpMinor: bigint;
  bidMinor: bigint;
  askMinor: bigint;
  highMinor: bigint;
  lowMinor: bigint;
  prevCloseMinor: bigint;
  ts: Date;
  source: 'SIMULATED' | 'DHAN';
}

/**
 * Market data source abstraction. This build ships only a SIMULATED random-walk feed for
 * paper trading. A licensed real-time feed (exchange vendor / broker API) can implement the
 * same interface; quotes always carry their `source` so the UI can label them honestly.
 */
export interface MarketDataProvider {
  quote(instrumentId: string): Quote | undefined;
  all(): Quote[];
}

/** Instruments whose history is read or generated per batch on start (keeps memory flat on small servers). */
const HISTORY_BATCH = 20;

@Injectable()
export class MarketDataService implements MarketDataProvider, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MarketData');
  private quotes = new Map<string, Quote>();
  private meta = new Map<string, InstrumentRow>();
  private timer?: NodeJS.Timeout;
  private listeners: Array<(q: Quote[]) => void> = [];
  private readonly history = new CandleStore();
  /** Candle storage in Postgres. Off in tests, which run on a fresh database for every suite. */
  private readonly repo?: CandleRepo;
  /** Per instrument: start of the first 1-minute bar not yet saved since the last flush. */
  private unsaved = new Map<string, number>();
  private flushTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(private readonly dbs: DbService, private readonly dhanFeed: DhanFeedService) {
    if (process.env.NODE_ENV !== 'test') this.repo = new CandleRepo(dbs.pool);
  }

  async onModuleInit() {
    await this.reload();
    if (process.env.NODE_ENV !== 'test') {
      const feedMode = env().MARKET_FEED;
      if (feedMode === 'dhan') {
        this.startDhanFeed();
      } else {
        this.timer = setInterval(() => this.tick(), 1000);
    
      }
      this.flushTimer = setInterval(() => void this.flush(), 60_000);
      this.pruneTimer = setInterval(() => void this.prune(), 3_600_000);
      void this.prune();
    }

  }

  private startDhanFeed() {
    this.log.log(`Starting Dhan Live Market Feed for ${this.quotes.size} instruments`);
    const secToId = new Map<string, string>();
    const subs: Array<{ exchangeSegment: string; securityId: string }> = [];

    for (const [id, r] of this.meta.entries()) {
      if (r.dhanSecurityId && r.dhanSegment) {
        secToId.set(`${r.dhanSegment}:${r.dhanSecurityId}`, id);
        secToId.set(r.dhanSecurityId, id);
        subs.push({ exchangeSegment: r.dhanSegment, securityId: r.dhanSecurityId });
      }
    }

    this.dhanFeed.onTick((tick) => {
      const segmentStr = DHAN_SEGMENT_MAP[tick.segmentCode] || '';
      const instId = secToId.get(`${segmentStr}:${tick.securityId}`) || secToId.get(tick.securityId);
      if (!instId) return;

      const q = this.quotes.get(instId);
      const m = this.meta.get(instId);
      if (!q || !m) return;

      const ltpMinor = BigInt(Math.round(tick.ltp * 100));
      if (ltpMinor <= 0n) return;

      const spread = BigInt(m.tickMinor);
      q.ltpMinor = ltpMinor;
      q.bidMinor = ltpMinor - spread;
      q.askMinor = ltpMinor + spread;

      if (tick.high) {
        q.highMinor = BigInt(Math.round(tick.high * 100));
      } else if (ltpMinor > q.highMinor) {
        q.highMinor = ltpMinor;
      }

      if (tick.low) {
        q.lowMinor = BigInt(Math.round(tick.low * 100));
      } else if (ltpMinor < q.lowMinor) {
        q.lowMinor = ltpMinor;
      }

      if (tick.close) {
        q.prevCloseMinor = BigInt(Math.round(tick.close * 100));
      }

      q.ts = tick.timestamp;
      q.source = 'DHAN';

      this.emit([q]);
    });

    this.dhanFeed.setSubscriptions(subs);
    this.dhanFeed.connect();
  }

  async onModuleDestroy() {
    for (const t of [this.timer, this.flushTimer, this.pruneTimer]) if (t) clearInterval(t);
    await this.flush(); // keep the last minute of candles on a clean shutdown or redeploy
  }

  /**
   * Data reset: forget every instrument, quote and unsaved candle, so nothing tries to save bars for deleted
   * instruments. Call after the reset commits; instruments come back with the next instrument sync or reload().
   */
  async clearAll() {
    await this.flushing?.catch(() => undefined);
    this.unsaved.clear();
    this.history.clear();
    this.quotes.clear();
    this.meta.clear();
    this.dhanFeed.setSubscriptions([]);
  }

  /**
   * Load active instruments. History for instruments not loaded yet is read (or, the first time, generated and
   * saved) in small batches, so memory stays flat even with hundreds of instruments on a small server.
   */
  async reload() {
    const rows = await this.dbs.db.select().from(instruments).where(eq(instruments.active, true));
    const now = Date.now();
    const since = bucketStart(now, DAY) - (MEMORY_DAYS - 1) * DAY;
    const today = bucketStart(now, DAY);
    for (const r of rows) {
      this.meta.set(r.id, r);
      if (this.quotes.has(r.id)) continue;
      const spread = BigInt(r.tickMinor) * 4n;
      this.quotes.set(r.id, {
        instrumentId: r.id,
        symbol: r.symbol,
        ltpMinor: r.refPriceMinor,
        bidMinor: r.refPriceMinor - spread,
        askMinor: r.refPriceMinor + spread,
        highMinor: r.refPriceMinor,
        lowMinor: r.refPriceMinor,
        prevCloseMinor: (r.refPriceMinor * 97n) / 100n,
        ts: new Date(),
        source: 'SIMULATED',
      });
    }
    const fresh = rows.filter((r) => !this.history.has(r.id));
    let generatedMinutes = 0;
    for (let i = 0; i < fresh.length; i += HISTORY_BATCH) {
      const batch = fresh.slice(i, i + HISTORY_BATCH);
      const ids = batch.map((r) => r.id);
      const storedMin = new Map<string, Bar[]>();
      const storedDay = new Map<string, Bar[]>();
      if (this.repo) {
        try {
          for (const b of await this.repo.minutesSince(since, ids)) push(storedMin, b);
          for (const b of await this.repo.daily(ids)) push(storedDay, b);
        } catch (e) {
          this.log.error(`Couldn't read stored candles, starting from synthetic history: ${(e as Error).message}`);
        }
      }
      const toSave: { minutes: StoredBar[]; daily: StoredBar[] } = { minutes: [], daily: [] };
      for (const r of batch) {
        const q = this.quotes.get(r.id)!;
        const mins = storedMin.get(r.id) ?? [];
        const days = storedDay.get(r.id) ?? [];
        if (mins.length || days.length) {
          // Continue from stored history: the price picks up where it stopped.
          this.history.restore(r.id, mins, days);
          this.resumeQuote(q, r.tickMinor, now);
        } else {
          // First run for this instrument: synthetic back-history, saved so it stays the same from now on.
          const generated = this.history.seed(r.id, Number(q.ltpMinor), Number(q.prevCloseMinor), r.tickMinor);
          for (const b of generated) {
            if (b.t < today) continue;
            if (BigInt(b.h) > q.highMinor) q.highMinor = BigInt(b.h);
            if (BigInt(b.l) < q.lowMinor) q.lowMinor = BigInt(b.l);
          }
          if (this.repo) {
            for (const b of generated) toSave.minutes.push({ ...b, instrumentId: r.id });
            for (const b of this.history.allDaily(r.id)) toSave.daily.push({ ...b, instrumentId: r.id });
          }
          generatedMinutes += generated.length;
        }
        this.unsaved.set(r.id, now);
      }
      if (this.repo && (toSave.minutes.length || toSave.daily.length)) {
        try {
          await this.repo.upsert('candles_1d', toSave.daily);
          await this.repo.upsert('candles_1m', toSave.minutes);
        } catch (e) {
          this.log.error(`Couldn't save synthetic history: ${(e as Error).message}`);
        }
      }
    }
    if (generatedMinutes) this.log.log(`Saved synthetic history: ${generatedMinutes} minute candles for new instruments`);
  }


  /** After a restore: last stored close becomes the price; previous close and today's range come from the candles. */
  private resumeQuote(q: Quote, tickMinor: number, now: number) {
    const last = this.history.last(q.instrumentId);
    if (!last) return;
    const today = bucketStart(now, DAY);
    const daily = this.history.allDaily(q.instrumentId);
    const before = [...daily].reverse().find((d) => d.t < today);
    const todays = this.history.minutesSince(q.instrumentId, today);
    const ltp = BigInt(last.c);
    const spread = BigInt(tickMinor) * 4n;
    q.ltpMinor = ltp;
    q.bidMinor = ltp - spread;
    q.askMinor = ltp + spread;
    q.prevCloseMinor = before ? BigInt(before.c) : ltp;
    q.highMinor = todays.length ? BigInt(Math.max(...todays.map((b) => b.h))) : ltp;
    q.lowMinor = todays.length ? BigInt(Math.min(...todays.map((b) => b.l))) : ltp;
    q.ts = new Date(now);
  }

  /** Save every 1-minute bar changed since the last flush, and the daily bars they belong to. */
  async flush(): Promise<void> {
    if (!this.repo) return;
    if (this.flushing) return this.flushing;
    const repo = this.repo;
    this.flushing = (async () => {
      const minutes: StoredBar[] = [];
      const daily: StoredBar[] = [];
      const marks = new Map<string, number>();
      for (const [id, from] of this.unsaved) {
        const start = bucketStart(from, SIZE['1m']);
        const bars = this.history.minutesSince(id, start);
        if (!bars.length) continue;
        minutes.push(...bars.map((b) => ({ ...b, instrumentId: id })));
        const dayStart = bucketStart(bars[0].t, DAY);
        daily.push(...this.history.allDaily(id).filter((d) => d.t >= dayStart).map((d) => ({ ...d, instrumentId: id })));
        marks.set(id, bars[bars.length - 1].t); // the forming bar is saved again next time
      }
      if (!minutes.length) return;
      try {
        await repo.upsert('candles_1m', minutes);
        await repo.upsert('candles_1d', daily);
        for (const [id, t] of marks) this.unsaved.set(id, t);
      } catch (e) {
        this.log.error(`Couldn't save candles (will retry): ${(e as Error).message}`);
      }
    })().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  /** Delete 1-minute candles past the retention period. Daily candles are kept. */
  private async prune() {
    if (!this.repo) return;
    try {
      const n = await this.repo.pruneMinutes(Date.now() - env().CANDLE_MINUTE_RETENTION_DAYS * DAY);
      if (n) this.log.log(`Pruned ${n} old minute candles`);
    } catch (e) {
      this.log.error(`Couldn't prune candles: ${(e as Error).message}`);
    }
  }

  onTick(fn: (q: Quote[]) => void) {
    this.listeners.push(fn);
  }

  /** Test hook: set a deterministic price. */
  setPrice(instrumentId: string, ltpMinor: bigint) {
    const q = this.quotes.get(instrumentId);
    const m = this.meta.get(instrumentId);
    if (!q || !m) return;
    const spread = BigInt(m.tickMinor) * 2n;
    Object.assign(q, { ltpMinor, bidMinor: ltpMinor - spread, askMinor: ltpMinor + spread, ts: new Date() });
    this.emit([q]);
  }

  private tick() {
    const changed: Quote[] = [];
    for (const q of this.quotes.values()) {
      if (Math.random() < 0.5) continue;
      const m = this.meta.get(q.instrumentId)!;
      const drift = (Math.random() - 0.5) * 0.0016; // ±0.08%
      const next = roundToTick(q.ltpMinor + BigInt(Math.round(Number(q.ltpMinor) * drift)), m.tickMinor);
      const ltp = next > 0n ? next : q.ltpMinor;
      const spreadTicks = BigInt(1 + Math.floor(Math.random() * 6));
      const t = BigInt(m.tickMinor);
      q.ltpMinor = ltp;
      q.bidMinor = ltp - t * spreadTicks;
      q.askMinor = ltp + t * spreadTicks;
      if (ltp > q.highMinor) q.highMinor = ltp;
      if (ltp < q.lowMinor) q.lowMinor = ltp;
      q.ts = new Date();
      changed.push(q);
    }
    if (changed.length) this.emit(changed);
  }

  private emit(changed: Quote[]) {
    for (const q of changed) {
      this.history.record(q.instrumentId, Number(q.ltpMinor), q.ts.getTime());
      if (!this.unsaved.has(q.instrumentId)) this.unsaved.set(q.instrumentId, q.ts.getTime());
    }
    void pubsub.publish(TOPIC.quotes, { quotes: changed });
    for (const l of this.listeners) {
      try {
        l(changed);
      } catch (e) {
        this.log.error((e as Error).message);
      }
    }
  }

  quote(instrumentId: string) {
    return this.quotes.get(instrumentId);
  }

  all() {
    return [...this.quotes.values()];
  }

  /**
   * OHLC candles (prices in paise), oldest first. Simulated history; see candles.ts.
   * Intraday candles come from memory for recent days and from Postgres further back.
   */
  async candles(instrumentId: string, interval: CandleInterval, limit: number, before?: number): Promise<Bar[]> {
    const mem = this.history.candles(instrumentId, interval, limit, before);
    if (interval === '1D' || !this.repo || mem.length >= limit) return mem;
    const memStart = this.history.firstMinute(instrumentId);
    const olderThan = Math.min(before ?? Number.MAX_SAFE_INTEGER, mem[0]?.t ?? Number.MAX_SAFE_INTEGER, memStart ?? Number.MAX_SAFE_INTEGER);
    if (olderThan === Number.MAX_SAFE_INTEGER) return mem;
    try {
      const older = await this.repo.page(instrumentId, SIZE[interval], olderThan, limit - mem.length);
      return [...older, ...mem];
    } catch (e) {
      this.log.error(`Couldn't read stored candles: ${(e as Error).message}`);
      return mem;
    }
  }

  instrument(instrumentId: string) {
    return this.meta.get(instrumentId);
  }
}

function push(m: Map<string, Bar[]>, b: StoredBar) {
  const { instrumentId, ...bar } = b;
  let list = m.get(instrumentId);
  if (!list) m.set(instrumentId, (list = []));
  list.push(bar);
}
