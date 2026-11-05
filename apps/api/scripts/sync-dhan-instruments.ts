/**
 * Ingests real tradable instruments from Dhan's official daily Scrip Master CSV:
 * - Active MCX Commodity Futures (Silver, Gold, Crude Oil, Natural Gas, etc.)
 * - Top NSE liquid Equities (Reliance, TCS, HDFC Bank, Infy, SBI, etc.)
 * - Major Indices (Nifty 50, Bank Nifty, Fin Nifty)
 * - Forex: NSE currency futures for USDINR, EURINR, GBPINR, JPYINR (stored with exchange CDS, segment CUR)
 *
 * Maps them directly into the Postgres `instruments` table with their Dhan Security IDs and segments.
 * Run with:
 *   npm --prefix apps/api run instruments:sync-dhan
 */
import { baseSymbol, defaultLotClass, defaultLotLabel } from '../src/trading/instrument-meta';
import { resolveFullName } from './update-instrument-names';
import { databaseUrl } from '../src/db/database-url';
import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { instruments } from '../src/db/schema';
import { seedCategories } from './seed-all-categories';

const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

interface ScripRow {
  exchange: string;
  segment: string;
  securityId: string;
  instrumentName: string;
  tradingSymbol: string;
  customSymbol: string;
  lotSize: number;
  tickSize: number;
  expiryDate?: Date;
  dhanSegment: string;
  category: 'MCX_FUT' | 'NSE_EQ' | 'NSE_INDEX' | 'FOREX';
}

const FOREX_PAIRS = new Set(['USDINR', 'EURINR', 'GBPINR', 'JPYINR']);

const TOP_NSE_SYMBOLS = new Set([
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC',
  'KOTAKBANK', 'LT', 'AXISBANK', 'TATAMOTORS', 'MARUTI', 'SUNPHARMA', 'BAJFINANCE',
  'TITAN', 'ASIANPAINT', 'HCLTECH', 'ADANIENT', 'ADANIPORTS', 'ULTRACEMCO', 'WIPRO',
  'NTPC', 'ONGC', 'POWERGRID', 'JSWSTEEL', 'TATASTEEL', 'COALINDIA', 'HINDUNILVR',
  'BAJAJFINSV', 'M&M', 'DRREDDY', 'CIPLA', 'APOLLOHOSP', 'EICHERMOT', 'DIVISLAB',
  'BPCL', 'GRASIM', 'HEROMOTOCO', 'NESTLEIND', 'TECHM', 'BRITANNIA', 'SHRIRAMFIN',
  'TRENT', 'BEL', 'HAL', 'ZOMATO', 'JIOFIN', 'VEDL'
]);

