import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/context';
import { AppError, badInput, conflict, forbidden, notFound } from '../common/errors';
import { ConfigService } from '../config-mgmt/config.service';
import { ConsentService } from '../consent/consent.service';
import { DbService } from '../db/db';
import { orders, strategies, strategyEvents, strategyRuns, type StrategyRow } from '../db/schema';
import { bucketStart, DAY, type Bar, type CandleInterval } from '../market/candles';
import { MarketDataService } from '../market/market-data.service';
import { backtest, type BacktestResult } from './engine';
import { conditionLabel, parseRules, warmup, type Rules } from './rules';

export type StrategyInterval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
export const IV: Record<StrategyInterval, CandleInterval> = { M1: '1m', M5: '5m', M15: '15m', H1: '1h', D1: '1D' };
export const STEP_MS: Record<StrategyInterval, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, D1: DAY };
const MAX_BACKTEST_CANDLES = 20_000;
const MAX_TRADES_STORED = 500;

export interface SaveStrategyInput {
  id?: string;
  name: string;
  instrumentId: string;
  interval: StrategyInterval;
  rules: unknown;
  quantity: number;
  maxDailyLossMinor: bigint;
  maxOrdersPerDay: number;
}

/**
 * Automated strategies (paper trading): saving, backtesting, and starting/stopping.
 * The live decisions are made by AlgoRunnerService. Owners only: a trader sees and controls their own.
 */
@Injectable()
export class AlgoService {
  constructor(
    private readonly dbs: DbService,
    private readonly market: MarketDataService,
    private readonly config: ConfigService,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
  ) {}

  private async assertEnabled() {
    if (!(await this.config.get('algo.enabled'))) throw new AppError('NOT_ENABLED', 'Automated trading is turned off on this platform.');
  }

  private assertTrader(actor: Actor) {
    if (actor.role !== 'TRADER') throw forbidden('Only traders can build and run strategies.');
  }

  async owned(actor: Actor, id: string): Promise<StrategyRow> {
    const [s] = await this.dbs.db.select().from(strategies).where(eq(strategies.id, id));
    if (!s || s.userId !== actor.userId) throw notFound('Strategy');
    return s;
  }

  list(actor: Actor) {
    return this.dbs.db.select().from(strategies).where(eq(strategies.userId, actor.userId)).orderBy(desc(strategies.updatedAt));
  }

  async save(actor: Actor, input: SaveStrategyInput, ip: string): Promise<StrategyRow> {
    this.assertTrader(actor);
    await this.assertEnabled();
    let rules: Rules;
    try {
      rules = parseRules(input.rules);
    } catch (e) {
      throw badInput((e as Error).message);
    }
    const name = input.name.trim();
    if (!name || name.length > 80) throw badInput('Give the strategy a name (up to 80 characters).');
    if (!this.market.instrument(input.instrumentId)) throw notFound('Instrument');
    if (!(input.interval in IV)) throw badInput('Pick a timeframe.');
    const maxQty = await this.config.get('trading.maxQtyPerOrder');
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > maxQty) throw badInput(`Quantity must be between 1 and ${maxQty}.`);
    if (input.maxDailyLossMinor <= 0n) throw badInput('Set a maximum daily loss above zero.');
    if (!Number.isSafeInteger(input.maxOrdersPerDay) || input.maxOrdersPerDay < 1 || input.maxOrdersPerDay > 500) throw badInput('Max orders per day must be between 1 and 500.');

