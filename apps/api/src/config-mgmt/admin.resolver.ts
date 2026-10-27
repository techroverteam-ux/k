import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, RequireStepUp, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { AuditEvent, AuditVerification, ConfigItem, ConfigVersion, Notification, ReconciliationRun } from '../common/gql-types';
import { clampLimit } from '../common/mappers';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, pubsub, TOPIC } from '../notifications/notifications.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ConfigService } from './config.service';
import { Subscription, Context } from '@nestjs/graphql';
import { unauthenticated } from '../common/errors';

type CfgRow = Awaited<ReturnType<ConfigService['history']>>[number];
const toVersion = (r: CfgRow): ConfigVersion => ({
  id: r.id,
  key: r.key,
  version: r.version,
  valueJson: JSON.stringify(r.value),
  status: r.status,
  reason: r.reason,
  makerId: r.makerId ?? undefined,
  checkerId: r.checkerId ?? undefined,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt ?? undefined,
});

@Resolver()
export class AdminResolver {
  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly recon: ReconciliationService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------ configuration

  @Roles('SUPER_ADMIN')
  @Query(() => [ConfigItem])
  async configItems(): Promise<ConfigItem[]> {
    const items = await this.config.listAll();
    return items.map((i) => ({ key: i.key, description: i.description, valueJson: JSON.stringify(i.value), version: i.version, isDefault: i.isDefault, pending: i.pending ? toVersion(i.pending) : undefined }));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [ConfigVersion])
  async configHistory(@Args('key') key: string) {
    return (await this.config.history(key)).map(toVersion);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => ConfigVersion, { description: 'Maker: propose a change. Another Super Admin must approve.' })
  async proposeConfigChange(@CurrentActor() a: Actor, @Args('key') key: string, @Args('valueJson') valueJson: string, @Args('reason') reason: string, @Ctx() c: GqlContext) {
    if (valueJson.length > 10_000) throw badInput('Value too large.');
    let value: unknown;
    try {
      value = JSON.parse(valueJson);
    } catch {
      throw badInput('Value must be valid JSON.');
    }
    return toVersion(await this.config.propose(a, key, value, reason, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => ConfigVersion, { description: 'Checker: approve or reject a pending change (not your own).' })
  async decideConfigChange(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('approve') approve: boolean, @Ctx() c: GqlContext) {
    return toVersion(await this.config.decide(a, id, approve, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => ConfigVersion)
  async proposeConfigRollback(@CurrentActor() a: Actor, @Args('key') key: string, @Args('toVersion', { type: () => Int }) v: number, @Ctx() c: GqlContext) {
    return toVersion(await this.config.proposeRollback(a, key, v, c.ip));
  }

  // ------------------------------------------------------------ audit

  @Roles('SUPER_ADMIN')
  @Query(() => [AuditEvent])
  async auditEvents(
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('beforeSeq', { nullable: true }) beforeSeq?: string,
    @Args('action', { nullable: true }) action?: string,
    @Args('actorId', { type: () => ID, nullable: true }) actorId?: string,
    @Args('entityId', { nullable: true }) entityId?: string,
    @Args('requestId', { nullable: true }) requestId?: string,
    @Args('ip', { nullable: true }) ip?: string,
  ): Promise<AuditEvent[]> {
    if (beforeSeq && !/^\d{1,19}$/.test(beforeSeq)) throw badInput('Invalid cursor.');
    const rows = await this.audit.list({ limit: clampLimit(limit), beforeSeq: beforeSeq ? BigInt(beforeSeq) : undefined, action, actorId, entityId, requestId, ip });
    return rows.map((r) => ({
      seq: r.seq.toString(),
      id: r.id,
      actorId: r.actorId ?? undefined,
      actorRole: r.actorRole ?? undefined,
      action: r.action,
      entityType: r.entityType ?? undefined,
      entityId: r.entityId ?? undefined,
      outcome: r.outcome,
      ip: r.ip ?? undefined,
      userAgent: r.userAgent ?? undefined,
      sessionId: r.sessionId ?? undefined,
      requestId: r.requestId ?? undefined,
      metadataJson: r.metadata ? JSON.stringify(r.metadata) : undefined,
      hash: r.hash,
      createdAt: r.createdAt,
    }));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => AuditVerification)
  verifyAuditChain() {
    return this.audit.verifyChain();
  }

  // ------------------------------------------------------------ reconciliation

  @Roles('SUPER_ADMIN')
  @Mutation(() => ReconciliationRun)
  async runReconciliation(@CurrentActor() a: Actor): Promise<ReconciliationRun> {
    const r = await this.recon.run(a);
    return { id: r.id, ok: r.ok, summaryJson: JSON.stringify(r.summary), createdAt: r.createdAt };
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [ReconciliationRun])
  async reconciliationRuns(): Promise<ReconciliationRun[]> {
    return (await this.recon.latest(20)).map((r) => ({ id: r.id, ok: r.ok, summaryJson: JSON.stringify(r.summary), createdAt: r.createdAt }));
  }

  // ------------------------------------------------------------ notifications (any role)

  @Query(() => [Notification], { name: 'notifications' })
  async notifications_(@CurrentActor() a: Actor, @Args('limit', { type: () => Int, nullable: true }) limit?: number) {
    return (await this.notifications.list(a.userId, clampLimit(limit))).map((n) => ({ ...n, readAt: n.readAt ?? undefined }));
  }

  @Query(() => Int)
  unreadNotificationCount(@CurrentActor() a: Actor) {
    return this.notifications.unreadCount(a.userId);
  }

  @Mutation(() => Boolean)
  markNotificationsRead(@CurrentActor() a: Actor, @Args('id', { type: () => ID, nullable: true }) id?: string) {
    return this.notifications.markRead(a.userId, id);
  }

  @Subscription(() => Notification)
  notificationAdded(@Context() c: GqlContext) {
    if (!c.actor) throw unauthenticated();
    return pubsub.asyncIterableIterator(TOPIC.notification(c.actor.userId));
  }
}
