import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AppError, badInput, notFound } from '../common/errors';
import { applyBps } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService, type Tx } from '../db/db';
import { orders, positions, users, type OrderRow } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService, type Quote } from '../market/market-data.service';
import { NotificationsService, pubsub, TOPIC } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { SimulatedVenue, type Side } from './execution-venue';
import { requestContext } from '../common/request-context';
import { env } from '../config/env';
import { ConsentService } from '../consent/consent.service';
import { sessionStatus, type Sessions } from './market-hours';

export interface PlaceOrderInput {
  instrumentId: string;
  side: Side;
  type: OrderType;
  quantity: number;
  limitPriceMinor?: bigint;
  /** STOP_LOSS / TAKE_PROFIT only. */
  triggerPriceMinor?: bigint;
  idempotencyKey: string;
}

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';
const abs = (n: number) => (n < 0 ? -n : n);
const isTrigger = (t: string) => t === 'STOP_LOSS' || t === 'TAKE_PROFIT';

/**
 * Has the last traded price reached the trigger?
 * SELL stop-loss / BUY take-profit fire when LTP falls to the trigger;
 * BUY stop-loss / SELL take-profit fire when LTP rises to it.
 */
export function triggerHit(type: OrderType, side: Side, trigger: bigint, ltp: bigint): boolean {
  const fallsTo = (type === 'STOP_LOSS' && side === 'SELL') || (type === 'TAKE_PROFIT' && side === 'BUY');
  return fallsTo ? ltp <= trigger : ltp >= trigger;
}

/**
 * Paper-trading order management. Every fill here is SIMULATED (venue = 'SIMULATED',
 * account mode = SIMULATED) and is labelled as such everywhere it is shown.
 */
