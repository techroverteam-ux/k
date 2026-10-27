/**
 * Archive one or more complete UTC days of the audit trail and activity log.
 *   npm run logs:archive -- 2026-10-26            # one day
 *   npm run logs:archive -- 2026-10-01 2026-10-26 # a range
 *   npm run logs:verify  -- 2026-10-26            # re-hash and compare with the recorded checksum
 * The API also does this automatically every 15 minutes (LOG_MAINTENANCE=on).
 */
import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { archiveDay, verifyArchive } from '../src/logging/archive';

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const dir = process.env.LOG_ARCHIVE_DIR ?? './log-archive';
  const pool = createPool(process.env.DATABASE_URL!, 2);
  const db = drizzle(pool, { schema });
  const days: string[] = [];
  for (let d = a; d && d <= (b ?? a); d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)) days.push(d);
  if (!days.length) throw new Error('usage: archive-logs.ts <archive|verify> YYYY-MM-DD [YYYY-MM-DD]');
  for (const day of days) for (const kind of ['audit', 'activity'] as const) {
    const r = cmd === 'verify' ? await verifyArchive(db, day, kind) : await archiveDay(db, dir, day, kind);
    console.log(day, kind, JSON.stringify(r));
  }
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
