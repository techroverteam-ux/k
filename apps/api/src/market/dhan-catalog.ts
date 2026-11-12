/** Official catalogs are staged and validated before changing any instrument. */
export const DOMESTIC_MASTER = 'https://images.dhan.co/api-data/api-scrip-master.csv';
export const GLOBAL_MASTER = 'https://api-global-stocks.dhan.co/api-data/us-stock-scrip-master.csv';
export interface CatalogInstrument {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  dhanSegment: string;
  securityId: string;
  expiry: Date | null;
  lotSize: number;
  tickMinor: number;
}
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let value = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(value);
      value = '';
    } else value += c;
  }
  if (quoted) throw new Error('Unclosed CSV field');
  out.push(value);
  return out;
}
export function segmentFor(exchange: string, segment: string) {
  if (segment === 'I') return 'IDX_I';
  if (exchange === 'MCX') return 'MCX_COMM';
  return ({ E: exchange + '_EQ', D: exchange + '_FNO', C: exchange + '_CURRENCY' } as Record<string, string>)[segment];
}
export function parseCatalog(text: string, global = false): CatalogInstrument[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const h = csvFields(lines.shift() ?? '');
  const required = global
    ? ['SYMBOL', 'SCRIP_CODE', 'LOT_SIZE', 'TICK_SIZE']
    : [
        'SEM_TRADING_SYMBOL',
        'SEM_SMST_SECURITY_ID',
        'SEM_EXM_EXCH_ID',
        'SEM_SEGMENT',
        'SEM_LOT_UNITS',
        'SEM_TICK_SIZE',
        'SEM_EXPIRY_DATE',
      ];
  if (required.some((k) => !h.includes(k))) throw new Error('Instrument catalog headers changed');
  const result: CatalogInstrument[] = [];
  const seen = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = csvFields(line);
    const get = (k: string) => f[h.indexOf(k)] ?? '';
    const ex = global ? '' : get('SEM_EXM_EXCH_ID');
    const seg = global ? 'INX_EQ' : segmentFor(ex, get('SEM_SEGMENT'));
    if (!seg) continue;
    const symbol = get(global ? 'SYMBOL' : 'SEM_TRADING_SYMBOL');
    const id = get(global ? 'SCRIP_CODE' : 'SEM_SMST_SECURITY_ID');
    if (!symbol || !/^\d+$/.test(id)) throw new Error('Invalid instrument identity');
    const rawExpiry = global ? '' : get('SEM_EXPIRY_DATE');
    let expiry: Date | null = null;
    if (rawExpiry && !rawExpiry.startsWith('0001')) {
      expiry = new Date(rawExpiry.replace(' ', 'T') + '+05:30');
      if (!Number.isFinite(expiry.getTime())) throw new Error('Invalid contract expiry');
    }
    const lot = Number(get(global ? 'LOT_SIZE' : 'SEM_LOT_UNITS'));
    const tick = Number(get(global ? 'TICK_SIZE' : 'SEM_TICK_SIZE')) * (global || seg === 'IDX_I' ? 100 : 1);
    // Current price precision is integer paise. Never silently round a finer tick.
    if (!Number.isFinite(tick) || tick <= 0 || !Number.isInteger(lot) || lot < 1) continue;
    const key = seg + ':' + id;
    const previous = seen.get(key);
    if (previous && previous !== symbol) throw new Error('Conflicting catalog identity');
    seen.set(key, symbol);
    if (previous) continue;
    result.push({
      symbol,
      name: get(global ? 'CUSTOM_SYMBOL' : 'SEM_CUSTOM_SYMBOL') || symbol,
      exchange: global
        ? get('CUSTOM_EXCH').startsWith('NASDAQ')
          ? 'NASDAQ'
          : 'NYSE'
        : seg === 'NSE_CURRENCY'
          ? 'CDS'
          : ex,
      segment: global
        ? 'US_STOCK'
        : get('SEM_SEGMENT') === 'I'
          ? 'INDEX'
          : get('SEM_INSTRUMENT_NAME') === 'EQUITY'
            ? 'EQ'
            : get('SEM_INSTRUMENT_NAME').startsWith('OPT')
              ? 'OPT'
              : seg === 'MCX_COMM'
                ? 'COMM'
                : seg.includes('CURRENCY')
                  ? 'CUR'
                  : 'FUT',
      dhanSegment: seg,
      securityId: id,
      expiry,
      lotSize: lot,
      tickMinor: Math.abs(tick - Math.round(tick)) < 1e-6 ? Math.round(tick) : tick,
    });
  }
  return result;
}
export function supportedTick(tick: number) {
  return Number.isInteger(tick) && tick >= 1;
}
export function sameUnderlying(a: string, b: string) {
  return (/^[A-Z&]+/.exec(a.toUpperCase())?.[0] ?? a) === (/^[A-Z&]+/.exec(b.toUpperCase())?.[0] ?? b);
}

/** Security IDs may be reused after expiry; never attach an old position to a new contract. */
export function sameContract(
  existing: { symbol: string; expiry: Date | null; segment: string },
  candidate: CatalogInstrument,
) {
  if (existing.symbol === candidate.symbol) return true;
  if (!sameUnderlying(existing.symbol, candidate.symbol)) return false;
  if (existing.expiry?.toISOString().slice(0, 7) !== candidate.expiry?.toISOString().slice(0, 7)) return false;
  if (existing.segment === 'OPT' || candidate.segment === 'OPT') return existing.symbol === candidate.symbol;
  return true;
}
