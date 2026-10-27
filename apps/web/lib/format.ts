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

export function initials(name: string) {
  return name.split(/[\s._]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
}
