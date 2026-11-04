import { applyBps } from '../common/money';
import type { ConfigService } from '../config-mgmt/config.service';

/**
 * Brokerage for one fill (one side: entry OR exit).
 *
 *   fee = perLot(lot class) × lots  +  bps of turnover
 *
 * An order's quantity is counted in lots. Each instrument is a MINI or a MEGA lot:
 *  - mini: ₹250 per lot per side (1 lot = ₹250 to open + ₹250 to cut; 2 lots = ₹500 + ₹500)
 *  - mega: ₹2,500 per lot per side (1 lot = ₹2,500 + ₹2,500)
 * All are admin settings (`trading.brokeragePerLot`, `trading.brokeragePerMegaLot`, `trading.brokerageBps`).
 */
export type LotClass = 'MINI' | 'MEGA';
export interface FeeRule { perLotMinor: bigint; megaPerLotMinor: bigint; bps: number }

export const lotClassOf = (v?: string | null): LotClass => (v === 'MEGA' ? 'MEGA' : 'MINI');

export function perLotMinor(rule: FeeRule, cls?: string | null): bigint {
  return lotClassOf(cls) === 'MEGA' ? rule.megaPerLotMinor : rule.perLotMinor;
}

export function brokerageMinor(rule: FeeRule, priceMinor: bigint, lots: number, cls?: string | null): bigint {
  return perLotMinor(rule, cls) * BigInt(lots) + applyBps(priceMinor * BigInt(lots), rule.bps);
}

export async function feeRule(config: ConfigService): Promise<FeeRule> {
  const [perLot, mega, bps] = await Promise.all([config.get('trading.brokeragePerLot'), config.get('trading.brokeragePerMegaLot'), config.get('trading.brokerageBps')]);
  return { perLotMinor: BigInt(Math.round(perLot * 100)), megaPerLotMinor: BigInt(Math.round(mega * 100)), bps };
}

/**
 * MCX full-size contracts (GOLD, SILVER, CRUDEOIL, NATURALGAS, COPPER…) are mega lots; their mini versions
 * (GOLDM, SILVERM, SILVERMIC, CRUDEOILM, NATGASMINI, GOLDPETAL, GOLDGUINEA) and everything on NSE are mini.
 * Used when an instrument is first added; the Super Admin can change any instrument afterwards.
 */
export function defaultLotClass(exchange: string, symbol: string): LotClass {
  if (exchange !== 'MCX') return 'MINI';
  const base = symbol.toUpperCase().replace(/\d{2}[A-Z]{3}FUT.*$/, '');
  return /(M|MINI|MIC|PETAL|GUINEA)$/.test(base) ? 'MINI' : 'MEGA';
}
