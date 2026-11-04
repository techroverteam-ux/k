import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { AlgoRunnerService } from '../algo/algo-runner.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/context';
import { formatMoney } from '../common/money';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService } from '../db/db';
import { orders, positions, strategies, users } from '../db/schema';
import { MarketDataService } from '../market/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../trading/orders.service';

export type RiskState = 'OK' | 'WARN' | 'CUT';
export interface RiskView {
  userId: string;
  /** Money put into the account: opening balance + deposits − withdrawals (since the last wipe-out). */
  fundsMinor: bigint;
  /** Trading loss so far: booked P&L + brokerage + open P&L, as a positive number when losing. */
  lossMinor: bigint;
  /** lossMinor as a % of fundsMinor (0 when there are no funds or no loss). */
  lossPct: number;
  state: RiskState;
  openPositions: number;
}

const inr = (m: bigint) => `₹${(Number(m) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Loss watch for every trader with open trades.
 *
 * Loss = what the trader has lost from the funds in their account (booked P&L, brokerage and open P&L).
 *  - At `risk.warnLossPct` (80%) they get a notification; the apps beep and show a red warning.
 *  - At `risk.autoCutLossPct` (95%) every open trade is cut at market, open orders are cancelled and running
 *    strategies are stopped; the trader, their broker and the Super Admins are told. New trades that add exposure
 *    are refused until the loss is back under the warning level (e.g. after adding funds).
 * Example: ₹1,00,000 in the account → warning at ₹80,000 of loss, all trades cut at ₹95,000.
 *
 * Runs on price ticks (at most every 2 s) and every 5 s as a fallback. Paper trading: the cut orders are
 * simulated fills like every other order here.
 */
@Injectable()
export class RiskService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Risk');
  private timer?: NodeJS.Timeout;
  private running = false;
  private last = 0;
  private cutting = new Set<string>();

  constructor(
    private readonly dbs: DbService,
    private readonly market: MarketDataService,
    private readonly orders: OrdersService,
    private readonly algo: AlgoRunnerService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call check() directly
    this.timer = setInterval(() => void this.check(), 5_000);
    this.market.onTick(() => {
      if (Date.now() - this.last >= 2_000) void this.check();
    });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async levels() {
    const [warn, cut] = await Promise.all([this.config.get('risk.warnLossPct'), this.config.get('risk.autoCutLossPct')]);
    return { warnPct: warn, cutPct: Math.max(cut, warn) };
  }

  /** Funds, loss and state for these traders (open P&L from live prices). */
  async measure(ids: string[]): Promise<RiskView[]> {
    if (!ids.length) return [];
    const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const money = await this.dbs.db.execute<{ user_id: string; bal: string; traded: string; state: string }>(sql`
      SELECT u.id AS user_id, u.risk_state AS state,
             COALESCE(SUM(p.amount_minor), 0)::text AS bal,
             COALESCE(SUM(p.amount_minor) FILTER (WHERE j.kind IN ('TRADE_PNL', 'FEE') AND p.created_at >= COALESCE(u.data_since, '-infinity'::timestamptz)), 0)::text AS traded
        FROM users u
        JOIN ledger_accounts a ON a.owner_id = u.id AND a.type = 'TRADER_CASH' AND a.mode = 'SIMULATED'
        LEFT JOIN ledger_postings p ON p.account_id = a.id
        LEFT JOIN journal_entries j ON j.id = p.journal_id
       WHERE u.id IN (${list})
       GROUP BY u.id, u.risk_state`);
    const pos = await this.dbs.db.select().from(positions).where(and(inArray(positions.userId, ids), ne(positions.netQty, 0), eq(positions.mode, 'SIMULATED')));
    return money.rows.map((r) => {
      let open = 0n;
      let n = 0;
      for (const p of pos) {
        if (p.userId !== r.user_id) continue;
        n++;
        const q = this.market.quote(p.instrumentId);
        if (!q) continue;
        const mark = p.netQty > 0 ? q.bidMinor : q.askMinor;
        open += (mark - p.avgPriceMinor) * BigInt(p.netQty);
      }
      const traded = BigInt(r.traded);
      const funds = BigInt(r.bal) - traded; // balance without what trading added or took away
      const loss = -(traded + open);
      const lossPct = funds > 0n && loss > 0n ? Number((loss * 10_000n) / funds) / 100 : 0;
      return { userId: r.user_id, fundsMinor: funds, lossMinor: loss, lossPct, state: (r.state as RiskState) ?? 'OK', openPositions: n };
    });
  }

  async forUser(userId: string): Promise<RiskView & { warnPct: number; cutPct: number }> {
    const [v] = await this.measure([userId]);
    const l = await this.levels();
    return { ...(v ?? { userId, fundsMinor: 0n, lossMinor: 0n, lossPct: 0, state: 'OK' as RiskState, openPositions: 0 }), ...l };
  }

  /** One pass over every trader with open trades (or a warning in force). */
  async check() {
    if (this.running) return;
    this.running = true;
    this.last = Date.now();
    try {
      const held = await this.dbs.db.selectDistinct({ id: positions.userId }).from(positions).where(and(ne(positions.netQty, 0), eq(positions.mode, 'SIMULATED')));
      const flagged = await this.dbs.db.select({ id: users.id }).from(users).where(and(eq(users.role, 'TRADER'), ne(users.riskState, 'OK')));
      const ids = [...new Set([...held, ...flagged].map((x) => x.id))];
      if (!ids.length) return;
      const { warnPct, cutPct } = await this.levels();
      for (const v of await this.measure(ids)) {
        try {
          if (v.lossPct >= cutPct && v.openPositions > 0) await this.cut(v, cutPct);
          else if (v.lossPct >= warnPct && v.state === 'OK') await this.warn(v, warnPct, cutPct);
          else if (v.lossPct >= cutPct && v.state !== 'CUT') await this.setState(v.userId, 'CUT');
          else if (v.lossPct < warnPct - 5 && v.state !== 'OK') await this.setState(v.userId, 'OK'); // back to normal (e.g. funds added)
        } catch (e) {
          this.log.error(`Risk check for ${v.userId} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.error(`Risk check failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private setState(userId: string, state: RiskState) {
    return this.dbs.db.update(users).set({ riskState: state, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  private async warn(v: RiskView, warnPct: number, cutPct: number) {
    await this.dbs.db.transaction(async (tx) => {
      const [u] = await tx.update(users).set({ riskState: 'WARN', updatedAt: new Date() }).where(and(eq(users.id, v.userId), eq(users.riskState, 'OK'))).returning();
      if (!u) return; // someone else already warned
      await this.notifications.notify(tx, v.userId, 'risk.warning', `Loss alert: ${Math.floor(v.lossPct)}% of your funds`,
        `You have lost ${inr(v.lossMinor)} of ${inr(v.fundsMinor)} (warning at ${warnPct}%). At ${cutPct}% all your open trades are cut automatically.`);
      await this.audit.record(tx, { actor: null, action: 'risk.warning', entityType: 'user', entityId: v.userId, outcome: 'SUCCESS', metadata: { lossPct: v.lossPct, loss: v.lossMinor, funds: v.fundsMinor, warnPct } });
    });
  }

  /** Cut every open trade of this trader at market, cancel their open orders and stop their strategies. */
  private async cut(v: RiskView, cutPct: number) {
    if (this.cutting.has(v.userId)) return;
    this.cutting.add(v.userId);
    try {
      const actor: Actor = { userId: v.userId, role: 'TRADER', sessionId: v.userId, mfaVerified: true };
      // Running strategies close their own positions first.
      const running = await this.dbs.db.select().from(strategies).where(and(eq(strategies.userId, v.userId), eq(strategies.status, 'RUNNING')));
      for (const s of running) await this.algo.stop(s, `Stopped: loss reached ${cutPct}% of your funds.`, true).catch(() => undefined);
      // Open orders would reopen trades.
      const open = await this.dbs.db.select({ id: orders.id }).from(orders).where(and(eq(orders.userId, v.userId), eq(orders.status, 'OPEN')));
      for (const o of open) await this.orders.cancel(actor, o.id, 'risk').catch(() => undefined);

      const maxQty = await this.config.get('trading.maxQtyPerOrder');
      const pos = await this.dbs.db.select().from(positions).where(and(eq(positions.userId, v.userId), ne(positions.netQty, 0), eq(positions.mode, 'SIMULATED')));
      const cut: string[] = [];
      const failed: string[] = [];
      for (const p of pos) {
        const sym = this.market.instrument(p.instrumentId)?.symbol ?? p.instrumentId;
        let left = Math.abs(p.netQty);
        while (left > 0) {
          const qty = Math.min(left, maxQty);
          const o = await this.orders.place(actor, { instrumentId: p.instrumentId, side: p.netQty > 0 ? 'SELL' : 'BUY', type: 'MARKET', quantity: qty, idempotencyKey: `risk-${randomUUID()}` }, 'risk', { reason: 'risk' });
          if (o.status !== 'FILLED') { failed.push(`${sym}: ${o.rejectReason ?? o.status}`); break; }
          left -= qty;
        }
        if (left === 0) cut.push(`${sym} ${p.netQty > 0 ? '+' : ''}${p.netQty}`);
      }
      const done = failed.length === 0;
      if (done) await this.setState(v.userId, 'CUT');
      const [u] = await this.dbs.db.select({ username: users.username, brokerId: users.brokerId }).from(users).where(eq(users.id, v.userId));
      const body = `Loss reached ${Math.floor(v.lossPct)}% (${inr(v.lossMinor)} of ${inr(v.fundsMinor)}). ${cut.length ? `Cut: ${cut.join(', ')}.` : ''}${failed.length ? ` Not cut yet (will retry): ${failed.join('; ')}.` : ''}`;
      await this.dbs.db.transaction(async (tx) => {
        await this.notifications.notify(tx, v.userId, 'risk.autocut', `Trades cut automatically at ${cutPct}% loss`, `${body} Add funds to trade again.`);
        const staff = await tx.select({ id: users.id }).from(users).where(and(eq(users.status, 'ACTIVE'), or(eq(users.role, 'SUPER_ADMIN'), u?.brokerId ? eq(users.id, u.brokerId) : sql`false`)));
        for (const s of staff) await this.notifications.notify(tx, s.id, 'risk.autocut', `${u?.username ?? 'A trader'}: trades cut at ${cutPct}% loss`, body);
        await this.audit.record(tx, { actor: null, action: 'risk.autocut', entityType: 'user', entityId: v.userId, outcome: done ? 'SUCCESS' : 'FAILURE', metadata: { lossPct: v.lossPct, loss: v.lossMinor, funds: v.fundsMinor, cutPct, cut, failed } });
      });
      this.log.warn(`Auto-cut ${u?.username}: loss ${v.lossPct}% of ${formatMoney(v.fundsMinor)}; ${cut.length} cut, ${failed.length} failed`);
    } finally {
      this.cutting.delete(v.userId);
    }
  }

  /** Refuse new exposure while the account is at the auto-cut level. */
  async blockReason(userId: string): Promise<string | null> {
    const [u] = await this.dbs.db.select({ s: users.riskState }).from(users).where(eq(users.id, userId));
    if (u?.s !== 'CUT') return null;
    const { cutPct } = await this.levels();
    return `Your loss reached ${cutPct}% of your funds, so new trades are paused. Add funds to trade again.`;
  }
}