    const values = {
      name,
      instrumentId: input.instrumentId,
      interval: input.interval,
      rules,
      quantity: input.quantity,
      maxDailyLossMinor: input.maxDailyLossMinor,
      maxOrdersPerDay: input.maxOrdersPerDay,
      updatedAt: new Date(),
    };
    if (input.id) {
      const cur = await this.owned(actor, input.id);
      if (cur.status === 'RUNNING') throw conflict('Stop the strategy before editing it.');
      const [row] = await this.dbs.db.update(strategies).set({ ...values, version: cur.version + 1 }).where(eq(strategies.id, cur.id)).returning();
      await this.audit.recordStandalone({ actor, action: 'strategy.updated', entityType: 'strategy', entityId: row.id, outcome: 'SUCCESS', ip, metadata: { version: row.version, name } });
      return row;
    }
    const [{ n }] = await this.dbs.db.select({ n: count() }).from(strategies).where(eq(strategies.userId, actor.userId));
    const max = await this.config.get('algo.maxStrategiesPerUser');
    if (n >= max) throw conflict(`You can save up to ${max} strategies. Delete one first.`);
    const [row] = await this.dbs.db.insert(strategies).values({ ...values, userId: actor.userId }).returning();
    await this.audit.recordStandalone({ actor, action: 'strategy.created', entityType: 'strategy', entityId: row.id, outcome: 'SUCCESS', ip, metadata: { name } });
    return row;
  }

  async remove(actor: Actor, id: string, ip: string) {
    const s = await this.owned(actor, id);
    if (s.status === 'RUNNING') throw conflict('Stop the strategy before deleting it.');
    await this.dbs.db.delete(strategies).where(eq(strategies.id, s.id));
    await this.audit.recordStandalone({ actor, action: 'strategy.deleted', entityType: 'strategy', entityId: s.id, outcome: 'SUCCESS', ip, metadata: { name: s.name } });
    return true;
  }

  // ------------------------------------------------------------------ history + backtest

  /**
   * Candles from `fromMs` to now, plus enough earlier ones to warm the indicators up.
   * Pages back through the API's candle history (memory, then Postgres).
   */
  async history(instrumentId: string, interval: StrategyInterval, fromMs: number, warm: number): Promise<{ bars: Bar[]; startIndex: number }> {
    const iv = IV[interval];
    let bars: Bar[] = await this.market.candles(instrumentId, iv, 1000);
    while (bars.length && bars.length < MAX_BACKTEST_CANDLES) {
      const before = bars.filter((b) => b.t < fromMs).length;
      if (before >= warm) break;
      const older = await this.market.candles(instrumentId, iv, 1000, bars[0].t);
      if (!older.length) break;
      bars = [...older.filter((b) => b.t < bars[0].t), ...bars];
    }
    let startIndex = bars.findIndex((b) => b.t >= fromMs);
    if (startIndex < 0) startIndex = bars.length;
    startIndex = Math.max(startIndex, Math.min(warm, bars.length));
    return { bars, startIndex };
  }

  async runBacktest(actor: Actor, id: string, days: number) {
    this.assertTrader(actor);
    await this.assertEnabled();
    const s = await this.owned(actor, id);
    if (!Number.isFinite(days) || days < 1 || days > 366) throw badInput('Pick a period between 1 day and 1 year.');
    const rules = parseRules(s.rules);
    const interval = s.interval as StrategyInterval;
    const fromMs = Date.now() - days * DAY;
    const { bars, startIndex } = await this.history(s.instrumentId, interval, fromMs, warmup(rules));
    if (bars.length - startIndex < 10) throw badInput('Not enough candle history for that period at this timeframe. Try a shorter period or a larger timeframe.');
    const feeBps = await this.config.get('trading.brokerageBps');
    const result: BacktestResult = backtest(bars, rules, s.quantity, feeBps, startIndex);
    const [run] = await this.dbs.db
      .insert(strategyRuns)
      .values({
        strategyId: s.id,
        userId: actor.userId,
        version: s.version,
        interval,
        fromAt: new Date(bars[startIndex].t),
        toAt: new Date(bars[bars.length - 1].t),
        rules,
        quantity: s.quantity,
        metrics: result.metrics,
        trades: result.trades.slice(-MAX_TRADES_STORED),
        equity: result.equity,
      })
      .returning();
    // Keep the 20 most recent runs per strategy.
    await this.dbs.db.execute(sql`DELETE FROM strategy_runs WHERE strategy_id = ${s.id} AND id NOT IN (SELECT id FROM strategy_runs WHERE strategy_id = ${s.id} ORDER BY created_at DESC LIMIT 20)`);
    return run;
  }

  async runs(actor: Actor, id: string, limit: number) {
    await this.owned(actor, id);
    return this.dbs.db.select().from(strategyRuns).where(eq(strategyRuns.strategyId, id)).orderBy(desc(strategyRuns.createdAt)).limit(limit);
  }

  async events(actor: Actor, id: string, limit: number) {
    await this.owned(actor, id);
    return this.dbs.db.select().from(strategyEvents).where(eq(strategyEvents.strategyId, id)).orderBy(desc(strategyEvents.at), desc(strategyEvents.id)).limit(limit);
  }

  /** Today's (IST) realised P&L and order count, per strategy. */
  async today(ids: string[]) {
    const out = new Map<string, { pnl: bigint; orders: number }>();
    if (!ids.length) return out;
    const since = new Date(bucketStart(Date.now(), DAY));
    const pnl = await this.dbs.db
      .select({ id: strategyEvents.strategyId, p: sum(strategyEvents.pnlMinor) })
      .from(strategyEvents)
      .where(and(inArray(strategyEvents.strategyId, ids), eq(strategyEvents.kind, 'EXIT'), gte(strategyEvents.at, since)))
      .groupBy(strategyEvents.strategyId);
    const cnt = await this.dbs.db
      .select({ id: orders.strategyId, n: count() })
      .from(orders)
      .where(and(inArray(orders.strategyId, ids), gte(orders.createdAt, since)))
      .groupBy(orders.strategyId);
    for (const id of ids) out.set(id, { pnl: 0n, orders: 0 });
    for (const r of pnl) if (r.id) out.get(r.id)!.pnl = BigInt(r.p ?? 0);
    for (const r of cnt) if (r.id) out.get(r.id)!.orders = r.n;
    return out;
  }

  // ------------------------------------------------------------------ start / stop

  async start(actor: Actor, id: string, ip: string) {
    this.assertTrader(actor);
    await this.assertEnabled();
    const s = await this.owned(actor, id);
    if (s.status === 'RUNNING') return s;
    // The trader accepts the trading rules for this session before automation can trade for them.
    await this.consent.assertConsented(actor);
    parseRules(s.rules);
    const [{ n }] = await this.dbs.db.select({ n: count() }).from(strategies).where(and(eq(strategies.userId, actor.userId), eq(strategies.status, 'RUNNING')));
    const max = await this.config.get('algo.maxRunningPerUser');
    if (n >= max) throw conflict(max === 0 ? 'Running strategies is turned off for your account.' : `You can run up to ${max} strategies at once. Stop one first.`);
    const step = STEP_MS[s.interval as StrategyInterval];
    const [row] = await this.dbs.db
      .update(strategies)
      .set({
        status: 'RUNNING',
        startedAt: new Date(),
        startedSessionId: actor.sessionId,
        stoppedAt: null,
        stopReason: null,
        rejectStreak: 0,
        posQty: 0,
        entryPriceMinor: null,
        entryAt: null,
        // Start with the next candle to close; don't act on one that closed before the trader pressed Start.
        lastBarAt: new Date(bucketStart(Date.now(), step) - step),
        updatedAt: new Date(),
      })
      .where(and(eq(strategies.id, s.id), eq(strategies.userId, actor.userId)))
      .returning();
    const r = parseRules(row.rules);
    await this.event(row, 'STARTED', `Started (v${row.version}): ${r.side === 'LONG' ? 'buy' : 'sell'} ${row.quantity} when ${r.entry.map(conditionLabel).join(' and ')}.`);
    await this.audit.recordStandalone({ actor, action: 'strategy.started', entityType: 'strategy', entityId: row.id, outcome: 'SUCCESS', ip, metadata: { version: row.version, name: row.name } });
    return row;
  }

  async event(s: Pick<StrategyRow, 'id' | 'userId'>, kind: string, message: string, extra: { orderId?: string; pnlMinor?: bigint } = {}) {
    await this.dbs.db.insert(strategyEvents).values({ strategyId: s.id, userId: s.userId, kind, message: message.slice(0, 300), orderId: extra.orderId ?? null, pnlMinor: extra.pnlMinor ?? null });
  }
}
