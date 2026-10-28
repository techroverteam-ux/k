import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/context';
import { applyBps, formatMoney } from '../common/money';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService } from '../db/db';
import { strategies, users, type StrategyRow } from '../db/schema';
import { bucketStart } from '../market/candles';
import { MarketDataService, type Quote } from '../market/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../trading/orders.service';
import { AlgoService, IV, STEP_MS, type StrategyInterval } from './algo.service';
import { entrySignal, exitSignal, Indicators, stopLevels } from './engine';
import { conditionLabel, parseRules, warmup, type Rules } from './rules';

const CYCLE_MS = 5_000;
const SETTLE_MS = 2_000; // wait this long after a candle closes so its last ticks are in
const MAX_REJECTS = 3;

/**
 * Runs RUNNING strategies on the simulated feed (paper trading only).
 * - Every few seconds: for each strategy whose candle just closed, evaluate entry / exit rules on that candle.
 * - On every price tick: stop-loss / take-profit for strategies holding a position.
 * - Guardrails: max daily loss (realised today + open P&L), max orders per day, account must be active,
 *   repeated rejections stop the strategy. Stopping flattens the strategy's position.
 * Orders go through OrdersService.place, so margin, quantity limits, market hours, audit and idempotency
 * all apply; every idempotency key is derived from the strategy and the candle/entry, so a retry or a second
 * API instance can never double-trade. A Postgres advisory lock keeps one runner active at a time.
 */
