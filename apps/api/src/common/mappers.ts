import type { InstrumentRow, OrderRow, PaymentRow } from '../db/schema';
import type { Quote as QuoteData } from '../market/market-data.service';
import { formatMoney } from './money';
import { m, type Instrument, type Order, type PaymentRequest, type Quote } from './gql-types';

export function toInstrument(r: InstrumentRow): Instrument {
  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    exchange: r.exchange,
    segment: r.segment,
    expiry: r.expiry ?? undefined,
    lotSize: r.lotSize,
    tickSize: formatMoney(BigInt(r.tickMinor)),
  };
}

export function toQuote(q: QuoteData): Quote {
  const ch = q.ltpMinor - q.prevCloseMinor;
  const pct = q.prevCloseMinor > 0n ? (ch * 10000n) / q.prevCloseMinor : 0n;
  return {
    instrumentId: q.instrumentId,
    symbol: q.symbol,
    ltp: formatMoney(q.ltpMinor),
    bid: formatMoney(q.bidMinor),
    ask: formatMoney(q.askMinor),
    high: formatMoney(q.highMinor),
    low: formatMoney(q.lowMinor),
    change: formatMoney(ch),
    changePct: formatMoney(pct),
    ts: q.ts,
    source: q.source,
  };
}

export function toOrder(o: OrderRow): Order {
  return {
    id: o.id,
    userId: o.userId,
    instrumentId: o.instrumentId,
    side: o.side as Order['side'],
    type: o.type as Order['type'],
    quantity: o.quantity,
    limitPrice: m(o.limitPriceMinor) ?? undefined,
    triggerPrice: m(o.triggerPriceMinor) ?? undefined,
    triggeredAt: o.triggeredAt ?? undefined,
    fillPrice: m(o.fillPriceMinor) ?? undefined,
    status: o.status as Order['status'],
    mode: o.mode,
    venue: o.venue,
    rejectReason: o.rejectReason ?? undefined,
    createdAt: o.createdAt,
    filledAt: o.filledAt ?? undefined,
  };
}

export function toPayment(p: PaymentRow, username?: string): PaymentRequest {
  return {
    id: p.id,
    userId: p.userId,
    username,
    type: p.type as PaymentRequest['type'],
    mode: p.mode,
    amount: formatMoney(p.amountMinor),
    status: p.status as PaymentRequest['status'],
    requestedById: p.requestedById,
    reviewedById: p.reviewedById ?? undefined,
    reviewNote: p.reviewNote ?? undefined,
    journalId: p.journalId ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function clampLimit(n: number | undefined, def = 50, max = 100) {
  if (!n || n < 1) return def;
  return Math.min(n, max);
}
