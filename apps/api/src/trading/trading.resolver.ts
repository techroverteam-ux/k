import { Args, Context, Field, ID, InputType, Int, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor } from '../common/context';
import { badInput, unauthenticated } from '../common/errors';
import {
  AccountSummary,
  Instrument,
  LedgerLine,
  m,
  Order,
  OrderPreview,
  OrderSideGql,
  OrderStatusGql,
  OrderTypeGql,
  PeriodSummary,
  Position,
  TradingRules,
} from '../common/gql-types';
import { ConfigService } from '../config-mgmt/config.service';
import { clampLimit, toInstrument, toOrder } from '../common/mappers';
import { formatMoney, parseMoney } from '../common/money';
import { DbService } from '../db/db';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market/market-data.service';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { OrdersService } from './orders.service';

@InputType()
class PlaceOrderInput {
  @Field(() => ID) instrumentId: string;
  @Field(() => OrderSideGql) side: OrderSideGql;
  @Field(() => OrderTypeGql) type: OrderTypeGql;
  @Field(() => Int) quantity: number;
  @Field({ nullable: true, description: 'Required for LIMIT. Decimal rupees, e.g. "6350.05".' }) limitPrice?: string;
  @Field({ nullable: true, description: 'Required for STOP_LOSS / TAKE_PROFIT: the LTP that triggers the order (filled at LTP).' }) triggerPrice?: string;
  @Field({ description: 'Client-generated unique key (UUID). Retries with the same key never create a second order.' }) idempotencyKey: string;
}

function parsePrice(s?: string) {
  if (s === undefined || s === null || s === '') return undefined;
  try {
    return parseMoney(s);
  } catch {
    throw badInput('Invalid price.');
  }
}

@Resolver(() => Order)
export class OrderFieldsResolver {
  @ResolveField(() => Instrument, { nullable: true })
  async instrument(@Parent() o: Order, @Context() c: GqlContext) {
    const i = await c.loaders.instrument.load(o.instrumentId);
    return i ? toInstrument(i) : null;
  }
}

@Resolver(() => Position)
export class PositionFieldsResolver {
  @ResolveField(() => Instrument, { nullable: true })
  async instrument(@Parent() p: Position, @Context() c: GqlContext) {
    const i = await c.loaders.instrument.load(p.instrumentId);
    return i ? toInstrument(i) : null;
  }
}

@Resolver()
export class TradingResolver {
  constructor(
    private readonly orderSvc: OrdersService,
    private readonly users: UsersService,
    private readonly ledger: LedgerService,
    private readonly market: MarketDataService,
    private readonly dbs: DbService,
    private readonly config: ConfigService,
  ) {}

  @Query(() => OrderPreview)
  async orderPreview(
    @Args('instrumentId', { type: () => ID }) instrumentId: string,
    @Args('side', { type: () => OrderSideGql }) side: OrderSideGql,
    @Args('quantity', { type: () => Int }) quantity: number,
    @Args('limitPrice', { nullable: true }) limitPrice?: string,
    @Args('triggerPrice', { nullable: true }) triggerPrice?: string,
  ): Promise<OrderPreview> {
    if (quantity <= 0 || quantity > 1_000_000) throw badInput('Invalid quantity.');
    const p = await this.orderSvc.preview(instrumentId, side, quantity, parsePrice(limitPrice), parsePrice(triggerPrice));
    return {
      price: formatMoney(p.priceMinor),
      value: formatMoney(p.valueMinor),
      intradayMargin: formatMoney(p.intradayMarginMinor),
      carryForwardMargin: formatMoney(p.carryForwardMarginMinor),
      brokerage: formatMoney(p.brokerageMinor),
    };
  }

  @Query(() => TradingRules)
  async tradingRules(): Promise<TradingRules> {
    const [minQty, maxQtyPerOrder, maxQtyPerInstrument, s] = await Promise.all([
      this.config.get('trading.minQty'),
      this.config.get('trading.maxQtyPerOrder'),
      this.config.get('trading.maxQtyPerInstrument'),
      this.orderSvc.sessions(),
    ]);
    return { minQty, maxQtyPerOrder, maxQtyPerInstrument, marketHoursEnforced: s.enforced, sessions: s.list.map((x) => ({ ...x, message: x.message ?? undefined })) };
  }

  @Mutation(() => Order, { description: 'Places a SIMULATED (paper) order. Rejected orders are returned with status REJECTED.' })
  async placeOrder(@CurrentActor() a: Actor, @Args('input') input: PlaceOrderInput, @Ctx() c: GqlContext) {
    const o = await this.orderSvc.place(
      a,
      { instrumentId: input.instrumentId, side: input.side, type: input.type, quantity: input.quantity, limitPriceMinor: parsePrice(input.limitPrice), triggerPriceMinor: parsePrice(input.triggerPrice), idempotencyKey: input.idempotencyKey },
      c.ip,
    );
    return toOrder(o);
  }