@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly log = new Logger('Orders');
  private matching = false;

  constructor(
    private readonly dbs: DbService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService,
    private readonly market: MarketDataService,
    private readonly venue: SimulatedVenue,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly policy: PolicyService,
    private readonly consent: ConsentService,
  ) {}

  onModuleInit() {
    this.market.onTick((qs) => void this.matchOpenLimits(qs));
  }

  // ------------------------------------------------------------------ helpers

  async marginUsed(tx: Tx, userId: string, bps: number): Promise<bigint> {
    const pos = await tx
      .select({ q: positions.netQty, p: positions.avgPriceMinor })
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.mode, 'SIMULATED')));
    const open = await tx
      .select({ q: orders.quantity, p: sql<bigint | null>`coalesce(${orders.limitPriceMinor}, ${orders.triggerPriceMinor})`.mapWith((v) => (v === null ? null : BigInt(v))) })
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.status, 'OPEN')));
    let used = 0n;
    for (const r of pos) used += applyBps(BigInt(abs(r.q)) * r.p, bps);
    for (const r of open) used += applyBps(BigInt(r.q) * (r.p ?? 0n), bps);
    return used;
  }

  /** Session status for every configured exchange (for the order screen). */
  async sessions() {
    const [enforced, hours, holidays] = await Promise.all([
      this.config.get('trading.enforceMarketHours'),
      this.config.get('trading.marketHours'),
      this.config.get('trading.marketHolidays'),
    ]);
    const active = enforced && env().MARKET_HOURS === 'config';
    return {
      enforced: active,
      list: Object.keys(hours).map((ex) => {
        const st = sessionStatus(ex, hours as Sessions, holidays);
        return active ? st : { ...st, isOpen: true, message: null };
      }),
    };
  }

  /** null when the exchange is open (or hours are not enforced), otherwise the reason. */
  private async closedReason(exchange: string): Promise<string | null> {
    const s = await this.sessions();
    return s.list.find((x) => x.exchange === exchange)?.message ?? null;
  }

  /** Quote a would-be order (for the trade ticket): value and margins. Read-only. */
  async preview(instrumentId: string, side: Side, quantity: number, limitPriceMinor?: bigint, triggerPriceMinor?: bigint) {
    const q = this.market.quote(instrumentId);
    if (!q) throw notFound('Instrument');
    const price = limitPriceMinor ?? triggerPriceMinor ?? this.venue.marketFillPrice(side, q);
    const value = price * BigInt(quantity);
    return {
      priceMinor: price,
      valueMinor: value,
      intradayMarginMinor: applyBps(value, await this.config.get('trading.intradayMarginBps')),
      carryForwardMarginMinor: applyBps(value, await this.config.get('trading.carryForwardMarginBps')),
      brokerageMinor: applyBps(value, await this.config.get('trading.brokerageBps')),
    };
  }

  // ------------------------------------------------------------------ place / cancel

  /**
   * Place an order for the actor's own account.
   * `automation` is for orders placed by a running strategy (algo/): the trader accepted the trading rules
   * when they started it (checked there), so the per-session consent check is skipped, and the order is
   * stamped with the strategy. Every other check below applies exactly as for a manual order.
   */
  async place(actor: Actor, input: PlaceOrderInput, ip: string, automation?: { strategyId: string }): Promise<OrderRow> {
    if (actor.role !== 'TRADER') throw new AppError('FORBIDDEN', 'Only traders can place orders on their own account.');
    if (!automation) await this.consent.assertConsented(actor); // rules accepted for this signed-in session
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw badInput('Quantity must be a positive whole number.');
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(input.idempotencyKey)) throw badInput('Invalid idempotency key.');
    if (input.type === 'LIMIT' && (!input.limitPriceMinor || input.limitPriceMinor <= 0n)) throw badInput('Enter a limit price.');
    if (input.type !== 'LIMIT' && input.limitPriceMinor) throw badInput('Only limit orders take a limit price.');
    if (isTrigger(input.type) && (!input.triggerPriceMinor || input.triggerPriceMinor <= 0n)) throw badInput('Enter a trigger price.');
    if (!isTrigger(input.type) && input.triggerPriceMinor) throw badInput('Only stop-loss and take-profit orders take a trigger price.');
    const inst = this.market.instrument(input.instrumentId);
    if (!inst) throw notFound('Instrument');
    for (const px of [input.limitPriceMinor, input.triggerPriceMinor])
      if (px && px % BigInt(inst.tickMinor) !== 0n) throw badInput(`Price must be a multiple of the tick size (${Number(inst.tickMinor) / 100}).`);

    const [cfgMin, cfgMax, cfgMaxPos, bps, feeBps, closed] = await Promise.all([
      this.config.get('trading.minQty'),
      this.config.get('trading.maxQtyPerOrder'),
      this.config.get('trading.maxQtyPerInstrument'),
      this.config.get('trading.intradayMarginBps'),
      this.config.get('trading.brokerageBps'),
      this.closedReason(inst.exchange),
    ]);

    const result = await this.dbs.serializable(async (tx) => {
      const [dup] = await tx.select().from(orders).where(and(eq(orders.userId, actor.userId), eq(orders.idempotencyKey, input.idempotencyKey)));
      if (dup) return { order: dup, replay: true };

      const [u] = await tx.select().from(users).where(eq(users.id, actor.userId));
      if (u.mode !== 'SIMULATED') throw new AppError('NOT_ENABLED', 'Live trading is not enabled on this platform.');
      const cash = await this.ledger.cashAccount(tx, u.id, 'SIMULATED');
      await this.ledger.lock(tx, cash); // serialize this user's order flow

      const q = this.market.quote(inst.id)!;
      const [pos] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, u.id), eq(positions.instrumentId, inst.id), eq(positions.mode, 'SIMULATED')));
      const net = pos?.netQty ?? 0;
      const signed = input.side === 'BUY' ? input.quantity : -input.quantity;
      const after = net + signed;
      const exposureIncrease = Math.max(0, abs(after) - abs(net));
      const refPrice = input.limitPriceMinor ?? input.triggerPriceMinor ?? this.venue.marketFillPrice(input.side, q);

      let reject: string | null = null;
      if (input.quantity < cfgMin) reject = `Minimum quantity is ${cfgMin}.`;
      else if (input.quantity > cfgMax) reject = `Maximum ${cfgMax} per order.`;
      else if (abs(after) > cfgMaxPos) reject = `Position limit is ${cfgMaxPos} for this instrument.`;
      else if (closed) reject = closed;
      else if (isTrigger(input.type) && triggerHit(input.type, input.side, input.triggerPriceMinor!, q.ltpMinor))
        reject = `Trigger ${(Number(input.triggerPriceMinor) / 100).toFixed(2)} is already reached (LTP ${(Number(q.ltpMinor) / 100).toFixed(2)}). Use a market order or move the trigger.`;
      if (!reject && exposureIncrease > 0) {
        const need = applyBps(refPrice * BigInt(exposureIncrease), bps) + applyBps(refPrice * BigInt(input.quantity), feeBps);
        const balance = await this.ledger.balance(tx, cash);
        const free = balance - (await this.marginUsed(tx, u.id, bps));
        if (need > free) reject = 'Insufficient margin.';
      }

      const [o] = await tx
        .insert(orders)
        .values({
          userId: u.id,
          instrumentId: inst.id,
          side: input.side,
          type: input.type,
          quantity: input.quantity,
          limitPriceMinor: input.limitPriceMinor ?? null,
          triggerPriceMinor: input.triggerPriceMinor ?? null,
          status: reject ? 'REJECTED' : 'OPEN',
          rejectReason: reject,
          mode: 'SIMULATED',
          venue: this.venue.name,
          idempotencyKey: input.idempotencyKey,
          placedById: actor.userId,
          clientIp: requestContext.get()?.ip ?? ip,
          userAgent: requestContext.get()?.userAgent,
          sessionId: actor.sessionId,
          requestId: requestContext.get()?.requestId,
          strategyId: automation?.strategyId ?? null,
        })
        .returning();

      let final = o;
      if (!reject && input.type === 'MARKET') final = await this.fill(tx, o, this.venue.marketFillPrice(input.side, q), feeBps);
      else if (!reject && input.type === 'LIMIT') {
        const px = this.venue.limitFillPrice(input.side, input.limitPriceMinor!, q);
        if (px !== null) final = await this.fill(tx, o, px, feeBps);
      }
      await this.audit.record(tx, {
        actor,
        action: reject ? 'order.rejected' : 'order.placed',
        entityType: 'order',
        entityId: o.id,
        outcome: reject ? 'DENIED' : 'SUCCESS',
        ip,
        metadata: { symbol: inst.symbol, side: o.side, type: o.type, qty: o.quantity, limit: o.limitPriceMinor, trigger: o.triggerPriceMinor, status: final.status, reason: reject, venue: 'SIMULATED', strategyId: automation?.strategyId },
      });
      return { order: final, replay: false };
    });
    if (!result.replay) void pubsub.publish(TOPIC.orderUpdate(actor.userId), { orderUpdated: result.order });
    return result.order;
  }

  async cancel(actor: Actor, orderId: string, ip: string) {
    const o = await this.dbs.serializable(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!o || o.userId !== actor.userId) throw notFound('Order');
      if (o.status !== 'OPEN') throw badInput(`Order is already ${o.status.toLowerCase()}.`);
      const [c] = await tx.update(orders).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(orders.id, o.id)).returning();
      await this.audit.record(tx, { actor, action: 'order.cancelled', entityType: 'order', entityId: o.id, outcome: 'SUCCESS', ip });
      return c;
    });
    void pubsub.publish(TOPIC.orderUpdate(actor.userId), { orderUpdated: o });
    return o;
  }

  // ------------------------------------------------------------------ fills

  /** Apply a simulated fill: update the order and position, post P&L and fees to the ledger. */
  private async fill(tx: Tx, o: OrderRow, price: bigint, feeBps: number, triggered = false): Promise<OrderRow> {
    const [filled] = await tx
      .update(orders)
      .set({ status: 'FILLED', fillPriceMinor: price, filledAt: new Date(), updatedAt: new Date(), ...(triggered ? { triggeredAt: new Date() } : {}) })
      .where(and(eq(orders.id, o.id), eq(orders.status, 'OPEN')))
      .returning();
    if (!filled) return o; // someone else filled/cancelled it

    await tx
      .insert(positions)
      .values({ userId: o.userId, instrumentId: o.instrumentId, mode: 'SIMULATED' })
      .onConflictDoNothing();
    const [p] = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.userId, o.userId), eq(positions.instrumentId, o.instrumentId), eq(positions.mode, 'SIMULATED')))
      .for('update');

    const signed = o.side === 'BUY' ? o.quantity : -o.quantity;
    const net = p.netQty;
    let avg = p.avgPriceMinor;
    let realized = 0n;
    const newNet = net + signed;
    if (net === 0 || Math.sign(net) === Math.sign(signed)) {
      avg = (avg * BigInt(abs(net)) + price * BigInt(abs(signed))) / BigInt(abs(newNet));
    } else {
      const closed = Math.min(abs(net), abs(signed));
      realized = (price - avg) * BigInt(closed) * (net > 0 ? 1n : -1n);
      if (newNet === 0) avg = 0n;
      else if (Math.sign(newNet) !== Math.sign(net)) avg = price; // flipped: remainder opens at fill price
    }
    await tx
      .update(positions)
      .set({ netQty: newNet, avgPriceMinor: avg, realizedPnlMinor: p.realizedPnlMinor + realized, updatedAt: new Date() })
      .where(eq(positions.id, p.id));

    const cash = await this.ledger.cashAccount(tx, o.userId, 'SIMULATED');
    if (realized !== 0n) {
      const pnlAcct = await this.ledger.systemAccount(tx, 'SIM_MARKET_PNL', 'SIMULATED');
      await this.ledger.post(tx, {
        idempotencyKey: `pnl:${o.id}`,
        kind: 'TRADE_PNL',
        mode: 'SIMULATED',
        memo: `Simulated P&L ${o.side} ${o.quantity}`,
        postings: [
          { accountId: cash, amountMinor: realized },
          { accountId: pnlAcct, amountMinor: -realized },
        ],
        refType: 'order',
        refId: o.id,
      });
    }
    const fee = applyBps(price * BigInt(o.quantity), feeBps);
    if (fee > 0n) {
      const feeAcct = await this.ledger.systemAccount(tx, 'FEE_INCOME', 'SIMULATED');
      await this.ledger.post(tx, {
        idempotencyKey: `fee:${o.id}`,
        kind: 'FEE',
        mode: 'SIMULATED',
        memo: `Simulated brokerage ${o.side} ${o.quantity}`,
        postings: [
          { accountId: cash, amountMinor: -fee },
          { accountId: feeAcct, amountMinor: fee },
        ],
        refType: 'order',
        refId: o.id,
      });
    }
    await this.notifications.notify(
      tx,
      o.userId,
      'order.filled',
      triggered ? `${o.type === 'STOP_LOSS' ? 'Stop-loss' : 'Take-profit'} triggered` : `Simulated order filled`,
      `${o.side} ${o.quantity} @ ${(Number(price) / 100).toFixed(2)}${triggered ? ' at LTP' : ''} (simulated fill — not an exchange trade)`,
    );
    return filled;
  }

  private async matchOpenLimits(changed: Quote[]) {
    if (this.matching) return;
    this.matching = true;
    try {
      const ids = changed.map((q) => q.instrumentId);
      const open = await this.dbs.db
        .select()
        .from(orders)
        .where(and(eq(orders.status, 'OPEN'), inArray(orders.type, ['LIMIT', 'STOP_LOSS', 'TAKE_PROFIT']), inArray(orders.instrumentId, ids)))
        .limit(500);
      if (!open.length) return;
      const feeBps = await this.config.get('trading.brokerageBps');
      const sessions = await this.sessions();
      for (const o of open) {
        const q = this.market.quote(o.instrumentId);
        if (!q) continue;
        const inst = this.market.instrument(o.instrumentId);
        if (inst && sessions.list.find((x) => x.exchange === inst.exchange)?.isOpen === false) continue; // no fills while the market is closed
        const trig = isTrigger(o.type);
        // SL/TP orders are passed at the last traded price once the LTP reaches the trigger.
        const px = trig ? (triggerHit(o.type, o.side, o.triggerPriceMinor!, q.ltpMinor) ? q.ltpMinor : null) : this.venue.limitFillPrice(o.side, o.limitPriceMinor!, q);
        if (px === null) continue;
        try {
          const filled = await this.dbs.serializable(async (tx) => {
            const cash = await this.ledger.cashAccount(tx, o.userId, 'SIMULATED');
            await this.ledger.lock(tx, cash);
            const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
            if (cur?.status !== 'OPEN') return null;
            const f = await this.fill(tx, cur, px, feeBps, trig);
            // System action (matcher): no request IP of its own, so record where the order was placed from.
            await this.audit.record(tx, { action: trig ? 'order.triggered' : 'order.filled', entityType: 'order', entityId: o.id, outcome: 'SUCCESS', metadata: { price: px, type: o.type, trigger: o.triggerPriceMinor, venue: 'SIMULATED', userId: o.userId, placedFromIp: o.clientIp, placedSessionId: o.sessionId } });
            return f;
          });
          if (filled) void pubsub.publish(TOPIC.orderUpdate(o.userId), { orderUpdated: filled });
        } catch (e) {
          this.log.error(`limit match failed for ${o.id}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.matching = false;
    }
  }

  // ------------------------------------------------------------------ reads (scoped)

  async listOrders(actor: Actor, userId: string, opts: { status?: OrderRow['status'][]; limit: number; before?: Date }, ip?: string) {
    await this.policy.assertCanAccessUser(actor, userId, ip);
    return this.dbs.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          opts.status?.length ? inArray(orders.status, opts.status) : undefined,
          opts.before ? lt(orders.createdAt, opts.before) : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(opts.limit);
  }

  async listPositions(actor: Actor, userId: string, ip?: string) {
    await this.policy.assertCanAccessUser(actor, userId, ip);
    return this.dbs.db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), sql`(${positions.netQty} <> 0 OR ${positions.realizedPnlMinor} <> 0)`))
      .orderBy(desc(positions.updatedAt));
  }
}
