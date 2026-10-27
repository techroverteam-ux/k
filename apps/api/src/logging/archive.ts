import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createGzip } from 'zlib';
import { and, asc, eq, gt, gte, lt } from 'drizzle-orm';
import type { Database } from '../db/db';
import { activityLog, auditEvents, logArchives } from '../db/schema';

export type ArchiveKind = 'audit' | 'activity';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const dayRange = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const from = new Date(`${day}T00:00:00.000Z`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
};

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Pages through one day's rows in id order, yielding NDJSON lines. */
async function* rowsFor(db: Database, kind: ArchiveKind, day: string, meta: { first?: string; last?: string; lastHash?: string; count: number }) {
  const { from, to } = dayRange(day);
  let after = 0n;
  for (;;) {
    const batch =
      kind === 'audit'
        ? await db.select().from(auditEvents).where(and(gte(auditEvents.createdAt, from), lt(auditEvents.createdAt, to), gt(auditEvents.seq, after))).orderBy(asc(auditEvents.seq)).limit(2000)
        : await db.select().from(activityLog).where(and(gte(activityLog.at, from), lt(activityLog.at, to), gt(activityLog.id, after))).orderBy(asc(activityLog.id)).limit(2000);
    if (!batch.length) return;
    for (const r of batch) {
      const key = 'seq' in r ? r.seq : (r as { id: bigint }).id;
      meta.first ??= key.toString();
      meta.last = key.toString();
      if ('hash' in r) meta.lastHash = r.hash;
      meta.count++;
      after = key;
      yield JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';
    }
  }
}

/**
 * Archive one complete UTC day of a log to `<dir>/<YYYY>/<MM>/<day>-<kind>.ndjson.gz`, record its
 * SHA-256 in log_archives, and write a manifest. Idempotent: an already-archived day is skipped.
 * In production, point `dir` at storage with object lock / WORM retention (e.g. an S3 bucket with
 * Object Lock in compliance mode, mounted or synced), so archives can't be altered or deleted.
 */
export async function archiveDay(db: Database, dir: string, day: string, kind: ArchiveKind) {
  if (day >= isoDay(new Date())) throw new Error('Only complete past days can be archived.');
  const [done] = await db.select().from(logArchives).where(and(eq(logArchives.day, day), eq(logArchives.kind, kind)));
  if (done) return { skipped: true, ...done };
  const sub = path.join(dir, day.slice(0, 4), day.slice(5, 7));
  mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${day}-${kind}.ndjson.gz`);
  const meta: { first?: string; last?: string; lastHash?: string; count: number } = { count: 0 };
  await pipeline(Readable.from(rowsFor(db, kind, day, meta)), createGzip(), createWriteStream(file));
  const sha256 = await sha256File(file);
  const manifest = { day, kind, rows: meta.count, sha256, file: path.basename(file), firstId: meta.first ?? null, lastId: meta.last ?? null, lastAuditHash: meta.lastHash ?? null, generatedAt: new Date().toISOString() };
  writeFileSync(path.join(sub, `${day}-${kind}.manifest.json`), JSON.stringify(manifest, null, 2));
  const [row] = await db
    .insert(logArchives)
    .values({ day, kind, rows: meta.count, sha256, location: file, firstId: meta.first, lastId: meta.last, lastAuditHash: meta.lastHash })
    .onConflictDoNothing()
    .returning();
  return { skipped: false, ...(row ?? manifest) };
}

/** Re-hash an archive file and compare with the checksum recorded at archive time. */
export async function verifyArchive(db: Database, day: string, kind: ArchiveKind) {
  const [a] = await db.select().from(logArchives).where(and(eq(logArchives.day, day), eq(logArchives.kind, kind)));
  if (!a) return { ok: false, reason: 'not archived' };
  if (!existsSync(a.location)) return { ok: false, reason: 'file missing', location: a.location };
  const actual = await sha256File(a.location);
  return actual === a.sha256 ? { ok: true, rows: a.rows } : { ok: false, reason: 'checksum mismatch', expected: a.sha256, actual };
}
