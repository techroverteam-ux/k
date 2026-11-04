import { databaseUrl } from '../src/db/database-url';
import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { instruments } from '../src/db/schema';

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

const baseSymbol = (s: string) => (/^[A-Z&]+/.exec(s.toUpperCase())?.[0] ?? s.toUpperCase());
const OPTION_RE = /^([A-Z]+?)(\d+)(CE|PE)$/;

export function resolveFullName(inst: { symbol: string; name?: string }): string {
  const sym = inst.symbol.toUpperCase();
  if (COMMODITY_NAMES[sym]) return COMMODITY_NAMES[sym];

  const opt = OPTION_RE.exec(sym);
  if (opt) {
    const under = COMMODITY_NAMES[opt[1]]?.replace(/ Index$/, '') || opt[1];
    return `${under} ${opt[2]} ${opt[3] === 'CE' ? 'Call' : 'Put'}`;
  }

  const b = baseSymbol(sym);
  if (COMMODITY_NAMES[b]) return COMMODITY_NAMES[b];
  if (inst.name) {
    let n = inst.name.replace(/\s*\((MCX|NSE|BSE)\)\s*/gi, '').trim();
    n = n.replace(/\s*—\s*[A-Za-z0-9\s]+FUT$/gi, '').trim();
    n = n.replace(/\s+(NOV|DEC|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT)\s+FUT$/gi, '').trim();
    if (n && n !== sym && !/^[A-Z0-9_\-]+$/.test(n)) return n;
  }
  return inst.name || inst.symbol;
}

async function main() {
  const pool = createPool(databaseUrl(), 2);
  const db = drizzle(pool, { schema });

  try {
    const rows = await db.select().from(instruments);
    let updated = 0;

    for (const row of rows) {
      const full = resolveFullName(row);
      if (full && full !== row.name) {
        await db.update(instruments).set({ name: full }).where(sql`${instruments.id} = ${row.id}`);
        updated++;
      }
    }

    console.log(`Updated ${updated} instruments with proper full names in database.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