async function downloadScripMaster(): Promise<ScripRow[]> {
  console.log(`Downloading Dhan Scrip Master from ${DHAN_SCRIP_MASTER_URL}...`);
  const res = await fetch(DHAN_SCRIP_MASTER_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch scrip master`);
  const text = await res.text();
  const lines = text.split('\n');
  console.log(`Downloaded ${lines.length} lines.`);

  const header = lines[0].trim().split(',');
  const col = (name: string) => header.indexOf(name);
  const exchIdx = col('SEM_EXM_EXCH_ID');
  const segIdx = col('SEM_SEGMENT');
  const secIdIdx = col('SEM_SMST_SECURITY_ID');
  const instNameIdx = col('SEM_INSTRUMENT_NAME');
  const symbolIdx = col('SEM_TRADING_SYMBOL');
  const customSymbolIdx = col('SEM_CUSTOM_SYMBOL');
  const lotIdx = col('SEM_LOT_UNITS');
  const tickIdx = col('SEM_TICK_SIZE');
  const expiryIdx = col('SEM_EXPIRY_DATE');

  const parsed: ScripRow[] = [];
  const now = new Date();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');

    const exch = parts[exchIdx];
    const seg = parts[segIdx];
    const instName = parts[instNameIdx];
    const rawSymbol = parts[symbolIdx];
    const customSymbol = parts[customSymbolIdx];
    const secId = parts[secIdIdx];
    const lot = Math.max(1, Math.round(Number(parts[lotIdx]) || 1));
    const tick = Number(parts[tickIdx]) || 0.05;

    let expiry: Date | undefined;
    if (parts[expiryIdx]) {
      const d = new Date(parts[expiryIdx]);
      if (!isNaN(d.getTime())) expiry = d;
    }

    // 1. MCX Commodity Futures (FUTCOM)
    if (exch === 'MCX' && instName === 'FUTCOM') {
      if (expiry && expiry < now) continue;
      parsed.push({
        exchange: 'MCX',
        segment: 'COMM',
        securityId: secId,
        instrumentName: instName,
        tradingSymbol: rawSymbol,
        customSymbol: customSymbol || rawSymbol,
        lotSize: lot,
        tickSize: tick,
        expiryDate: expiry,
        dhanSegment: 'MCX_COMM',
        category: 'MCX_FUT',
      });
      continue;
    }

    // 1b. Forex: NSE currency futures (FUTCUR) for the four major INR pairs.
    if (exch === 'NSE' && instName === 'FUTCUR' && FOREX_PAIRS.has(baseSymbol(rawSymbol))) {
      if (expiry && expiry < now) continue;
      parsed.push({
        exchange: 'CDS',
        segment: 'CUR',
        securityId: secId,
        instrumentName: instName,
        tradingSymbol: rawSymbol,
        customSymbol: customSymbol || rawSymbol,
        lotSize: lot,
        tickSize: tick,
        expiryDate: expiry,
        dhanSegment: 'NSE_CURRENCY',
        category: 'FOREX',
      });
      continue;
    }

    // 2. NSE Top Equities
    if (exch === 'NSE' && instName === 'EQUITY' && TOP_NSE_SYMBOLS.has(rawSymbol)) {
      parsed.push({
        exchange: 'NSE',
        segment: 'EQ',
        securityId: secId,
        instrumentName: instName,
        tradingSymbol: rawSymbol,
        customSymbol: customSymbol || rawSymbol,
        lotSize: 1,
        tickSize: tick,
        dhanSegment: 'NSE_EQ',
        category: 'NSE_EQ',
      });
      continue;
    }

    // 3. NSE Indices (NIFTY, BANKNIFTY, FINNIFTY)
    if (exch === 'NSE' && seg === 'I' && (rawSymbol === 'NIFTY' || rawSymbol === 'BANKNIFTY' || rawSymbol === 'FINNIFTY')) {
      parsed.push({
        exchange: 'NSE',
        segment: 'INDEX',
        securityId: secId,
        instrumentName: 'INDEX',
        tradingSymbol: rawSymbol,
        customSymbol: customSymbol || rawSymbol,
        lotSize: rawSymbol === 'BANKNIFTY' ? 15 : 25,
        tickSize: tick,
        dhanSegment: 'IDX_I',
        category: 'NSE_INDEX',
      });
    }
  }

  return parsed;
}

function defaultRefPrice(symbol: string): bigint {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('GOLDGUINEA')) return 62800_00n;
  if (sym.startsWith('GOLDPETAL')) return 7850_00n;
  if (sym.startsWith('GOLD')) return 78500_00n;
  if (sym.startsWith('SILVER')) return 92500_00n;
  if (sym.startsWith('CRUDEOIL')) return 5850_00n;
  if (sym.startsWith('NATURALGAS') || sym.startsWith('NATGAS')) return 245_00n;
  if (sym.startsWith('COPPER')) return 815_00n;
  if (sym.startsWith('ZINC')) return 265_00n;
  if (sym.startsWith('LEAD')) return 182_00n;
  if (sym.startsWith('ALUM')) return 232_00n;
  if (sym.startsWith('MENTHA')) return 920_00n;
  if (sym.startsWith('COTTON')) return 54500_00n;
  if (sym.startsWith('KAPAS')) return 1540_00n;
  if (sym.includes('NIFTY')) return 24500_00n;
  if (sym.includes('BANKNIFTY')) return 52000_00n;
  return 1000_00n;
}

async function main() {
  const pool = createPool(databaseUrl(), 2);
  const db = drizzle(pool, { schema });

  try {
    const scrips = await downloadScripMaster();
    console.log(`Matched ${scrips.length} real instruments to sync:`);
    const mcxCount = scrips.filter((s) => s.exchange === 'MCX').length;
    const nseCount = scrips.filter((s) => s.exchange === 'NSE').length;
    console.log(`  - MCX Commodity Futures: ${mcxCount}`);
    console.log(`  - NSE Equities & Indices: ${nseCount}`);
    console.log(`  - Forex (currency futures): ${scrips.filter((x) => x.category === 'FOREX').length}`);

    let inserted = 0;
    let updated = 0;

    for (const s of scrips) {
      const cleanSymbol = s.tradingSymbol.slice(0, 40);
      const cleanName = resolveFullName({ symbol: s.tradingSymbol, name: s.customSymbol }).slice(0, 120);
      const tickMinor = s.exchange === 'MCX'
        ? Math.max(1, Math.round(s.tickSize)) // Dhan MCX tickSize is already in paise
        : Math.max(1, Math.round(s.tickSize * 100)); // NSE tickSize is in INR

      const existing = await db
        .select()
        .from(instruments)
        .where(sql`${instruments.symbol} = ${cleanSymbol}`);

      if (existing.length === 0) {
        await db.insert(instruments).values({
          symbol: cleanSymbol,
          name: cleanName,
          exchange: s.exchange,
          segment: s.segment,
          expiry: s.expiryDate,
          lotSize: s.lotSize,
          lotClass: defaultLotClass(s.exchange, cleanSymbol),
          lotLabel: defaultLotLabel(cleanSymbol),
          tickMinor,
          refPriceMinor: defaultRefPrice(cleanSymbol),
          active: true,
          dhanSecurityId: s.securityId,
          dhanSegment: s.dhanSegment,
        });
        inserted++;
      } else {
        await db
          .update(instruments)
          .set({
            name: cleanName,
            exchange: s.exchange,
            segment: s.segment,
            expiry: s.expiryDate,
            lotSize: s.lotSize,
            tickMinor,
            active: true,
            dhanSecurityId: s.securityId,
            dhanSegment: s.dhanSegment,
          })
          .where(sql`${instruments.symbol} = ${cleanSymbol}`);
        updated++;
      }
    }

    await seedCategories(db);
    console.log(`Sync complete! Inserted: ${inserted}, Updated: ${updated}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
