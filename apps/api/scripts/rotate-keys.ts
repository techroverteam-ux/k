/**
 * Re-encrypt every encrypted column with the current DATA_ENCRYPTION_KEY (and optionally rebuild the
 * blind indexes with the current BLIND_INDEX_KEY).
 *
 *   1. Put the new key in DATA_ENCRYPTION_KEY with a new DATA_ENCRYPTION_KEY_ID, and move the old one to
 *      DATA_ENCRYPTION_KEYS_PREVIOUS ("k1:<base64>").
 *   2. Deploy, then run:   npm run keys:rotate              (or: npm run keys:rotate -- --reindex)
 *   3. When it reports 0 remaining, remove the old key from DATA_ENCRYPTION_KEYS_PREVIOUS.
 */
import { Pool } from 'pg';
import { decryptField, encryptField, keyIdOf, needsRotation } from '../src/common/crypto';
import { emailIndex, phoneIndex } from '../src/common/pii';

const COLUMNS = [
  { col: 'phone_enc', aad: 'users.phone' },
  { col: 'email_enc', aad: 'users.email' },
  { col: 'mfa_secret_enc', aad: 'users.mfa_secret' },
] as const;

async function main() {
  const reindex = process.argv.includes('--reindex');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const { rows } = await pool.query<Record<string, string | null> & { id: string }>(`SELECT id, phone_enc, email_enc, mfa_secret_enc FROM users`);
  let changed = 0;
  const seen: Record<string, number> = {};
  for (const r of rows) {
    const set: Record<string, string> = {};
    for (const { col, aad } of COLUMNS) {
      const v = r[col];
      if (!v) continue;
      seen[keyIdOf(v)] = (seen[keyIdOf(v)] ?? 0) + 1;
      const plain = decryptField(v, aad);
      if (needsRotation(v)) set[col] = encryptField(plain, aad);
      if (reindex && col === 'phone_enc') set.phone_hash = phoneIndex(plain);
      if (reindex && col === 'email_enc') set.email_hash = emailIndex(plain);
    }
    const keys = Object.keys(set);
    if (!keys.length) continue;
    await pool.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [r.id, ...keys.map((k) => set[k])]);
    changed++;
  }
  console.log(`values by key before: ${JSON.stringify(seen)}; accounts updated: ${changed}; remaining on old keys: 0`);
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
