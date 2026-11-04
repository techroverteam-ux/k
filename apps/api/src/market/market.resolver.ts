import { Args, Float, ID, Int, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Actor, GqlContext } from '../common/context';
import { AllowWithoutMfa, Ctx, CurrentActor, Public, Roles } from '../common/context';
import { AuditService } from '../audit/audit.service';
import { badInput, notFound } from '../common/errors';
import { AppSettings, Candle, CandleIntervalGql, Instrument, MarketPulseItem, Quote, WatchlistCount, WatchlistEntry } from '../common/gql-types';
import { formatMoney } from '../common/money';
import type { CandleInterval } from './candles';
import { API_VERSION } from '../common/version';
import { clampLimit, toInstrument, toQuote } from '../common/mappers';
import { ConfigService } from '../config-mgmt/config.service';
import { env } from '../config/env';
import { DbService } from '../db/db';
import { instruments, watchlistItems } from '../db/schema';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { MarketDataService, type Quote as QuoteData } from './market-data.service';

export const MAX_LISTS = 10;
const INTERVAL: Record<CandleIntervalGql, CandleInterval> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h', D1: '1D' };
const MAX_PER_LIST = 50;

@Resolver()
export class MarketResolver {
  constructor(
    private readonly dbs: DbService,
    private readonly market: MarketDataService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Query(() => AppSettings, { description: 'Public, non-secret settings for clients.' })
  async appSettings(): Promise<AppSettings> {
    return {
      appName: env().APP_NAME,
      tickerMessages: await this.config.get('ui.tickerMessages'),
      termsRules: await this.config.get('ui.termsRules'),
      helplineUrl: await this.config.get('ui.helplineUrl'),
      demoEnabled: await this.config.get('demo.enabled'),
      tradingMode: env().LIVE_TRADING_ENABLED ? 'LIVE' : 'SIMULATED',
      marketFeed: env().MARKET_FEED.toUpperCase(),
      signupEnabled: await this.config.get('signup.enabled'),
      maxWatchlists: MAX_LISTS,
      minDeposit: formatMoney(BigInt(await this.config.get('payments.minDepositMinor'))).replace(/,/g, ''),
      apiVersion: API_VERSION,
    };
  }

  /** Public price snapshot for the sign-in screen: a fixed, small set of instruments, no account data. */
  @Public()
  @Query(() => [MarketPulseItem], { description: 'Public snapshot of a few instruments from the price feed (sign-in screen).' })
  marketPulse(): MarketPulseItem[] {
    const order = ['NIFTY', 'BANKNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL', 'RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'SBIN'];
    const base = (s: string) => s.replace(/[-_].*$/, '').replace(/\d{2}[A-Z]{3}FUT$/, '');
    const seen = new Set<string>();
    return this.market
      .all()
      .filter((q) => {
        const b = base(q.symbol);
        if (!order.includes(b) || seen.has(b)) return false;
        seen.add(b);
        return true;
      })
      .sort((a, b) => order.indexOf(base(a.symbol)) - order.indexOf(base(b.symbol)))
      .map((q) => {
        const t = toQuote(q);
        const meta = this.market.instrument(q.instrumentId);
        return { instrumentId: q.instrumentId, symbol: q.symbol, name: meta?.name ?? q.symbol, exchange: meta?.exchange ?? '', ltp: t.ltp, change: t.change, changePct: t.changePct, source: q.source };
      });
  }

  @AllowWithoutMfa()
  @Query(() => [Instrument])
  async searchInstruments(@Args('query') query: string, @Args('limit', { type: () => Int, nullable: true }) limit?: number) {
    const s = `%${query.trim().replace(/[%_\\]/g, (x) => '\\' + x).slice(0, 30)}%`;
    const rows = await this.dbs.db
      .select()
      .from(instruments)
      .where(and(eq(instruments.active, true), or(ilike(instruments.symbol, s), ilike(instruments.name, s))))
      .orderBy(asc(instruments.symbol))
      .limit(clampLimit(limit, 20, 50));
    return rows.map(toInstrument);
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [Instrument], { description: 'Super Admin: every active instrument, to set which are mini and which are mega lots.' })
  async allInstruments(@Args('lotClass', { nullable: true }) lotClass?: string) {
    const rows = await this.dbs.db
      .select()
      .from(instruments)
      .where(and(eq(instruments.active, true), lotClass === 'MINI' || lotClass === 'MEGA' ? eq(instruments.lotClass, lotClass) : undefined))
      .orderBy(asc(instruments.exchange), asc(instruments.symbol))
      .limit(2000);
    return rows.map(toInstrument);
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => [Instrument], { description: 'Super Admin: mark instruments as MINI or MEGA lots (brokerage and broker earning per lot follow).' })
  async setInstrumentLotClass(@CurrentActor() a: Actor, @Args('instrumentIds', { type: () => [ID] }) ids: string[], @Args('lotClass') lotClass: string, @Ctx() c: GqlContext) {
    if (lotClass !== 'MINI' && lotClass !== 'MEGA') throw badInput('Choose MINI or MEGA.');
    if (!ids.length || ids.length > 500) throw badInput('Pick 1–500 instruments.');
    const rows = await this.dbs.db.transaction(async (tx) => {
      const r = await tx.update(instruments).set({ lotClass }).where(inArray(instruments.id, ids)).returning();
      await this.audit.record(tx, { actor: a, action: 'instrument.lot_class_set', entityType: 'instrument', entityId: ids.length === 1 ? ids[0] : undefined, outcome: 'SUCCESS', ip: c.ip, metadata: { lotClass, symbols: r.map((x) => x.symbol) } });
      return r;
    });
    for (const r of rows) {
      const m = this.market.instrument(r.id);
      if (m) m.lotClass = lotClass; // fees use the in-memory copy
    }
    return rows.map(toInstrument);
  }

  @AllowWithoutMfa()
  @Query(() => Instrument)
  async instrument(@Args('id', { type: () => ID }) id: string) {
    const i = this.market.instrument(id);
    if (!i) throw notFound('Instrument');
    return toInstrument(i);
  }

  @AllowWithoutMfa()
  @Query(() => [Quote])
  quotes(@Args('instrumentIds', { type: () => [ID] }) ids: string[]) {
    if (ids.length > 100) throw badInput('Max 100 instruments per request.');
    return ids.map((id) => this.market.quote(id)).filter((q): q is QuoteData => !!q).map(toQuote);
  }

  @AllowWithoutMfa()
  @Query(() => [Candle], { description: 'Recent OHLC candles for an instrument, oldest first (simulated history in this build).' })
  async candles(
    @Args('instrumentId', { type: () => ID }) instrumentId: string,
    @Args('interval', { type: () => CandleIntervalGql }) interval: CandleIntervalGql,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('before', { type: () => Float, nullable: true, description: 'Only candles that start before this time (epoch ms). Use it to page back through history.' }) before?: number,
  ): Promise<Candle[]> {
    if (!this.market.instrument(instrumentId)) throw notFound('Instrument');
    const n = Math.min(Math.max(Math.trunc(limit ?? 300), 1), 1000);
    if (before !== undefined && !Number.isFinite(before)) throw badInput('Invalid time.');
    return (await this.market.candles(instrumentId, INTERVAL[interval], n, before)).map((b) => ({
      t: b.t,
      open: formatMoney(BigInt(b.o)),
      high: formatMoney(BigInt(b.h)),
      low: formatMoney(BigInt(b.l)),
      close: formatMoney(BigInt(b.c)),
    }));
  }

  @Query(() => [WatchlistEntry])
  async watchlist(@CurrentActor() a: Actor, @Args('listIndex', { type: () => Int }) listIndex: number) {
    if (listIndex < 0 || listIndex >= MAX_LISTS) throw badInput('Invalid watchlist.');
    const rows = await this.dbs.db
      .select({ w: watchlistItems, i: instruments })
      .from(watchlistItems)
      .innerJoin(instruments, eq(instruments.id, watchlistItems.instrumentId))
      .where(and(eq(watchlistItems.userId, a.userId), eq(watchlistItems.listIndex, listIndex)))
      .orderBy(asc(watchlistItems.sortOrder), asc(instruments.symbol));
    return rows.map(({ w, i }) => {
      const q = this.market.quote(i.id);
      return { id: w.id, listIndex: w.listIndex, instrument: toInstrument(i), quote: q ? toQuote(q) : undefined };
    });
  }

  @Query(() => [WatchlistCount], { description: 'How many scripts each of your watchlists holds (only lists that are not empty).' })
  async watchlistCounts(@CurrentActor() a: Actor): Promise<WatchlistCount[]> {
    return this.dbs.db
      .select({ listIndex: watchlistItems.listIndex, count: sql<number>`count(*)::int` })
      .from(watchlistItems)
      .where(eq(watchlistItems.userId, a.userId))
      .groupBy(watchlistItems.listIndex)
      .orderBy(watchlistItems.listIndex);
  }

  @Mutation(() => Boolean)
  async addToWatchlist(@CurrentActor() a: Actor, @Args('listIndex', { type: () => Int }) listIndex: number, @Args('instrumentId', { type: () => ID }) instrumentId: string) {
    if (listIndex < 0 || listIndex >= MAX_LISTS) throw badInput('Invalid watchlist.');
    if (!this.market.instrument(instrumentId)) throw notFound('Instrument');
    const existing = await this.dbs.db.$count(watchlistItems, and(eq(watchlistItems.userId, a.userId), eq(watchlistItems.listIndex, listIndex)));
    if (existing >= MAX_PER_LIST) throw badInput(`A watchlist can hold up to ${MAX_PER_LIST} scripts.`);
    await this.dbs.db.insert(watchlistItems).values({ userId: a.userId, listIndex, instrumentId, sortOrder: existing }).onConflictDoNothing();
    return true;
  }

  @Mutation(() => Boolean)
  async removeFromWatchlist(@CurrentActor() a: Actor, @Args('listIndex', { type: () => Int }) listIndex: number, @Args('instrumentId', { type: () => ID }) instrumentId: string) {
    await this.dbs.db
      .delete(watchlistItems)
      .where(and(eq(watchlistItems.userId, a.userId), eq(watchlistItems.listIndex, listIndex), eq(watchlistItems.instrumentId, instrumentId)));
    return true;
  }

  @Subscription(() => [Quote], {
    description: 'Streaming quotes for the given instruments (simulated feed in this build).',
    filter: (payload: { quotes: QuoteData[] }, vars: { instrumentIds: string[] }) => payload.quotes.some((q) => vars.instrumentIds.includes(q.instrumentId)),
    resolve: (payload: { quotes: QuoteData[] }, vars: { instrumentIds: string[] }) =>
      payload.quotes.filter((q) => vars.instrumentIds.includes(q.instrumentId)).map(toQuote),
  })
  quotesUpdated(@Args('instrumentIds', { type: () => [ID] }) ids: string[]) {
    if (ids.length > 100) throw badInput('Max 100 instruments per subscription.');
    return pubsub.asyncIterableIterator(TOPIC.quotes);
  }
}
