import { Injectable } from '@nestjs/common';
import { and, eq, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db';
import { users } from '../db/schema';

/**
 * Resource-level authorization. Every query that touches another user's data goes through here.
 *
 *   SUPER_ADMIN → any user
 *   BROKER      → self + traders whose broker_id = broker
 *   TRADER      → self only
 *
 * Denials return NOT_FOUND (not FORBIDDEN) so IDs of other accounts cannot be probed.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  async assertCanAccessUser(actor: Actor, targetUserId: string, ip?: string): Promise<void> {
    if (actor.role === 'SUPER_ADMIN' || actor.userId === targetUserId) return;
    if (actor.role === 'BROKER') {
      const [t] = await this.dbs.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, targetUserId), eq(users.brokerId, actor.userId), eq(users.role, 'TRADER')))
        .limit(1);
      if (t) return;
    }
    await this.audit.recordStandalone({
      actor,
      action: 'authz.denied',
      entityType: 'user',
      entityId: targetUserId,
      outcome: 'DENIED',
      ip,
    });
    throw notFound('Account');
  }

  /** WHERE-clause scope for listing users. */
  userScope(actor: Actor): SQL | undefined {
    if (actor.role === 'SUPER_ADMIN') return undefined;
    if (actor.role === 'BROKER') return eq(users.brokerId, actor.userId);
    return eq(users.id, actor.userId);
  }
}
