import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, isNotNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { env } from '../config/env';
import { DbService } from '../db/db';
import { logArchives, otpChallenges, sessions } from '../db/schema';
import { archiveDay } from './archive';

/** Quiet read operations (admin-configured) shared with the activity plugin. */
/** Public polling that is never written to the activity log (it carries no account action). */
export const ALWAYS_QUIET = ['marketPulse'];
export const quietOps = { set: new Set<string>(ALWAYS_QUIET) };

/**
 * Log housekeeping, every 15 minutes, on exactly one API instance (Postgres advisory lock):
 *  1. archive every complete past day (audit + activity) that isn't archived yet;
 *  2. delete activity rows older than `logs.activityRetentionDays` — only for archived days;
 *  3. purge expired OTP challenges (>1 day) and dead sessions (>90 days).
 * The audit trail is never deleted by the application; it lives in the DB and in the archives.
 */
@Injectable()
export class LogMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('LogMaintenance');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dbs: DbService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    void this.refreshQuiet();
    if (env().LOG_MAINTENANCE === 'off') return;
    this.timer = setInterval(() => void this.run(), 15 * 60_000);
    setTimeout(() => void this.run(), 30_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async refreshQuiet() {
    quietOps.set = new Set([...ALWAYS_QUIET, ...(await this.config.get('logs.quietOperations'))]);
  }

  async run(now = new Date()) {
    const client = await this.dbs.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('td_log_maintenance')) AS ok`);
      if (!rows[0]?.ok) return { skipped: 'another instance is running maintenance' };
      try {
        await this.refreshQuiet();
        const archived = await this.archivePending(now);
        const purged = await this.purge(now);
        if (archived.length || purged.activity || purged.otp || purged.sessions) {
          await this.audit.recordStandalone({ action: 'logs.maintenance', outcome: 'SUCCESS', metadata: { archived, purged } });
        }
        return { archived, purged };
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('td_log_maintenance'))`);
      }
    } catch (e) {
      this.log.error(`log maintenance failed: ${(e as Error).message}`);
      await this.audit.recordStandalone({ action: 'logs.maintenance', outcome: 'FAILURE', metadata: { error: (e as Error).message } });
      return { error: (e as Error).message };
    } finally {
      client.release();
    }
  }

  /** Archive every complete day since the last archive (or since the oldest row). */
  async archivePending(now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const [last] = await this.dbs.db.select({ day: logArchives.day }).from(logArchives).orderBy(desc(logArchives.day)).limit(1);
    let start: string;
    if (last) start = new Date(new Date(`${last.day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    else {
      const r = await this.dbs.db.execute<{ d: string | null }>(sql`SELECT to_char(least((SELECT min(created_at) FROM audit_events), (SELECT min(at) FROM activity_log)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`);
      start = r.rows[0]?.d ?? today;
    }
    const done: string[] = [];
    for (let d = start; d < today; d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)) {
      for (const kind of ['audit', 'activity'] as const) await archiveDay(this.dbs.db, env().LOG_ARCHIVE_DIR, d, kind);
      done.push(d);
    }
    return done;
  }

  async purge(now = new Date()) {
    const days = await this.config.get('logs.activityRetentionDays');
    const requireArchive = await this.config.get('logs.requireArchiveBeforePurge');
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const r = await this.dbs.db.execute<{ n: string }>(sql`SELECT td_purge_activity(${cutoff}, ${requireArchive})::text AS n`);
    const otp = await this.dbs.db.delete(otpChallenges).where(lt(otpChallenges.createdAt, new Date(now.getTime() - 86_400_000))).returning({ id: otpChallenges.id });
    const old = new Date(now.getTime() - 90 * 86_400_000);
    const sess = await this.dbs.db
      .delete(sessions)
      .where(or(and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, old)), lt(sessions.expiresAt, old)))
      .returning({ id: sessions.id });
    return { activity: Number(r.rows[0]?.n ?? 0), otp: otp.length, sessions: sess.length, cutoff: cutoff.toISOString() };
  }
}
