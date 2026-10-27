/**
 * Exact money helpers. All amounts are BigInt paise (1 INR = 100 paise).
 * The API exchanges money as decimal strings ("6364.50") — never JS floats.
 */
const MONEY_RE = /^-?\d{1,13}(\.\d{1,2})?$/;

export function parseMoney(input: string): bigint {
  const s = input.trim();
  if (!MONEY_RE.test(s)) throw new Error(`Invalid amount "${input}". Use up to 2 decimal places.`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -v : v;
}

export function formatMoney(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Multiply a price (paise) by a basis-point rate, rounding half away from zero. */
export function applyBps(amountMinor: bigint, bps: number): bigint {
  const n = amountMinor * BigInt(Math.round(bps));
  const q = n / 10_000n;
  const r = n % 10_000n;
  const abs = r < 0n ? -r : r;
  if (abs * 2n >= 10_000n) return n >= 0n ? q + 1n : q - 1n;
  return q;
}

export function roundToTick(priceMinor: bigint, tickMinor: number): bigint {
  const t = BigInt(tickMinor);
  const r = priceMinor % t;
  return r * 2n >= t ? priceMinor - r + t : priceMinor - r;
}
