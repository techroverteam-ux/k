import { databaseUrl } from '../src/db/database-url';
import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { instruments } from '../src/db/schema';
import { defaultLotClass, defaultLotLabel } from '../src/trading/instrument-meta';

interface SeedItem {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  expiry?: Date;
  lotSize: number;
  tickMinor: number;
  refPriceMinor: bigint;
  lotClass?: 'MINI' | 'MEGA';
  lotLabel?: string;
  dhanSecurityId?: string;
  dhanSegment?: string;
}

const nearMonthExpiry = new Date(Date.now() + 25 * 86400000);

const ITEMS: SeedItem[] = [
  // OPTIONS (NSE NIFTY & BANKNIFTY Call and Put options)
  { symbol: 'NIFTY25000CE', name: 'NIFTY 50 25000 Call Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 25, tickMinor: 5, refPriceMinor: 145_00n, lotClass: 'MINI', lotLabel: '25 units' },
  { symbol: 'NIFTY25000PE', name: 'NIFTY 50 25000 Put Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 25, tickMinor: 5, refPriceMinor: 110_00n, lotClass: 'MINI', lotLabel: '25 units' },
  { symbol: 'NIFTY25200CE', name: 'NIFTY 50 25200 Call Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 25, tickMinor: 5, refPriceMinor: 85_00n, lotClass: 'MINI', lotLabel: '25 units' },
  { symbol: 'NIFTY25200PE', name: 'NIFTY 50 25200 Put Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 25, tickMinor: 5, refPriceMinor: 175_00n, lotClass: 'MINI', lotLabel: '25 units' },
  { symbol: 'BANKNIFTY52000CE', name: 'BANK NIFTY 52000 Call Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 15, tickMinor: 5, refPriceMinor: 320_00n, lotClass: 'MINI', lotLabel: '15 units' },
  { symbol: 'BANKNIFTY52000PE', name: 'BANK NIFTY 52000 Put Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 15, tickMinor: 5, refPriceMinor: 260_00n, lotClass: 'MINI', lotLabel: '15 units' },
  { symbol: 'BANKNIFTY52500CE', name: 'BANK NIFTY 52500 Call Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 15, tickMinor: 5, refPriceMinor: 180_00n, lotClass: 'MINI', lotLabel: '15 units' },
  { symbol: 'BANKNIFTY52500PE', name: 'BANK NIFTY 52500 Put Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 15, tickMinor: 5, refPriceMinor: 410_00n, lotClass: 'MINI', lotLabel: '15 units' },
  { symbol: 'RELIANCE1300CE', name: 'RELIANCE 1300 Call Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 250, tickMinor: 5, refPriceMinor: 32_50n, lotClass: 'MINI', lotLabel: '250 shares' },
  { symbol: 'RELIANCE1300PE', name: 'RELIANCE 1300 Put Option', exchange: 'NSE', segment: 'OPT', expiry: nearMonthExpiry, lotSize: 250, tickMinor: 5, refPriceMinor: 24_00n, lotClass: 'MINI', lotLabel: '250 shares' },

  // FOREX (Currency pairs & futures)
  { symbol: 'USDINR-FUT', name: 'US Dollar / Indian Rupee Future', exchange: 'CDS', segment: 'CUR', expiry: nearMonthExpiry, lotSize: 1000, tickMinor: 25, refPriceMinor: 84_42n, lotClass: 'MINI', lotLabel: '1,000 USD' },
  { symbol: 'EURINR-FUT', name: 'Euro / Indian Rupee Future', exchange: 'CDS', segment: 'CUR', expiry: nearMonthExpiry, lotSize: 1000, tickMinor: 25, refPriceMinor: 91_65n, lotClass: 'MINI', lotLabel: '1,000 EUR' },
  { symbol: 'GBPINR-FUT', name: 'British Pound / Indian Rupee Future', exchange: 'CDS', segment: 'CUR', expiry: nearMonthExpiry, lotSize: 1000, tickMinor: 25, refPriceMinor: 109_80n, lotClass: 'MINI', lotLabel: '1,000 GBP' },
  { symbol: 'JPYINR-FUT', name: 'Japanese Yen / Indian Rupee Future', exchange: 'CDS', segment: 'CUR', expiry: nearMonthExpiry, lotSize: 1000, tickMinor: 25, refPriceMinor: 55_40n, lotClass: 'MINI', lotLabel: '1,00,000 JPY' },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', exchange: 'FOREX', segment: 'CUR', lotSize: 1000, tickMinor: 1, refPriceMinor: 1_08n, lotClass: 'MINI', lotLabel: '1,000 EUR' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', exchange: 'FOREX', segment: 'CUR', lotSize: 1000, tickMinor: 1, refPriceMinor: 1_29n, lotClass: 'MINI', lotLabel: '1,000 GBP' },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', exchange: 'FOREX', segment: 'CUR', lotSize: 1000, tickMinor: 1, refPriceMinor: 152_30n, lotClass: 'MINI', lotLabel: '1,000 USD' },

  // CRYPTO
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 1, tickMinor: 100, refPriceMinor: 80_078_18n, lotClass: 'MINI', lotLabel: '1 BTC' },
  { symbol: 'ETHUSD', name: 'Ethereum / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 1, tickMinor: 50, refPriceMinor: 2_650_00n, lotClass: 'MINI', lotLabel: '1 ETH' },
  { symbol: 'SOLUSD', name: 'Solana / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 1, tickMinor: 10, refPriceMinor: 178_50n, lotClass: 'MINI', lotLabel: '1 SOL' },
  { symbol: 'XRPUSD', name: 'XRP / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 10, tickMinor: 1, refPriceMinor: 52n, lotClass: 'MINI', lotLabel: '10 XRP' },
  { symbol: 'BNBUSD', name: 'BNB / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 1, tickMinor: 10, refPriceMinor: 595_00n, lotClass: 'MINI', lotLabel: '1 BNB' },
  { symbol: 'DOGEUSD', name: 'Dogecoin / US Dollar', exchange: 'CRYPTO', segment: 'CRYPTO', lotSize: 100, tickMinor: 1, refPriceMinor: 16n, lotClass: 'MINI', lotLabel: '100 DOGE' },

  // US STOCK
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 100, tickMinor: 1, refPriceMinor: 349_42n, lotClass: 'MINI', lotLabel: '100 shares', dhanSecurityId: '10000025', dhanSegment: 'INX_EQ' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 542_00n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10006754', dhanSegment: 'INX_EQ' },
  { symbol: 'NVDA', name: 'Nvidia Corporation', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 186_30n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10007290', dhanSegment: 'INX_EQ' },
  { symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 349_10n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10010311', dhanSegment: 'INX_EQ' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 247_50n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10000496', dhanSegment: 'INX_EQ' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 280_40n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10004393', dhanSegment: 'INX_EQ' },
  { symbol: 'META', name: 'Meta Platforms Inc.', exchange: 'NASDAQ', segment: 'US_STOCK', lotSize: 1, tickMinor: 1, refPriceMinor: 674_10n, lotClass: 'MINI', lotLabel: '1 share', dhanSecurityId: '10006471', dhanSegment: 'INX_EQ' },

  // COMEX
  { symbol: 'GC-COMEX', name: 'Gold COMEX Futures', exchange: 'COMEX', segment: 'FUT', expiry: nearMonthExpiry, lotSize: 100, tickMinor: 10, refPriceMinor: 4_072_20n, lotClass: 'MEGA', lotLabel: '100 oz' },
  { symbol: 'SI-COMEX', name: 'Silver COMEX Futures', exchange: 'COMEX', segment: 'FUT', expiry: nearMonthExpiry, lotSize: 5000, tickMinor: 1, refPriceMinor: 33_85n, lotClass: 'MEGA', lotLabel: '5,000 oz' },
  { symbol: 'CL-COMEX', name: 'Crude Oil WTI COMEX Futures', exchange: 'COMEX', segment: 'FUT', expiry: nearMonthExpiry, lotSize: 1000, tickMinor: 1, refPriceMinor: 71_80n, lotClass: 'MEGA', lotLabel: '1,000 barrels' },
  { symbol: 'HG-COMEX', name: 'Copper COMEX Futures', exchange: 'COMEX', segment: 'FUT', expiry: nearMonthExpiry, lotSize: 25000, tickMinor: 1, refPriceMinor: 4_38n, lotClass: 'MEGA', lotLabel: '25,000 lbs' },
  { symbol: 'NG-COMEX', name: 'Natural Gas COMEX Futures', exchange: 'COMEX', segment: 'FUT', expiry: nearMonthExpiry, lotSize: 10000, tickMinor: 1, refPriceMinor: 2_82n, lotClass: 'MEGA', lotLabel: '10,000 mmBtu' },

  // US INDEX
  { symbol: 'SPX', name: 'S&P 500 Index (SPY ETF)', exchange: 'US_INDEX', segment: 'INDEX', lotSize: 1, tickMinor: 10, refPriceMinor: 585_00n, lotClass: 'MINI', lotLabel: '1 unit', dhanSecurityId: '10009619', dhanSegment: 'INX_EQ' },
  { symbol: 'NDX', name: 'Nasdaq 100 Index (QQQ ETF)', exchange: 'US_INDEX', segment: 'INDEX', lotSize: 1, tickMinor: 10, refPriceMinor: 502_00n, lotClass: 'MINI', lotLabel: '1 unit', dhanSecurityId: '10008402', dhanSegment: 'INX_EQ' },
  { symbol: 'DJI', name: 'Dow Jones Index (DIA ETF)', exchange: 'US_INDEX', segment: 'INDEX', lotSize: 1, tickMinor: 10, refPriceMinor: 435_00n, lotClass: 'MINI', lotLabel: '1 unit', dhanSecurityId: '10002663', dhanSegment: 'INX_EQ' },
  { symbol: 'RUT', name: 'Russell 2000 Index (IWM ETF)', exchange: 'US_INDEX', segment: 'INDEX', lotSize: 1, tickMinor: 10, refPriceMinor: 225_00n, lotClass: 'MINI', lotLabel: '1 unit', dhanSecurityId: '10005457', dhanSegment: 'INX_EQ' },
];

async function main() {
  const pool = createPool(databaseUrl(), 2);
  const db = drizzle(pool, { schema });

  try {
    let inserted = 0;
    let updated = 0;

    for (const item of ITEMS) {
      const existing = await db
        .select()
        .from(instruments)
        .where(sql`${instruments.symbol} = ${item.symbol}`);

      if (existing.length === 0) {
        await db.insert(instruments).values({
          symbol: item.symbol,
          name: item.name,
          exchange: item.exchange,
          segment: item.segment,
          expiry: item.expiry,
          lotSize: item.lotSize,
          lotClass: item.lotClass ?? defaultLotClass(item.exchange, item.symbol),
          lotLabel: item.lotLabel ?? defaultLotLabel(item.symbol),
          tickMinor: item.tickMinor,
          refPriceMinor: item.refPriceMinor,
          active: true,
          dhanSecurityId: item.dhanSecurityId,
          dhanSegment: item.dhanSegment,
        });
        inserted++;
      } else {
        await db
          .update(instruments)
          .set({
            name: item.name,
            exchange: item.exchange,
            segment: item.segment,
            expiry: item.expiry,
            lotSize: item.lotSize,
            lotClass: item.lotClass ?? defaultLotClass(item.exchange, item.symbol),
            lotLabel: item.lotLabel ?? defaultLotLabel(item.symbol),
            tickMinor: item.tickMinor,
            refPriceMinor: item.refPriceMinor,
            active: true,
            dhanSecurityId: item.dhanSecurityId,
            dhanSegment: item.dhanSegment,
          })
          .where(sql`${instruments.symbol} = ${item.symbol}`);
        updated++;
      }
    }

    console.log(`Successfully seeded categories! Inserted: ${inserted}, Updated: ${updated}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});

