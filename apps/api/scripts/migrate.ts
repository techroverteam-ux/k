import { databaseUrl, databaseHost } from '../src/db/database-url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';
import { emailColumns, phoneColumns } from '../src/common/pii';
import { blindIndex, encryptField, isSealed } from '../src/common/crypto';
import { dbSsl } from '../src/db/db';

/**
 * One-time data step after the SQL migrations: move any plaintext phone/email (written before
 * field encryption existed) into the encrypted + blind-index columns, then clear the plaintext.
 * Idempotent; needs the encryption keys from the environment.
 */
async function encryptLegacyPii(pool: Pool) {
  const { rows } = await pool.query<{ id: string; phone: string | null; email: string | null }>(
    `SELECT id, phone, email FROM users WHERE phone IS NOT NULL OR email IS NOT NULL`,
  );
  for (const r of rows) {
    const p = phoneColumns(r.phone);
    const e = emailColumns(r.email);
    await pool.query(
      `UPDATE users SET phone_enc = COALESCE(phone_enc, $2), phone_hash = COALESCE(phone_hash, $3), email_enc = COALESCE(email_enc, $4), email_hash = COALESCE(email_hash, $5), phone = NULL, email = NULL WHERE id = $1`,
      [r.id, p.phoneEnc, p.phoneHash, e.emailEnc, e.emailHash],
    );
  }
  if (rows.length) console.log(`encrypted contact details for ${rows.length} account(s)`);
}

/** Encrypt fee details written before 0015: payee account numbers / UPI IDs, and payment UTRs (+ blind index). Idempotent. */
async function encryptFeeDetails(pool: Pool) {
  const payees = await pool.query<{ id: string; account_number: string | null; upi_id: string | null }>(`SELECT id, account_number, upi_id FROM payee_accounts`);
  let n = 0;
  for (const r of payees.rows) {
    const acc = r.account_number && !isSealed(r.account_number) ? encryptField(r.account_number, 'payee_accounts.account_number') : r.account_number;
    const upi = r.upi_id && !isSealed(r.upi_id) ? encryptField(r.upi_id, 'payee_accounts.upi_id') : r.upi_id;
    if (acc !== r.account_number || upi !== r.upi_id) { await pool.query(`UPDATE payee_accounts SET account_number = $2, upi_id = $3 WHERE id = $1`, [r.id, acc, upi]); n++; }
  }
  const fees = await pool.query<{ id: string; utr: string }>(`SELECT id, utr FROM fee_payments WHERE utr_hash IS NULL`);
  for (const r of fees.rows) {
    if (isSealed(r.utr)) continue;
    await pool.query(`UPDATE fee_payments SET utr = $2, utr_hash = $3 WHERE id = $1`, [r.id, encryptField(r.utr, 'fee_payments.utr'), blindIndex(r.utr, 'utr')]);
    n++;
  }
  if (n) console.log(`encrypted fee details on ${n} row(s)`);
}

async function main() {
  const url = databaseUrl();
  console.log(`migrating ${databaseHost(url)}`);
  const pool = new Pool({ connectionString: url, max: 1, ssl: dbSsl(url, process.env.NODE_ENV) });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  await encryptLegacyPii(pool);
  await encryptFeeDetails(pool);
  await pool.end();
  console.log('migrations applied');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
