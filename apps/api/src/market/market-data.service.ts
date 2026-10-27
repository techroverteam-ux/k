import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { roundToTick } from '../common/money';
import { DbService } from '../db/db';
import { instruments, type InstrumentRow } from '../db/schema';
import { pubsub, TOPIC } from '../notifications/notifications.service';

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

  instrument(instrumentId: string) {
    return this.meta.get(instrumentId);
  }
}
