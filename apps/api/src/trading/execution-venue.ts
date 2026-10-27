import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors';
import type { Quote } from '../market/market-data.service';

export type Side = 'BUY' | 'SELL';

/**
 * Where orders go. Only the SIMULATED venue exists in this build.
 *
 * A LIVE venue must be a licensed broker's order API (SEBI-registered stock broker) with the
 * client's own trading account. Do not implement LIVE by internally matching client orders
 * against the platform's own book — that is off-exchange ("dabba") trading.
 */
export interface ExecutionVenue {
  readonly name: string;
  marketFillPrice(side: Side, q: Quote): bigint;
  limitFillPrice(side: Side, limitMinor: bigint, q: Quote): bigint | null;
}

@Injectable()
export class SimulatedVenue implements ExecutionVenue {
  readonly name = 'SIMULATED';

  /** Paper fill at the touch: buys lift the ask, sells hit the bid. */
  marketFillPrice(side: Side, q: Quote) {
    return side === 'BUY' ? q.askMinor : q.bidMinor;
  }

  /** Limit fills when the touch crosses the limit; fill at the better of touch and limit. */
  limitFillPrice(side: Side, limit: bigint, q: Quote) {
    if (side === 'BUY') return q.askMinor <= limit ? q.askMinor : null;
    return q.bidMinor >= limit ? q.bidMinor : null;
  }
}

export class LiveVenueNotConfigured implements ExecutionVenue {
  readonly name = 'LIVE';
  marketFillPrice(): bigint {
    throw new AppError('NOT_ENABLED', 'Live trading is not enabled on this platform.');
  }
  limitFillPrice(): bigint | null {
    throw new AppError('NOT_ENABLED', 'Live trading is not enabled on this platform.');
  }
}
