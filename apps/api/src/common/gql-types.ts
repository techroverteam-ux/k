import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { formatMoney } from './money';

/**
 * Money is exposed as a decimal STRING in rupees (e.g. "6364.50") — never a float.
 */
export const m = (v: bigint | null | undefined) => (v === null || v === undefined ? null : formatMoney(v));

export enum OrderSideGql {
  BUY = 'BUY',
  SELL = 'SELL',
}
export enum OrderTypeGql {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  /** Triggers when LTP reaches the trigger price, then fills at LTP. */
  STOP_LOSS = 'STOP_LOSS',
  TAKE_PROFIT = 'TAKE_PROFIT',
}
export enum OrderStatusGql {
  OPEN = 'OPEN',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
}
export enum PaymentTypeGql {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
}
export enum PaymentStatusGql {
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  POSTED = 'POSTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
registerEnumType(OrderSideGql, { name: 'OrderSide' });
registerEnumType(OrderTypeGql, { name: 'OrderType' });
registerEnumType(OrderStatusGql, { name: 'OrderStatus' });
registerEnumType(PaymentTypeGql, { name: 'PaymentType' });
registerEnumType(PaymentStatusGql, { name: 'PaymentStatus' });

@ObjectType()
export class Instrument {
  @Field(() => ID) id: string;
  @Field() symbol: string;
  @Field() name: string;
  @Field() exchange: string;
  @Field() segment: string;
  @Field({ nullable: true }) expiry?: Date;
  @Field(() => Int) lotSize: number;
  @Field() tickSize: string;
}

@ObjectType()
export class Quote {
  @Field(() => ID) instrumentId: string;
  @Field() symbol: string;
  @Field() ltp: string;
  @Field() bid: string;
  @Field() ask: string;
  @Field() high: string;
  @Field() low: string;
  @Field() change: string;
  @Field() changePct: string;
  @Field() ts: Date;
  @Field({ description: 'Where this price came from. "SIMULATED" prices are not live market data.' }) source: string;
}

@ObjectType()
export class WatchlistEntry {
  @Field(() => ID) id: string;
  @Field(() => Int) listIndex: number;
  @Field(() => Instrument) instrument: Instrument;
  @Field(() => Quote, { nullable: true }) quote?: Quote;
}

@ObjectType()
export class Order {
  @Field(() => ID) id: string;
  @Field(() => ID) userId: string;
  @Field(() => ID) instrumentId: string;
  @Field(() => Instrument, { nullable: true }) instrument?: Instrument;
  @Field(() => OrderSideGql) side: OrderSideGql;
  @Field(() => OrderTypeGql) type: OrderTypeGql;
  @Field(() => Int) quantity: number;
  @Field({ nullable: true }) limitPrice?: string;
  @Field({ nullable: true, description: 'STOP_LOSS / TAKE_PROFIT: LTP that triggers the order.' }) triggerPrice?: string;
  @Field({ nullable: true }) triggeredAt?: Date;
  @Field({ nullable: true }) fillPrice?: string;
  @Field(() => OrderStatusGql) status: OrderStatusGql;
  @Field() mode: string;
  @Field({ description: 'SIMULATED = paper fill, not an exchange execution.' }) venue: string;
  @Field({ nullable: true }) rejectReason?: string;
  @Field() createdAt: Date;
  @Field({ nullable: true }) filledAt?: Date;
}

@ObjectType()
export class Position {
  @Field(() => ID) id: string;
  @Field(() => ID) instrumentId: string;
  @Field(() => Instrument, { nullable: true }) instrument?: Instrument;
  @Field() mode: string;
  @Field(() => Int) netQty: number;
  @Field() avgPrice: string;
  @Field() realizedPnl: string;
  @Field({ nullable: true }) unrealizedPnl?: string;
  @Field({ nullable: true }) ltp?: string;
}

@ObjectType()
export class OrderPreview {
  @Field() price: string;
  @Field() value: string;
  @Field() intradayMargin: string;
  @Field() carryForwardMargin: string;
  @Field() brokerage: string;
}

@ObjectType()
export class AccountSummary {
  @Field(() => ID) userId: string;
  @Field() mode: string;
  @Field() balance: string;
  @Field() marginUsed: string;
  @Field() available: string;
  @Field() deposits: string;
  @Field() withdrawals: string;
  @Field() realizedPnl: string;
  @Field() unrealizedPnl: string;
  @Field() fees: string;
  @Field(() => Int) openPositions: number;
  @Field(() => Int) openOrders: number;
}

@ObjectType()
export class PeriodSummary {
  @Field() realizedPnl: string;
  @Field() brokerage: string;
  @Field(() => Int) trades: number;
  @Field(() => Int) ledgerEntries: number;
  @Field() volume: string;
}

@ObjectType()
export class LedgerLine {
  @Field(() => ID) postingId: string;
  @Field(() => ID) journalId: string;
  @Field() kind: string;
  @Field() memo: string;
  @Field() amount: string;
  @Field() createdAt: Date;
}

@ObjectType()
export class PaymentRequest {
  @Field(() => ID) id: string;
  @Field(() => ID) userId: string;
  @Field({ nullable: true }) username?: string;
  @Field(() => PaymentTypeGql) type: PaymentTypeGql;
  @Field() mode: string;
  @Field() amount: string;
  @Field(() => PaymentStatusGql) status: PaymentStatusGql;
  @Field(() => ID) requestedById: string;
  @Field(() => ID, { nullable: true }) reviewedById?: string;
  @Field({ nullable: true }) reviewNote?: string;
  @Field(() => ID, { nullable: true }) journalId?: string;
  @Field() createdAt: Date;
  @Field() updatedAt: Date;
}

@ObjectType()
export class ConfigVersion {
  @Field(() => ID) id: string;
  @Field() key: string;
  @Field(() => Int) version: number;
  @Field({ description: 'JSON-encoded value' }) valueJson: string;
  @Field() status: string;
  @Field() reason: string;
  @Field(() => ID, { nullable: true }) makerId?: string;
  @Field(() => ID, { nullable: true }) checkerId?: string;
  @Field() createdAt: Date;
  @Field({ nullable: true }) decidedAt?: Date;
}

@ObjectType()
export class ConfigItem {
  @Field() key: string;
  @Field() description: string;
  @Field() valueJson: string;
  @Field(() => Int) version: number;
  @Field() isDefault: boolean;
  @Field(() => ConfigVersion, { nullable: true }) pending?: ConfigVersion;
}

@ObjectType()
export class AuditEvent {
  @Field() seq: string;
  @Field(() => ID) id: string;
  @Field(() => ID, { nullable: true }) actorId?: string;
  @Field({ nullable: true }) actorRole?: string;
  @Field() action: string;
  @Field({ nullable: true }) entityType?: string;
  @Field({ nullable: true }) entityId?: string;
  @Field() outcome: string;
  @Field({ nullable: true }) ip?: string;
  @Field({ nullable: true }) userAgent?: string;
  @Field({ nullable: true }) sessionId?: string;
  @Field({ nullable: true }) requestId?: string;
  @Field({ nullable: true }) metadataJson?: string;
  @Field() hash: string;
  @Field() createdAt: Date;
}

@ObjectType()
export class AuditVerification {
  @Field() ok: boolean;
  @Field(() => Int) checked: number;
  @Field({ nullable: true }) brokenAtSeq?: string;
}

@ObjectType()
export class Notification {
  @Field(() => ID) id: string;
  @Field() kind: string;
  @Field() title: string;
  @Field() body: string;
  @Field({ nullable: true }) readAt?: Date;
  @Field() createdAt: Date;
}

@ObjectType()
export class ReconciliationRun {
  @Field(() => ID) id: string;
  @Field() ok: boolean;
  @Field() summaryJson: string;
  @Field() createdAt: Date;
}

@ObjectType()
export class AdminOverview {
  @Field(() => Int) brokers: number;
  @Field(() => Int) traders: number;
  @Field(() => Int) activeTraders: number;
  @Field(() => Int) suspended: number;
  @Field(() => Int) pendingAccounts: number;
  @Field(() => Int) pendingPayments: number;
  @Field() pendingPaymentsAmount: string;
  @Field(() => Int) openOrders: number;
  @Field(() => Int) securityEvents24h: number;
  @Field(() => ReconciliationRun, { nullable: true }) lastReconciliation?: ReconciliationRun;
}

@ObjectType()
export class CommissionLine {
  @Field(() => ID) userId: string;
  @Field() username: string;
  @Field() brokerage: string;
  @Field() commission: string;
}

@ObjectType()
export class CommissionReport {
  @Field(() => Int) shareBps: number;
  @Field(() => [CommissionLine]) lines: CommissionLine[];
  @Field() total: string;
}

@ObjectType()
export class AppSettings {
  @Field() appName: string;
  @Field(() => [String]) tickerMessages: string[];
  @Field(() => [String]) termsRules: string[];
  @Field() helplineUrl: string;
  @Field() demoEnabled: boolean;
  @Field() tradingMode: string;
  @Field() marketFeed: string;
  @Field() signupEnabled: boolean;
  @Field(() => Int) maxWatchlists: number;
  @Field() apiVersion: string;
}

@ObjectType()
export class MarketSession {
  @Field() exchange: string;
  @Field() open: string;
  @Field() close: string;
  @Field() isOpen: boolean;
  @Field({ nullable: true }) message?: string;
}

@ObjectType({ description: 'Order limits and market sessions shown on the order screen.' })
export class TradingRules {
  @Field(() => Int, { description: 'Minimum quantity per order' }) minQty: number;
  @Field(() => Int, { description: 'Maximum quantity per order ("punch qty")' }) maxQtyPerOrder: number;
  @Field(() => Int, { description: 'Maximum open quantity per instrument ("total qty")' }) maxQtyPerInstrument: number;
  @Field() marketHoursEnforced: boolean;
  @Field(() => [MarketSession]) sessions: MarketSession[];
}

@ObjectType()
export class WatchlistCount {
  @Field(() => Int) listIndex: number;
  @Field(() => Int) count: number;
}

@ObjectType({ description: 'A small public snapshot of the price feed, for the sign-in screen.' })
export class MarketPulseItem {
  @Field(() => ID) instrumentId: string;
  @Field() symbol: string;
  @Field() name: string;
  @Field() exchange: string;
  @Field() ltp: string;
  @Field() change: string;
  @Field() changePct: string;
  @Field({ description: '"SIMULATED" prices are not live market data.' }) source: string;
}
