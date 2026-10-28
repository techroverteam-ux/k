import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { roundToTick } from '../common/money';
import { DbService } from '../db/db';
import { instruments, type InstrumentRow } from '../db/schema';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { bucketStart, CandleStore, type Bar, type CandleInterval } from './candles';

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
  source: 'SIMULATED';
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

@Injectable()
export class MarketDataService implements MarketDataProvider, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MarketData');
  private quotes = new Map<string, Quote>();
  private meta = new Map<string, InstrumentRow>();
  private timer?: NodeJS.Timeout;
  private listeners: Array<(q: Quote[]) => void> = [];
  private readonly history = new CandleStore();

  constructor(private readonly dbs: DbService) {}

  async onModuleInit() {
    await this.reload();
    if (process.env.NODE_ENV !== 'test') this.timer = setInterval(() => this.tick(), 1000);
    this.log.log(`Simulated feed started for ${this.quotes.size} instruments`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reload() {
    const rows = await this.dbs.db.select().from(instruments).where(eq(instruments.active, true));
    for (const r of rows) {
      this.meta.set(r.id, r);
      if (!this.quotes.has(r.id)) {
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
      const q = this.quotes.get(r.id)!;
      if (!this.history.has(r.id)) {
        this.history.seed(r.id, Number(q.ltpMinor), Number(q.prevCloseMinor), r.tickMinor);
        // Keep the day's high/low consistent with today's candles.
        const today = bucketStart(Date.now(), 86_400_000);
        for (const b of this.history.candles(r.id, '1m', 24 * 60).filter((x) => x.t >= today)) {
          if (BigInt(b.h) > q.highMinor) q.highMinor = BigInt(b.h);
          if (BigInt(b.l) < q.lowMinor) q.lowMinor = BigInt(b.l);
        }
      }
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
    for (const q of changed) this.history.record(q.instrumentId, Number(q.ltpMinor), q.ts.getTime());
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

  /** OHLC candles (prices in paise), oldest first. Simulated history; see candles.ts. */
  candles(instrumentId: string, interval: CandleInterval, limit: number): Bar[] {
    return this.history.candles(instrumentId, interval, limit);
  }

  instrument(instrumentId: string) {
    return this.meta.get(instrumentId);
  }
}
