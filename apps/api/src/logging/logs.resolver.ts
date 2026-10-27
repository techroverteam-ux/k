import { Args, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { desc } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AllowWithoutMfa, CurrentActor, RequireStepUp, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { clampLimit } from '../common/mappers';
import { DbService } from '../db/db';
import { logArchives, type ActivityRow } from '../db/schema';
import { ActivityLogService } from './activity-log.service';
import { verifyArchive } from './archive';
import { LogMaintenanceService } from './log-maintenance.service';

@ObjectType()
class ActivityEntry {
  @Field() id: string;
  @Field() at: Date;
  @Field() requestId: string;
  @Field(() => ID, { nullable: true }) userId?: string;
  @Field({ nullable: true }) username?: string;
  @Field({ nullable: true }) role?: string;
  @Field(() => ID, { nullable: true }) sessionId?: string;
  @Field() ip: string;
  @Field({ nullable: true }) userAgent?: string;
  @Field({ nullable: true }) client?: string;
  @Field() opType: string;
  @Field({ nullable: true }) opName?: string;
  @Field({ nullable: true }) fields?: string;
  @Field({ nullable: true, description: 'JSON; secrets are redacted before storage' }) variablesJson?: string;
  @Field() outcome: string;
  @Field({ nullable: true }) errorCode?: string;
  @Field(() => Int, { nullable: true }) durationMs?: number;
}

@ObjectType()
class IpAccount {
  @Field(() => ID) userId: string;
  @Field() username: string;
  @Field() role: string;
  @Field(() => Int) requests: number;
  @Field() firstSeen: Date;
  @Field() lastSeen: Date;
}

@ObjectType()
class UserIp {
  @Field() ip: string;
  @Field(() => Int) requests: number;
  @Field() firstSeen: Date;
  @Field() lastSeen: Date;
  @Field(() => Int, { description: 'Other accounts seen on this IP in the same window' }) otherAccounts: number;
}

@ObjectType()
class LogArchive {
  @Field() day: string;
  @Field() kind: string;
  @Field(() => Int) rows: number;
  @Field() sha256: string;
  @Field() location: string;
  @Field({ nullable: true }) lastAuditHash?: string;
  @Field() createdAt: Date;
}

@ObjectType()
class ArchiveCheck {
  @Field() ok: boolean;
  @Field({ nullable: true }) reason?: string;
  @Field(() => Int, { nullable: true }) rows?: number;
}

@InputType()
class ActivityFilter {
  @Field(() => ID, { nullable: true }) userId?: string;
  @Field({ nullable: true }) ip?: string;
  @Field({ nullable: true }) opName?: string;
  @Field({ nullable: true, description: 'OK or ERROR' }) outcome?: string;
  @Field({ nullable: true, description: 'Only actions (mutations), sign-ins and live-feed connections' }) actionsOnly?: boolean;
  @Field({ nullable: true }) from?: Date;
  @Field({ nullable: true }) to?: Date;
}

const toEntry = (a: ActivityRow, username?: string | null): ActivityEntry => ({
  id: a.id.toString(),
  at: a.at,
  requestId: a.requestId,
  userId: a.userId ?? undefined,
  username: username ?? undefined,
  role: a.role ?? undefined,
  sessionId: a.sessionId ?? undefined,
  ip: a.ip,
  userAgent: a.userAgent ?? undefined,
  client: a.client ?? undefined,
  opType: a.opType,
  opName: a.opName ?? undefined,
  fields: a.fields ?? undefined,
  variablesJson: a.variables ? JSON.stringify(a.variables) : undefined,
  outcome: a.outcome,
  errorCode: a.errorCode ?? undefined,
  durationMs: a.durationMs ?? undefined,
});
const cursor = (s?: string) => {
  if (!s) return undefined;
  if (!/^\d{1,19}$/.test(s)) throw badInput('Invalid cursor.');
  return BigInt(s);
};
const IP_RE = /^[0-9a-fA-F:.]{2,64}$/;

/**
 * Log access. Only Super Admins can search everyone's logs (and that search is itself logged).
 * Every user can see their own sign-ins and actions with time, IP and device.
 */
@Resolver()
export class LogsResolver {
  constructor(
    private readonly activity: ActivityLogService,
    private readonly maintenance: LogMaintenanceService,
    private readonly dbs: DbService,
  ) {}

  @Roles('SUPER_ADMIN')
  @Query(() => [ActivityEntry], { description: 'Every API request with time, IP, device, user and outcome. Newest first.' })
  async activityLog(
    @Args('filter', { nullable: true }) f: ActivityFilter = {},
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('beforeId', { nullable: true }) beforeId?: string,
  ): Promise<ActivityEntry[]> {
    if (f.ip && !IP_RE.test(f.ip)) throw badInput('Invalid IP address.');
    if (f.outcome && f.outcome !== 'OK' && f.outcome !== 'ERROR') throw badInput('Outcome must be OK or ERROR.');
    await this.activity.flush();
    const rows = await this.activity.search({
      userId: f.userId, ip: f.ip?.trim(), opName: f.opName?.trim() || undefined, outcome: f.outcome as 'OK' | 'ERROR' | undefined,
      opTypes: f.actionsOnly ? ['mutation', 'ws.connect'] : undefined, from: f.from, to: f.to, beforeId: cursor(beforeId), limit: clampLimit(limit, 100, 500),
    });
    return rows.map((r) => toEntry(r.a, r.username));
  }

  @AllowWithoutMfa()
  @Query(() => [ActivityEntry], { description: 'Your own sign-ins and actions with time, IP and device.' })
  async myActivity(@CurrentActor() a: Actor, @Args('limit', { type: () => Int, nullable: true }) limit?: number, @Args('beforeId', { nullable: true }) beforeId?: string) {
    await this.activity.flush();
    return (await this.activity.mine(a.userId, clampLimit(limit, 50, 100), cursor(beforeId))).map((r) => toEntry(r));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [IpAccount], { description: 'Accounts that used this IP in the last N days (shared devices / multi-accounting signal).' })
  async accountsOnIp(@Args('ip') ip: string, @Args('days', { type: () => Int, nullable: true }) days?: number): Promise<IpAccount[]> {
    if (!IP_RE.test(ip)) throw badInput('Invalid IP address.');
    await this.activity.flush();
    const rows = await this.activity.accountsOnIp(ip.trim(), Math.min(Math.max(days ?? 90, 1), 3650));
    return rows.map((r) => ({ userId: r.user_id, username: r.username, role: r.role, requests: r.requests, firstSeen: new Date(r.first_seen), lastSeen: new Date(r.last_seen) }));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [UserIp], { description: 'IP addresses an account has used, and how many other accounts shared each one.' })
  async userIps(@Args('userId', { type: () => ID }) userId: string, @Args('days', { type: () => Int, nullable: true }) days?: number): Promise<UserIp[]> {
    await this.activity.flush();
    const rows = await this.activity.ipsForUser(userId, Math.min(Math.max(days ?? 90, 1), 3650));
    return rows.map((r) => ({ ip: r.ip, requests: r.requests, firstSeen: new Date(r.first_seen), lastSeen: new Date(r.last_seen), otherAccounts: r.other_accounts }));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [LogArchive])
  async logArchives(@Args('limit', { type: () => Int, nullable: true }) limit?: number): Promise<LogArchive[]> {
    const rows = await this.dbs.db.select().from(logArchives).orderBy(desc(logArchives.day), logArchives.kind).limit(clampLimit(limit, 60, 400));
    return rows.map((r) => ({ ...r, lastAuditHash: r.lastAuditHash ?? undefined }));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => ArchiveCheck, { description: 'Re-hash an archive file and compare it with the checksum recorded when it was written.' })
  async verifyLogArchive(@Args('day') day: string, @Args('kind') kind: string): Promise<ArchiveCheck> {
    if (kind !== 'audit' && kind !== 'activity') throw badInput('kind must be audit or activity');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badInput('day must be YYYY-MM-DD');
    const r = await verifyArchive(this.dbs.db, day, kind);
    return { ok: r.ok, reason: 'reason' in r ? r.reason : undefined, rows: 'rows' in r ? r.rows : undefined };
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => String, { description: 'Run archive + retention now (normally runs every 15 minutes). Returns a JSON summary.' })
  async runLogMaintenance() {
    return JSON.stringify(await this.maintenance.run());
  }
}
