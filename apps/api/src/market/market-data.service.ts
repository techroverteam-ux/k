import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { roundToTick } from '../common/money';
import { DbService } from '../db/db';
import { instruments, type InstrumentRow } from '../db/schema';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { env } from '../config/env';
import { DhanFeedService, DHAN_SEGMENT_MAP } from './dhan-feed.service';
import { DhanGlobalFeedService } from './dhan-global-feed.service';
import { CandleStore, type Bar, type CandleInterval } from './candles';

export interface Quote {
  instrumentId: string;
  symbol: string;
  ltpMinor: bigint;
  bidMinor: bigint;
  askMinor: bigint;
  highMinor: bigint;
  lowMinor: bigint;
  prevCloseMinor: bigint;
  openMinor?: bigint;
  volume?: number;
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

@Injectable()
export class MarketDataService implements MarketDataProvider, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MarketData');
  private quotes = new Map<string, Quote>();
  private meta = new Map<string, InstrumentRow>();
  private timer?: NodeJS.Timeout;
  private listeners: Array<(q: Quote[]) => void> = [];
  private readonly history = new CandleStore();
  constructor(
    private readonly dbs: DbService,
    private readonly dhanFeed: DhanFeedService,
    private readonly dhanGlobalFeed: DhanGlobalFeedService,
  ) {}

  async onModuleInit() {
    await this.reload();
    if (process.env.NODE_ENV !== 'test') {
      const feedMode = env().MARKET_FEED;
      if (feedMode === 'dhan') {
        this.startDhanFeed();
      }
      this.timer = setInterval(() => this.tick(), 1000);
    }

  }

  private startDhanFeed() {
    this.log.log(`Starting Dhan Live Market Feeds (Domestic + Global) for ${this.quotes.size} instruments`);
    const secToId = new Map<string, string>();
    const domesticSubs: Array<{ exchangeSegment: string; securityId: string }> = [];
    const globalSubs: Array<{ exchangeSegment: string; securityId: string }> = [];

    for (const [id, r] of this.meta.entries()) {
      if (r.dhanSecurityId && r.dhanSegment) {
        secToId.set(`${r.dhanSegment}:${r.dhanSecurityId}`, id);
        secToId.set(r.dhanSecurityId, id);

        if (r.dhanSegment === 'INX_EQ') {
          globalSubs.push({ exchangeSegment: 'INX_EQ', securityId: r.dhanSecurityId });
        } else {
          domesticSubs.push({ exchangeSegment: r.dhanSegment, securityId: r.dhanSecurityId });
        }
      }
    }

    const onIncomingTick = (tick: import('./dhan-feed.service').DhanTick, segmentOverride?: string) => {
      const segmentStr = segmentOverride || DHAN_SEGMENT_MAP[tick.segmentCode] || '';
      const instId = secToId.get(`${segmentStr}:${tick.securityId}`) || secToId.get(tick.securityId);
      if (!instId) return;

      const q = this.quotes.get(instId);
      const m = this.meta.get(instId);
      if (!q || !m) return;

      if (tick.close && tick.close > 0) {
        q.prevCloseMinor = BigInt(Math.round(tick.close * 100));
      }
      if (tick.open && tick.open > 0) {
        q.openMinor = BigInt(Math.round(tick.open * 100));
      }
      if (tick.volume) {
        q.volume = tick.volume;
      }

      let ltpMinor = BigInt(Math.round(tick.ltp * 100));
      // If untraded today (LTP is 0), use previous close as current trading price
      if (ltpMinor <= 0n && q.prevCloseMinor > 0n) {
        ltpMinor = q.prevCloseMinor;
      }
      if (ltpMinor <= 0n) return;

      const spread = BigInt(m.tickMinor);
      q.ltpMinor = ltpMinor;
      q.bidMinor = ltpMinor - spread;
      q.askMinor = ltpMinor + spread;

      if (tick.high && tick.high > 0) {
        q.highMinor = BigInt(Math.round(tick.high * 100));
      } else if (ltpMinor > q.highMinor) {
        q.highMinor = ltpMinor;
      }

      if (tick.low && tick.low > 0) {
        q.lowMinor = BigInt(Math.round(tick.low * 100));
      } else if (ltpMinor < q.lowMinor) {
        q.lowMinor = ltpMinor;
      }

      q.ts = tick.timestamp;
      q.source = 'DHAN';

      this.emit([q]);
    };

    if (domesticSubs.length) {
      this.dhanFeed.onTick((tick) => onIncomingTick(tick));
      this.dhanFeed.setSubscriptions(domesticSubs);
      this.dhanFeed.connect();
    }

    if (globalSubs.length) {
      this.dhanGlobalFeed.onTick((tick) => onIncomingTick(tick, 'INX_EQ'));
      this.dhanGlobalFeed.setSubscriptions(globalSubs);
      this.dhanGlobalFeed.connect();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.history.clear();
  }

  /** Clear transient market data after a platform reset. */
  async clearAll() {
    this.history.clear();
    this.quotes.clear();
    this.meta.clear();
    this.dhanFeed.setSubscriptions([]);
    this.dhanGlobalFeed.setSubscriptions([]);
  }

  /** Load instrument metadata; candle history exists only in this process. */
  async reload() {
    const rows = await this.dbs.db.select().from(instruments).where(eq(instruments.active, true));
    const now = Date.now();
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
    if (env().MARKET_FEED === 'simulated') {
      for (const r of rows) {
        if (this.history.has(r.id)) continue;
        const q = this.quotes.get(r.id)!;
        this.history.seed(r.id, Number(q.ltpMinor), Number(q.prevCloseMinor), r.tickMinor, now);
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
    const isDhan = env().MARKET_FEED === 'dhan';
    for (const q of this.quotes.values()) {
      const m = this.meta.get(q.instrumentId);
      if (!m) continue;
      // Skip simulated tick for real exchange instruments subscribed to Dhan feed
      if (isDhan && m.dhanSecurityId) continue;
      if (Math.random() < 0.5) continue;
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

  /** Recent, process-local OHLC candles. No database reads or writes. */
  async candles(instrumentId: string, interval: CandleInterval, limit: number, before?: number): Promise<Bar[]> {
    return this.history.candles(instrumentId, interval, limit, before);
  }

  instrument(instrumentId: string) {
    return this.meta.get(instrumentId);
  }
}