  @Mutation(() => Order)
  async cancelOrder(@CurrentActor() a: Actor, @Args('orderId', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toOrder(await this.orderSvc.cancel(a, id, c.ip));
  }

  @Query(() => [Order])
  async orders(
    @CurrentActor() a: Actor,
    @Ctx() c: GqlContext,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('status', { type: () => [OrderStatusGql], nullable: true }) status?: OrderStatusGql[],
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('before', { nullable: true }) before?: Date,
  ) {
    const rows = await this.orderSvc.listOrders(a, userId ?? a.userId, { status: status as any, limit: clampLimit(limit), before }, c.ip);
    return rows.map(toOrder);
  }

  @Query(() => [Position])
  async positions(@CurrentActor() a: Actor, @Ctx() c: GqlContext, @Args('userId', { type: () => ID, nullable: true }) userId?: string): Promise<Position[]> {
    const rows = await this.orderSvc.listPositions(a, userId ?? a.userId, c.ip);
    return rows.map((p) => {
      const q = this.market.quote(p.instrumentId);
      const mark = q ? (p.netQty > 0 ? q.bidMinor : q.askMinor) : undefined;
      return {
        id: p.id,
        instrumentId: p.instrumentId,
        mode: p.mode,
        netQty: p.netQty,
        avgPrice: formatMoney(p.avgPriceMinor),
        realizedPnl: formatMoney(p.realizedPnlMinor),
        unrealizedPnl: mark !== undefined && p.netQty !== 0 ? formatMoney((mark - p.avgPriceMinor) * BigInt(p.netQty)) : '0.00',
        ltp: q ? formatMoney(q.ltpMinor) : undefined,
      };
    });
  }

  @Query(() => AccountSummary)
  async accountSummary(@CurrentActor() a: Actor, @Ctx() c: GqlContext, @Args('userId', { type: () => ID, nullable: true }) userId?: string): Promise<AccountSummary> {
    const s = await this.users.accountSummary(a, userId ?? a.userId, c.ip);
    return {
      userId: s.userId,
      mode: s.mode,
      balance: m(s.balanceMinor)!,
      marginUsed: m(s.marginUsedMinor)!,
      available: m(s.availableMinor)!,
      deposits: m(s.depositsMinor)!,
      withdrawals: m(s.withdrawalsMinor)!,
      realizedPnl: m(s.realizedPnlMinor)!,
      unrealizedPnl: m(s.unrealizedPnlMinor)!,
      fees: m(s.feesMinor)!,
      openPositions: s.openPositions,
      openOrders: s.openOrders,
    };
  }

  @Query(() => PeriodSummary)
  async periodSummary(@CurrentActor() a: Actor, @Args('from') from: Date, @Args('to') to: Date, @Args('userId', { type: () => ID, nullable: true }) userId?: string): Promise<PeriodSummary> {
    if (to <= from || to.getTime() - from.getTime() > 400 * 86_400_000) throw badInput('Choose a range of up to ~13 months.');
    const s = await this.users.periodSummary(a, userId ?? a.userId, from, to);
    return { realizedPnl: m(s.realizedPnlMinor)!, brokerage: m(s.brokerageMinor)!, trades: s.trades, ledgerEntries: s.ledgerEntries, volume: m(s.volumeMinor)! };
  }

  @Query(() => [LedgerLine])
  async ledgerHistory(
    @CurrentActor() a: Actor,
    @Ctx() c: GqlContext,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('before', { nullable: true }) before?: Date,
  ): Promise<LedgerLine[]> {
    const u = await this.users.get(a, userId ?? a.userId, c.ip);
    const acct = await this.ledger.cashAccount(this.dbs.db, u.id, u.mode);
    const rows = await this.ledger.history(acct, clampLimit(limit), before);
    return rows.map((r) => ({ postingId: r.postingId, journalId: r.journalId, kind: r.kind, memo: r.memo, amount: formatMoney(r.amountMinor), createdAt: r.createdAt }));
  }

  @Subscription(() => Order, {
    resolve: (p: { orderUpdated: Parameters<typeof toOrder>[0] }) => toOrder(p.orderUpdated),
  })
  orderUpdated(@Context() c: GqlContext) {
    if (!c.actor) throw unauthenticated();
    return pubsub.asyncIterableIterator(TOPIC.orderUpdate(c.actor.userId));
  }
}
