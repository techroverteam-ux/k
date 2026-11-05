/** Money arrives as decimal strings; format with Indian digit grouping without float math on the integer part. */
export function inr(v: string | null | undefined, opts: { sign?: boolean; decimals?: boolean } = {}) {
  if (v === null || v === undefined || v === '') return '—';
  const neg = v.startsWith('-');
  const [whole, frac = '00'] = (neg ? v.slice(1) : v).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  const out = opts.decimals === false ? grouped : `${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
  return `${neg ? '−' : opts.sign && v !== '0.00' ? '+' : ''}${out}`;
}

export const tone = (v?: string | null) => (!v || v === '0.00' || v === '0' ? 'flat' : v.startsWith('-') ? 'neg' : 'pos');

export function when(d: string | Date) {
  const x = new Date(d);
  return x.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortSymbol(s: string) {
  return s.replace(/\d{2}[A-Z]{3}FUT$/, '');
}

const COMMODITY_NAMES: Record<string, string> = {
  GOLD: 'Gold',
  GOLDM: 'Gold Mini',
  GOLDPETAL: 'Gold Petal',
  GOLDGUINEA: 'Gold Guinea',
  GOLDTEN: 'Gold Ten',
  SILVER: 'Silver',
  SILVERM: 'Silver Mini',
  SILVERMIC: 'Silver Micro',
  CRUDEOIL: 'Crude Oil',
  CRUDEOILM: 'Crude Oil Mini',
  NATURALGAS: 'Natural Gas',
  NATGASMINI: 'Natural Gas Mini',
  COPPER: 'Copper',
  COPPERM: 'Copper Mini',
  ZINC: 'Zinc',
  ZINCMINI: 'Zinc Mini',
  LEAD: 'Lead',
  LEADMINI: 'Lead Mini',
  ALUMINIUM: 'Aluminium',
  ALUMINI: 'Aluminium Mini',
  KAPAS: 'Kapas (Cotton)',
  MENTHAOIL: 'Mentha Oil',
  COTTONCNDY: 'Cotton Candy',
  RUBBER: 'Rubber',
  'NG-COMEX': 'Natural Gas',
  'GC-COMEX': 'Gold (COMEX)',
  'SI-COMEX': 'Silver (COMEX)',
  'CL-COMEX': 'Crude Oil WTI',
  'HG-COMEX': 'Copper (COMEX)',
  BTCUSD: 'Bitcoin',
  ETHUSD: 'Ethereum',
  SOLUSD: 'Solana',
  XRPUSD: 'XRP (Ripple)',
  BNBUSD: 'BNB',
  DOGEUSD: 'Dogecoin',
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft Corporation',
  NVDA: 'Nvidia Corporation',
  TSLA: 'Tesla Inc.',
  AMZN: 'Amazon.com Inc.',
  GOOGL: 'Alphabet Inc. (Google)',
  META: 'Meta Platforms Inc.',
  SPX: 'S&P 500 Index',
  NDX: 'Nasdaq 100 Index',
  DJI: 'Dow Jones Industrial Average',
  RUT: 'Russell 2000 Index',
  'USDINR-FUT': 'US Dollar / Indian Rupee',
  'EURINR-FUT': 'Euro / Indian Rupee',
  'GBPINR-FUT': 'British Pound / Indian Rupee',
  'JPYINR-FUT': 'Japanese Yen / Indian Rupee',
  EURUSD: 'Euro / US Dollar',
  GBPUSD: 'British Pound / US Dollar',
  USDJPY: 'US Dollar / Japanese Yen',
  NIFTY: 'Nifty 50 Index',
  BANKNIFTY: 'Nifty Bank Index',
  FINNIFTY: 'Nifty Financial Services',
};

const baseSym = (s: string) => (/^[A-Z&]+/.exec(s.toUpperCase())?.[0] ?? s.toUpperCase());
const OPTION_RE = /^([A-Z]+?)(\d+)(CE|PE)$/;

export function fullName(inst?: { symbol?: string; name?: string } | null): string {
  if (!inst) return '';
  const sym = (inst.symbol ?? '').toUpperCase();
  if (COMMODITY_NAMES[sym]) return COMMODITY_NAMES[sym];

  const opt = OPTION_RE.exec(sym);
  if (opt) {
    const under = COMMODITY_NAMES[opt[1]]?.replace(/ Index$/, '') || opt[1];
    return `${under} ${opt[2]} ${opt[3] === 'CE' ? 'Call' : 'Put'}`;
  }

  const b = baseSym(sym);
  if (COMMODITY_NAMES[b]) return COMMODITY_NAMES[b];
  if (inst.name) {
    let n = inst.name.replace(/\s*\((MCX|NSE|BSE)\)\s*/gi, '').trim();
    n = n.replace(/\s*—\s*[A-Za-z0-9\s]+FUT$/gi, '').trim();
    n = n.replace(/\s+(NOV|DEC|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT)\s+FUT$/gi, '').trim();
    if (n && n !== sym && !/^[A-Z0-9_\-]+$/.test(n)) return n;
  }
  return inst.name || inst.symbol || '';
}

export function initials(name: string) {
  return name.split(/[\s._]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
}

export function curSign(inst?: { exchange?: string; category?: string } | null): string {
  if (!inst) return '₹';
  const cat = (inst.category ?? '').toUpperCase();
  const exch = (inst.exchange ?? '').toUpperCase();
  if (cat === 'COMEX' || cat === 'US_STOCK' || cat === 'US_INDEX' || exch === 'COMEX' || exch === 'NASDAQ' || exch === 'NYSE') {
    return '$';
  }
  if (cat === 'CRYPTO' || exch === 'CRYPTO') {
    return '$';
  }
  return '₹';
}

/** OHLC colours: High green, Low red, Open against the previous close (gap up / down), Close (the previous close) by today's move. */
const num = (v: unknown) => (v == null || v === '' ? NaN : Number(String(v).replace(/,/g, '')));
const dir = (a: unknown, b: unknown) => { const x = num(a), y = num(b); return Number.isNaN(x) || Number.isNaN(y) || x === y ? undefined : x > y ? 'pos' : 'neg'; };
export const ohlcTone = (k: string, v: unknown, ltp: unknown, close: unknown): 'pos' | 'neg' | undefined =>
  k === 'High' ? 'pos' : k === 'Low' ? 'neg' : k === 'Open' ? dir(v, close) : dir(ltp, close);
