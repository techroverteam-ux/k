import { databaseUrl, databaseHost } from '../src/db/database-url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';
import { emailColumns, phoneColumns } from '../src/common/pii';

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

async function main() {
  const url = databaseUrl();
  console.log(`migrating ${databaseHost(url)}`);
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  await encryptLegacyPii(pool);
  await pool.end();
  console.log('migrations applied');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
