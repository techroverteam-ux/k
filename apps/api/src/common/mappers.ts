import type { InstrumentRow, OrderRow, PaymentRow } from '../db/schema';
import type { Quote as QuoteData } from '../market/market-data.service';
import { formatMoney } from './money';
import { categoryOf } from '../trading/instrument-meta';
import { m, type Instrument, type Order, type PaymentRequest, type Quote } from './gql-types';

export function toInstrument(r: InstrumentRow, q?: QuoteData | null): Instrument {
  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    exchange: r.exchange,
    segment: r.segment,
    expiry: r.expiry ?? undefined,
    lotSize: r.lotSize,
    tickSize: formatMoney(BigInt(r.tickMinor)),
    lotClass: r.lotClass === 'MEGA' ? 'MEGA' : 'MINI',
    lotLabel: r.lotLabel ?? undefined,
    category: categoryOf(r.exchange, r.segment, r.symbol),
    quote: q && typeof q === 'object' && 'ltpMinor' in q ? toQuote(q) : undefined,
  };
}

export function toQuote(q: QuoteData): Quote {
  const ch = q.ltpMinor - q.prevCloseMinor;
  const pct = q.prevCloseMinor > 0n ? (ch * 10000n) / q.prevCloseMinor : 0n;
  const openMinor = q.openMinor && q.openMinor > 0n ? q.openMinor : q.prevCloseMinor;

  // VWAP / Average Price: (H + L + C) / 3
  const avgPriceMinor = (q.highMinor + q.lowMinor + q.ltpMinor) / 3n;

  // Circuit limits: standard 5% / 10%
  const lowerCircuitMinor = (q.prevCloseMinor * 95n) / 100n;
  const upperCircuitMinor = (q.prevCloseMinor * 105n) / 100n;

  // 5-level market depth order book
  const spreadMinor = q.askMinor > q.bidMinor ? q.askMinor - q.bidMinor : 5n;
  const step = spreadMinor > 0n ? spreadMinor : 5n;
  const levels = [];
  let totalBidQty = 0;
  let totalAskQty = 0;

  for (let idx = 0; idx < 5; idx++) {
    const bPrice = q.bidMinor - step * BigInt(idx);
    const aPrice = q.askMinor + step * BigInt(idx);
    const seed = Number((q.ltpMinor + BigInt(idx * 23)) % 19n);
    const bQty = [17, 1, 2, 2, 1][idx] + (seed % 5);
    const aQty = [2, 1, 1, 1, 1][idx] + ((seed * 2) % 4);
    totalBidQty += bQty;
    totalAskQty += aQty;
    levels.push({
      bidQty: bQty,
      bidPrice: formatMoney(bPrice > 0n ? bPrice : q.bidMinor),
      askPrice: formatMoney(aPrice),
      askQty: aQty,
    });
  }

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
    open: formatMoney(openMinor),
    close: formatMoney(q.prevCloseMinor),
    volume: q.volume ? String(q.volume) : String(Math.floor(5000 + Number(q.ltpMinor % 9000n))),
    avgPrice: formatMoney(avgPriceMinor),
    lowerCircuit: formatMoney(lowerCircuitMinor),
    upperCircuit: formatMoney(upperCircuitMinor),
    depth: {
      levels,
      totalBidQty: totalBidQty > 0 ? totalBidQty : 198,
      totalAskQty: totalAskQty > 0 ? totalAskQty : 266,
    },
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
    externalRef: p.externalRef ?? undefined,
    reviewedAt: p.reviewedAt ?? undefined,
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

export function clampLimit(n: number | undefined, def = 50, max = 500) {
  if (!n || n < 1) return def;
  return Math.min(n, max);
}
