/**
 * How instruments are grouped and described in the apps.
 *
 * Category (the tabs traders browse): MCX commodities, FOREX (NSE currency futures, stored with exchange CDS),
 * NSE stocks and futures, and INDICES.
 *
 * Lot label: what one lot is, in words ("100 g", "5 kg", "10 barrels"), shown next to every instrument. Defaults
 * below come from the exchanges' published contract sizes; the Super Admin can change any label.
 */
export type Category = 'MCX' | 'FOREX' | 'NSE' | 'INDICES';

export function categoryOf(exchange: string, segment: string): Category {
  if (exchange === 'MCX') return 'MCX';
  if (exchange === 'CDS' || segment === 'CUR') return 'FOREX';
  if (segment === 'INDEX') return 'INDICES';
  return 'NSE';
}

/** The underlying: the leading letters of the symbol (GOLDM-05Dec2026-FUT, GOLDM26NOVFUT → GOLDM). */
export const baseSymbol = (symbol: string) => (/^[A-Z&]+/.exec(symbol.toUpperCase())?.[0] ?? symbol.toUpperCase());

/** MCX mini/micro versions are MINI; full-size MCX contracts are MEGA; everything else is MINI. */
const MCX_MINI = /^(GOLDM|GOLDPETAL|GOLDGUINEA|GOLDTEN|SILVERM|SILVERMIC|CRUDEOILM|NATGASMINI|ZINCMINI|LEADMINI|ALUMINI|COPPERM)$/;
export function defaultLotClass(exchange: string, symbol: string): 'MINI' | 'MEGA' {
  if (exchange !== 'MCX') return 'MINI';
  return MCX_MINI.test(baseSymbol(symbol)) ? 'MINI' : 'MEGA';
}

/** Contract size per lot, as published by MCX / NSE. Unknown → empty (the Super Admin can fill it in). */
const LOT_LABEL: Record<string, string> = {
  GOLD: '1 kg', GOLDM: '100 g', GOLDGUINEA: '8 g', GOLDPETAL: '1 g',
  SILVER: '30 kg', SILVERM: '5 kg', SILVERMIC: '1 kg',
  CRUDEOIL: '100 barrels', CRUDEOILM: '10 barrels',
  NATURALGAS: '1,250 mmBtu', NATGASMINI: '250 mmBtu',
  COPPER: '2,500 kg',
  ZINCMINI: '1 tonne', LEADMINI: '1 tonne', ALUMINI: '1 tonne',
  USDINR: '1,000 USD', EURINR: '1,000 EUR', GBPINR: '1,000 GBP', JPYINR: '1,00,000 JPY',
};
export function defaultLotLabel(symbol: string): string | null {
  return LOT_LABEL[baseSymbol(symbol)] ?? null;
}