@Injectable()
export class AlgoRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AlgoRunner');
  private timer?: NodeJS.Timeout;
  private cycling = false;
  /** Running strategies with an open position, by instrument (for tick-level stop-loss / take-profit). */
  private open = new Map<string, StrategyRow[]>();
  private busy = new Set<string>();

  constructor(
    private readonly dbs: DbService,
    private readonly market: MarketDataService,
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
    private readonly algo: AlgoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.cycle(), CYCLE_MS);
    this.market.onTick((qs) => void this.onTicks(qs));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ main loop

  async cycle(now = Date.now()) {
    if (this.cycling) return;
    this.cycling = true;
    const client = await this.dbs.pool.connect().catch(() => null);
    if (!client) { this.cycling = false; return; }
    try {
      const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('td_algo_runner')) AS ok`);
      if (!rows[0]?.ok) return; // another API instance is running strategies
      try {
        const enabled = await this.config.get('algo.enabled');
        const running = await this.dbs.db.select().from(strategies).where(eq(strategies.status, 'RUNNING'));
        const open = new Map<string, StrategyRow[]>();
        for (const s of running) {
          try {
            if (!enabled) { await this.stop(s, 'Automated trading was turned off by an administrator.', true); continue; }
            const live = await this.step(s, now);
            if (live && live.status === 'RUNNING' && live.posQty !== 0) open.set(live.instrumentId, [...(open.get(live.instrumentId) ?? []), live]);
          } catch (e) {
            this.log.error(`strategy ${s.id}: ${(e as Error).message}`);
            await this.algo.event(s, 'ERROR', 'Something went wrong while evaluating this candle. It will retry on the next one.');
          }
        }
        this.open = open;
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('td_algo_runner'))`);
      }
    } catch (e) {
      this.log.error(`cycle failed: ${(e as Error).message}`);
    } finally {
      client.release();
      this.cycling = false;
    }
  }

  /** One strategy, one cycle. Returns the latest row. */
  private async step(s: StrategyRow, now: number): Promise<StrategyRow | null> {
    if (this.busy.has(s.id)) return s; // a stop-loss / take-profit exit is in flight
    // The owner must still be an active trader.
    const [u] = await this.dbs.db.select({ status: users.status, role: users.role }).from(users).where(eq(users.id, s.userId));
    if (!u || u.status !== 'ACTIVE' || u.role !== 'TRADER') return this.stop(s, 'The account is no longer active.', true);

    const rules = parseRules(s.rules);
    const today = await this.algo.today([s.id]);
    const t = today.get(s.id)!;

    // Max daily loss, including the open position at the current price.
    const q = this.market.quote(s.instrumentId);
    const openPnl = s.posQty !== 0 && q && s.entryPriceMinor !== null ? (q.ltpMinor - s.entryPriceMinor) * BigInt(s.posQty) : 0n;
    if (t.pnl + openPnl <= -s.maxDailyLossMinor) {
      return this.stop(s, `Daily loss limit reached (₹${formatMoney(-(t.pnl + openPnl))} ≥ ₹${formatMoney(s.maxDailyLossMinor)}).`, true);
    }

    // Has a new candle closed since the last one we evaluated?
    const iv = s.interval as StrategyInterval;
    const step = STEP_MS[iv];
    const current = bucketStart(now, step);
    const closed = current - step;
    if (now - current < SETTLE_MS) return s;
    if (s.lastBarAt && s.lastBarAt.getTime() >= closed) return s;

    const bars = await this.market.candles(s.instrumentId, IV[iv], warmup(rules) + 5, current);
    const i = bars.length - 1;
    let row = s;
    if (i >= 1 && bars[i].t === closed) {
      const ind = new Indicators(bars);
      if (s.posQty === 0 && entrySignal(ind, rules, i)) {
        if (t.orders >= s.maxOrdersPerDay) await this.algo.event(s, 'BLOCKED', `Entry signal skipped: ${s.maxOrdersPerDay} orders already placed today (your limit).`);
        else row = (await this.enter(s, rules, closed)) ?? row;
      } else if (s.posQty !== 0 && exitSignal(ind, rules, i)) {
        const hit = rules.exit.find((c) => exitSignalOne(ind, c, i));
        row = (await this.exit(s, hit ? `exit rule: ${conditionLabel(hit)}` : 'exit rule')) ?? row;
      }
    }
    if (row.status !== 'RUNNING') return row;
    const [upd] = await this.dbs.db.update(strategies).set({ lastBarAt: new Date(closed) }).where(eq(strategies.id, s.id)).returning();
    return upd ?? row;
  }

  // ------------------------------------------------------------------ ticks: stop-loss / take-profit

  private async onTicks(qs: Quote[]) {
    for (const q of qs) {
      for (const s of this.open.get(q.instrumentId) ?? []) {
        if (this.busy.has(s.id) || s.posQty === 0 || s.entryPriceMinor === null) continue;
        const rules = parseRules(s.rules);
        const { sl, tp } = stopLevels(rules, Number(s.entryPriceMinor));
        const ltp = Number(q.ltpMinor);
        const long = s.posQty > 0;
        const slHit = sl !== null && (long ? ltp <= sl : ltp >= sl);
        const tpHit = tp !== null && (long ? ltp >= tp : ltp <= tp);
        if (!slHit && !tpHit) continue;
        this.busy.add(s.id);
        void (async () => {
          try {
            const [fresh] = await this.dbs.db.select().from(strategies).where(eq(strategies.id, s.id));
            if (fresh?.status === 'RUNNING' && fresh.posQty !== 0) {
              await this.exit(fresh, slHit ? `stop-loss ₹${formatMoney(BigInt(sl!))}` : `take-profit ₹${formatMoney(BigInt(tp!))}`);
              this.open.set(q.instrumentId, (this.open.get(q.instrumentId) ?? []).filter((x) => x.id !== s.id));
            }
          } catch (e) {
            this.log.error(`stop check ${s.id}: ${(e as Error).message}`);
          } finally {
            this.busy.delete(s.id);
          }
        })();
      }
    }
  }

  // ------------------------------------------------------------------ orders

  private actor(s: StrategyRow): Actor {
    // The trader's own account, acting under the session in which they pressed Start.
    return { userId: s.userId, role: 'TRADER', sessionId: s.startedSessionId ?? s.userId, mfaVerified: true };
  }

  private async enter(s: StrategyRow, rules: Rules, barT: number): Promise<StrategyRow | null> {
    const side = rules.side === 'LONG' ? 'BUY' : 'SELL';
    const o = await this.orders.place(this.actor(s), { instrumentId: s.instrumentId, side, type: 'MARKET', quantity: s.quantity, idempotencyKey: `algo-${s.id}-v${s.version}-${barT}-in` }, 'algo', { strategyId: s.id });
    if (o.status !== 'FILLED' || o.fillPriceMinor === null) return this.rejected(s, `Entry ${side} ${s.quantity} not filled: ${o.rejectReason ?? o.status}.`, o.id);
    const signed = side === 'BUY' ? s.quantity : -s.quantity;
    const [row] = await this.dbs.db
      .update(strategies)
      .set({ posQty: signed, entryPriceMinor: o.fillPriceMinor, entryAt: o.filledAt ?? new Date(), rejectStreak: 0, updatedAt: new Date() })
      .where(and(eq(strategies.id, s.id), eq(strategies.posQty, 0)))
      .returning();
    const { sl, tp } = stopLevels(rules, Number(o.fillPriceMinor));
    const extras = [sl !== null ? `SL ₹${formatMoney(BigInt(sl))}` : '', tp !== null ? `TP ₹${formatMoney(BigInt(tp))}` : ''].filter(Boolean).join(', ');
    await this.algo.event(s, 'ENTRY', `${side} ${s.quantity} @ ₹${formatMoney(o.fillPriceMinor)} (${rules.entry.map(conditionLabel).join(' and ')})${extras ? `. ${extras}` : ''}.`, { orderId: o.id });
    return row ?? s;
  }

  /** Close the strategy's position at market. */
  private async exit(s: StrategyRow, label: string): Promise<StrategyRow | null> {
    if (s.posQty === 0 || s.entryPriceMinor === null) return s;
    const side = s.posQty > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(s.posQty);
    const entryKey = s.entryAt ? s.entryAt.getTime() : 0;
    const o = await this.orders.place(this.actor(s), { instrumentId: s.instrumentId, side, type: 'MARKET', quantity: qty, idempotencyKey: `algo-${s.id}-${entryKey}-out${s.rejectStreak}` }, 'algo', { strategyId: s.id });
    if (o.status !== 'FILLED' || o.fillPriceMinor === null) return this.rejected(s, `Exit ${side} ${qty} not filled (${label}): ${o.rejectReason ?? o.status}. Will retry.`, o.id);
    const feeBps = await this.config.get('trading.brokerageBps');
    const fees = applyBps(s.entryPriceMinor * BigInt(qty), feeBps) + applyBps(o.fillPriceMinor * BigInt(qty), feeBps);
    const pnl = (o.fillPriceMinor - s.entryPriceMinor) * BigInt(s.posQty) - fees;
    // Only the caller that actually closes this position records the trade (a tick and a candle can race;
    // the shared idempotency key already stops a second order).
    const [row] = await this.dbs.db
      .update(strategies)
      .set({ posQty: 0, entryPriceMinor: null, entryAt: null, rejectStreak: 0, updatedAt: new Date() })
      .where(and(eq(strategies.id, s.id), eq(strategies.posQty, s.posQty), eq(strategies.entryPriceMinor, s.entryPriceMinor)))
      .returning();
    if (!row) {
      const [fresh] = await this.dbs.db.select().from(strategies).where(eq(strategies.id, s.id));
      return fresh ?? s;
    }
    await this.algo.event(s, 'EXIT', `${side} ${qty} @ ₹${formatMoney(o.fillPriceMinor)} (${label}). Trade P&L ₹${formatMoney(pnl)} after fees.`, { orderId: o.id, pnlMinor: pnl });
    return row;
  }

  private async rejected(s: StrategyRow, message: string, orderId: string): Promise<StrategyRow | null> {
    await this.algo.event(s, 'BLOCKED', message, { orderId });
    const [row] = await this.dbs.db.update(strategies).set({ rejectStreak: sql`${strategies.rejectStreak} + 1` }).where(eq(strategies.id, s.id)).returning();
    if (row && row.rejectStreak >= MAX_REJECTS) return this.stop(row, `Stopped after ${MAX_REJECTS} rejected orders in a row. Check the event log.`, false);
    return row ?? s;
  }

  // ------------------------------------------------------------------ stop (also the kill switch)

  /**
   * Stop a strategy. With `flatten`, its open position is closed at market first (best effort: if the
   * exit is rejected, e.g. the market is closed, the position stays open and the event log says so).
   */
  async stop(s: StrategyRow, reason: string, flatten: boolean, actor?: Actor, ip?: string): Promise<StrategyRow> {
    let cur = s;
    if (flatten && s.posQty !== 0) {
      try {
        cur = (await this.exit(s, 'strategy stopped')) ?? s;
      } catch (e) {
        await this.algo.event(s, 'ERROR', `Couldn't close the open position: ${(e as Error).message}`);
      }
    }
    const [row] = await this.dbs.db
      .update(strategies)
      .set({ status: 'STOPPED', stoppedAt: new Date(), stopReason: reason.slice(0, 200), updatedAt: new Date() })
      .where(eq(strategies.id, s.id))
      .returning();
    const left = row && row.posQty !== 0 ? ` Position of ${row.posQty} is still open; close it from Positions.` : '';
    await this.algo.event(s, 'STOPPED', `${reason}${left}`);
    await this.notifications.notify(this.dbs.db, s.userId, 'algo.stopped', `Strategy stopped: ${s.name}`, `${reason}${left}`).catch(() => undefined);
    await this.audit.recordStandalone({ actor: actor ?? null, action: 'strategy.stopped', entityType: 'strategy', entityId: s.id, outcome: 'SUCCESS', ip, metadata: { reason, flatten, by: actor ? 'user' : 'system' } });
    for (const [k, list] of this.open) this.open.set(k, list.filter((x) => x.id !== s.id));
    return row ?? cur;
  }

  /** Stop from the trader (Stop button). */
  async stopByOwner(actor: Actor, id: string, flatten: boolean, ip: string) {
    const s = await this.algo.owned(actor, id);
    if (s.status !== 'RUNNING') return s;
    this.busy.add(s.id);
    try {
      return await this.stop(s, flatten ? 'Stopped by you; position closed.' : 'Stopped by you.', flatten, actor, ip);
    } finally {
      this.busy.delete(s.id);
    }
  }

  /** Kill switch: stop every running strategy of this trader. */
  async stopAllForOwner(actor: Actor, ip: string) {
    const list = await this.dbs.db.select().from(strategies).where(and(eq(strategies.userId, actor.userId), eq(strategies.status, 'RUNNING')));
    for (const s of list) await this.stop(s, 'Stopped by you (stop all); position closed.', true, actor, ip);
    return list.length;
  }
}

function exitSignalOne(ind: Indicators, c: Rules['exit'][number], i: number) {
  return exitSignal(ind, { side: 'LONG', entry: [c], exit: [c] }, i);
}
