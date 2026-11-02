import { applyBps } from '../common/money';
import type { ConfigService } from '../config-mgmt/config.service';

/**
 * Brokerage for one fill (one side: entry OR exit).
 *
 *   fee = perLot × lots  +  bps of turnover
 *
 * An order's quantity is counted in lots. Default: ₹250 per lot per side and 0 bps, so a 1-lot trade pays
 * ₹250 to enter and ₹250 to exit, a 2-lot trade ₹500 + ₹500. Both parts are admin settings
 * (`trading.brokeragePerLot` in rupees, `trading.brokerageBps`).
 */
export interface FeeRule { perLotMinor: bigint; bps: number }

export function brokerageMinor(rule: FeeRule, priceMinor: bigint, lots: number): bigint {
  return rule.perLotMinor * BigInt(lots) + applyBps(priceMinor * BigInt(lots), rule.bps);
}

export async function feeRule(config: ConfigService): Promise<FeeRule> {
  const [perLot, bps] = await Promise.all([config.get('trading.brokeragePerLot'), config.get('trading.brokerageBps')]);
  return { perLotMinor: BigInt(Math.round(perLot * 100)), bps };
}
