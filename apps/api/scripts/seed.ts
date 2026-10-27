/**
 * Development seed: two Super Admins (maker + checker), two brokers, three traders,
 * instruments, and virtual opening balances. Passwords come from env, never hard-coded.
 *
 *   SEED_PASSWORD="Dev-Only-Passw0rd!" npm run db:seed
 */
import { databaseUrl } from '../src/db/database-url';
import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as argon2 from 'argon2';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { instruments, journalEntries, ledgerAccounts, ledgerPostings, users } from '../src/db/schema';

const EXPIRY = new Date('2026-11-24T10:00:00Z');
const INSTRUMENTS: Array<[string, string, string, string, number, number, number]> = [
  // base, name, exchange, segment, refPrice (₹), lot, tick(paise)
  ['ABB', 'ABB India', 'NSE', 'FUT', 6364.5, 125, 5],
  ['ABCAPITAL', 'Aditya Birla Capital', 'NSE', 'FUT', 352.5, 3100, 5],
  ['ADANIENT', 'Adani Enterprises', 'NSE', 'FUT', 2511.4, 300, 10],
  ['ADANIGREEN', 'Adani Green Energy', 'NSE', 'FUT', 1245.9, 600, 10],
  ['ADANIPORTS', 'Adani Ports & SEZ', 'NSE', 'FUT', 1746.3, 475, 10],
  ['AMBUJACEM', 'Ambuja Cements', 'NSE', 'FUT', 371.35, 1050, 5],
  ['RELIANCE', 'Reliance Industries', 'NSE', 'FUT', 1452.6, 500, 10],
  ['TCS', 'Tata Consultancy Services', 'NSE', 'FUT', 3088.2, 175, 10],
  ['INFY', 'Infosys', 'NSE', 'FUT', 1512.4, 400, 10],
  ['HDFCBANK', 'HDFC Bank', 'NSE', 'FUT', 1006.3, 550, 5],
  ['SBIN', 'State Bank of India', 'NSE', 'FUT', 905.15, 750, 5],
  ['KAYNES', 'Kaynes Technology', 'NSE', 'FUT', 6720, 100, 50],
  ['SAIL', 'Steel Authority of India', 'NSE', 'FUT', 136.42, 4700, 1],
  ['NIFTY', 'Nifty 50 Index', 'NSE', 'FUT', 25890, 75, 10],
  ['BANKNIFTY', 'Nifty Bank Index', 'NSE', 'FUT', 58210, 35, 20],
  ['GOLD', 'Gold (1 kg)', 'MCX', 'FUT', 121450, 1, 100],
  ['SILVER', 'Silver (30 kg)', 'MCX', 'FUT', 148300, 1, 100],
  ['CRUDEOIL', 'Crude Oil', 'MCX', 'FUT', 5321, 100, 100],
];

async function main() {
  const pw = process.env.SEED_PASSWORD;
  if (!pw || pw.length < 12) throw new Error('Set SEED_PASSWORD (≥12 chars) for the seeded dev accounts.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo accounts in production.');
  const pool = createPool(databaseUrl(), 2);
  const db = drizzle(pool, { schema });
  const hash = await argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 3, parallelism: 1 });

  await db.transaction(async (tx) => {
    for (const [base, name, exchange, segment, price, lot, tick] of INSTRUMENTS) {
      await tx
        .insert(instruments)
        .values({ symbol: `${base}26NOVFUT`, name: `${name} — Nov 26 FUT`, exchange, segment, expiry: EXPIRY, lotSize: lot, tickMinor: tick, refPriceMinor: BigInt(Math.round(price * 100)) })
        .onConflictDoNothing();
    }

    const mk = async (username: string, displayName: string, role: schema.Role, brokerId?: string) => {
      const [existing] = await tx.select().from(users).where(eq(users.username, username));
      if (existing) return existing;
      const [u] = await tx.insert(users).values({ username, displayName, role, status: 'ACTIVE', passwordHash: hash, brokerId, termsAcceptedAt: role === 'TRADER' ? null : new Date() }).returning();
      return u;
    };
    await mk('admin', 'Platform Admin', 'SUPER_ADMIN');
    await mk('checker', 'Second Admin (checker)', 'SUPER_ADMIN');
    const b1 = await mk('broker.one', 'Broker One', 'BROKER');
    const b2 = await mk('broker.two', 'Broker Two', 'BROKER');
    const traders = [await mk('trader.one', 'Trader One', 'TRADER', b1.id), await mk('trader.two', 'Trader Two', 'TRADER', b1.id), await mk('trader.three', 'Trader Three', 'TRADER', b2.id)];

    const fundCode = 'sys:FUNDING_SOURCE:SIMULATED';
    await tx.insert(ledgerAccounts).values({ code: fundCode, type: 'FUNDING_SOURCE', mode: 'SIMULATED' }).onConflictDoNothing();
    const [fund] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.code, fundCode));
    for (const t of traders) {
      const code = `cash:SIMULATED:${t.id}`;
      await tx.insert(ledgerAccounts).values({ code, type: 'TRADER_CASH', mode: 'SIMULATED', ownerId: t.id }).onConflictDoNothing();
      const [cash] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
      const key = `opening:${t.id}`;
      const [done] = await tx.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, key));
      if (done) continue;
      const [j] = await tx.insert(journalEntries).values({ idempotencyKey: key, kind: 'OPENING_BALANCE', mode: 'SIMULATED', memo: 'Virtual opening balance (no cash value)', refType: 'user', refId: t.id }).returning();
      await tx.insert(ledgerPostings).values([
        { journalId: j.id, accountId: cash.id, amountMinor: 50_000_000n },
        { journalId: j.id, accountId: fund.id, amountMinor: -50_000_000n },
      ]);
    }
  });
  await pool.end();
  console.log('Seeded: admin, checker (SUPER_ADMIN) · broker.one, broker.two · trader.one, trader.two (broker.one), trader.three (broker.two)');
  console.log('All use the password from SEED_PASSWORD. Super Admins must enrol TOTP MFA on first sign-in.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
