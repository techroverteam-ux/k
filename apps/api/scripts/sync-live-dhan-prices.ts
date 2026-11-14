import { Pool } from 'pg';
import WebSocket from 'ws';

// Credentials come from the environment (never commit them): DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN.
const clientId = process.env.DHAN_CLIENT_ID ?? '';
const token = process.env.DHAN_ACCESS_TOKEN ?? '';
if (!clientId || !token) {
  console.error('Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in the environment first.');
  process.exit(1);
}

interface DhanQuote {
  ltp: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://tradedesk:tradedesk_dev@127.0.0.1:5432/tradedesk',
  });

  console.log('Fetching Dhan instruments from DB...');
  const res = await pool.query(`
    SELECT id, symbol, name, tick_minor, dhan_security_id, dhan_segment
    FROM instruments
    WHERE dhan_security_id IS NOT NULL AND active = true
  `);

  console.log(`Found ${res.rows.length} Dhan instruments.`);

  const quotes = new Map<string, DhanQuote>();
  const wsUrl = `wss://api-feed.dhan.co?version=2&token=${token}&clientId=${clientId}&authType=2`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.log(`Finished collecting quotes after 8s.`);
      try { ws.close(); } catch {}
      resolve();
    }, 8000);

    ws.on('open', () => {
      console.log('Connected to Dhan WebSocket. Subscribing in batches...');
      const CHUNK = 100;
      const subs = res.rows.map((r) => ({
        ExchangeSegment: r.dhan_segment,
        SecurityId: r.dhan_security_id,
      }));

      for (let i = 0; i < subs.length; i += CHUNK) {
        const chunk = subs.slice(i, i + CHUNK);
        ws.send(JSON.stringify({
          RequestCode: 17,
          InstrumentCount: chunk.length,
          InstrumentList: chunk,
        }));
      }
    });

    ws.on('message', (buf: Buffer) => {
      if (buf.length < 8) return;
      const code = buf.readUInt8(0);
      const secId = buf.readUInt32LE(4).toString();

      if ((code === 4 || code === 8) && buf.length >= 50) {
        const ltp = buf.readFloatLE(8);
        const volume = buf.readUInt32LE(22);
        const open = buf.readFloatLE(34);
        const close = buf.readFloatLE(38);
        const high = buf.readFloatLE(42);
        const low = buf.readFloatLE(46);
        quotes.set(secId, { ltp, open, close, high, low, volume });
      } else if (code === 2 && buf.length >= 12) {
        const ltp = buf.readFloatLE(8);
        const existing = quotes.get(secId);
        if (existing) {
          existing.ltp = ltp;
        } else {
          quotes.set(secId, { ltp, open: ltp, close: ltp, high: ltp, low: ltp, volume: 0 });
        }
      } else if (code === 6 && buf.length >= 12) {
        const close = buf.readFloatLE(8);
        const existing = quotes.get(secId);
        if (existing) {
          existing.close = close;
        } else {
          quotes.set(secId, { ltp: close, open: close, close, high: close, low: close, volume: 0 });
        }
      }
    });

    ws.on('error', (err) => {
      console.error('WS Error:', err);
      clearTimeout(timer);
      resolve();
    });
  });

  console.log(`Received real Dhan quotes for ${quotes.size} instruments.`);


  for (const row of res.rows) {
    const q = quotes.get(row.dhan_security_id);
    if (!q) continue;

    const realPrice = q.ltp > 0 ? q.ltp : q.close;
    if (realPrice <= 0) continue;

    const refPriceMinor = BigInt(Math.round(realPrice * 100));

    // Update reference price in instruments table
    await pool.query(
      `UPDATE instruments SET ref_price_minor = $1 WHERE id = $2`,
      [refPriceMinor.toString(), row.id]
    );

    if (row.symbol.includes('GOLD') || row.symbol.includes('NIFTY')) {
      console.log(`Synced ${row.symbol.padEnd(25)} -> LTP: ${realPrice}, PrevClose: ${q.close}`);
    }
  }

  console.log('Dhan instruments sync complete!');
  await pool.end();
}

main().catch(console.error);

