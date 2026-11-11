import { Injectable } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DbService, type DbOrTx } from '../db/db';
import { notifications } from '../db/schema';
import type { Actor } from '../common/context';
import { mergeNavigationCounts, notificationDestination } from './navigation';
import { afterWipe } from '../wipe/visibility';

/**
 * In-process pub/sub for GraphQL subscriptions. For multiple API instances, swap for
 * a Redis-backed PubSub (graphql-redis-subscriptions) — the interface is the same.
 */
export const pubsub = new PubSub();
export const TOPIC = {
  quotes: 'QUOTES',
  orderUpdate: (userId: string) => `ORDER_UPDATE:${userId}`,
  notification: (userId: string) => `NOTIFICATION:${userId}`,
  /** Events for one signed-in session (e.g. it was signed out because the account signed in elsewhere). */
  session: (sessionId: string) => `SESSION:${sessionId}`,
};

@Injectable()
export class NotificationsService {
  constructor(private readonly dbs: DbService) {}

  async notify(tx: DbOrTx, userId: string, kind: string, title: string, body: string) {
    const [n] = await tx.insert(notifications).values({ userId, kind, title, body }).returning();
    // publish after commit would be ideal; a lost realtime push is harmless because clients refetch.
    setImmediate(() => void pubsub.publish(TOPIC.notification(userId), { notificationAdded: n }));
    return n;
  }

  list(userId: string, limit: number) {
    return this.dbs.db.select().from(notifications).where(and(eq(notifications.userId, userId), afterWipe(notifications.createdAt, userId))).orderBy(desc(notifications.createdAt)).limit(limit);
  }

  async unreadCount(userId: string) {
    const [r] = await this.dbs.db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), afterWipe(notifications.createdAt, userId)));
    return r.c;
  }

  async navigationCounts(actor: Actor) {
    const uid = actor.userId;
    const updates = await this.dbs.db.select({ kind: notifications.kind, count: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userId, uid), isNull(notifications.readAt), afterWipe(notifications.createdAt, uid))).groupBy(notifications.kind);
    let pending: Record<string, number> = {};
    if (actor.role === 'SUPER_ADMIN') {
      const { rows: [r] } = await this.dbs.db.execute<{ accounts: number; payments: number; fees: number; configuration: number; resets: number }>(sql`
        SELECT ((SELECT count(*)::int FROM users WHERE status = 'PENDING') + (SELECT count(*)::int FROM platform_wipes WHERE status = 'PENDING' AND target_user_id IS NOT NULL AND expires_at > now())) AS accounts,
               (SELECT count(*)::int FROM payment_requests WHERE status = 'REQUESTED') AS payments,
               ((SELECT count(*)::int FROM payee_accounts WHERE status = 'PENDING') + (SELECT count(*)::int FROM fee_payments WHERE status = 'SUBMITTED')) AS fees,
               (SELECT count(*)::int FROM config_versions WHERE status = 'PENDING') AS configuration,
               ((SELECT count(*)::int FROM platform_wipes WHERE status = 'PENDING' AND target_user_id IS NULL AND expires_at > now()) + (SELECT count(*)::int FROM account_reset_requests WHERE status = 'PENDING' AND expires_at > now())) AS resets`);
      pending = { '/admin/users': r.accounts, '/admin/payments': r.payments, '/admin/fees': r.fees, '/admin/config': r.configuration, '/admin/reset': r.resets };
    } else if (actor.role === 'BROKER') {
      const { rows: [r] } = await this.dbs.db.execute<{ traders: number; requests: number }>(sql`
        SELECT (SELECT count(*)::int FROM users WHERE broker_id = ${uid} AND role = 'TRADER' AND status = 'PENDING') AS traders,
               (SELECT count(*)::int FROM payment_requests p JOIN users u ON u.id = p.user_id WHERE u.broker_id = ${uid} AND p.status = 'REQUESTED' AND p.created_at >= coalesce((SELECT data_since FROM users WHERE id = ${uid}), '-infinity'::timestamptz)) + (SELECT count(*)::int FROM account_reset_requests r JOIN users u ON u.id = r.user_id WHERE u.broker_id = ${uid} AND r.status = 'PENDING' AND r.expires_at > now()) AS requests`);
      pending = { '/broker/traders': r.traders, '/broker/requests': r.requests };
    } else {
      const { rows: [r] } = await this.dbs.db.execute<{ orders: number; positions: number; funds: number }>(sql`
        SELECT (SELECT count(*)::int FROM orders o JOIN users u ON u.id = o.user_id WHERE o.user_id = ${uid} AND o.mode = u.mode AND o.status = 'OPEN' AND o.created_at >= coalesce(u.data_since, '-infinity'::timestamptz)) AS orders,
               (SELECT count(*)::int FROM positions p JOIN users u ON u.id = p.user_id WHERE p.user_id = ${uid} AND p.mode = u.mode AND p.net_qty <> 0) AS positions,
               (SELECT count(*)::int FROM payment_requests p JOIN users u ON u.id = p.user_id WHERE p.user_id = ${uid} AND p.status = 'REQUESTED' AND p.created_at >= coalesce(u.data_since, '-infinity'::timestamptz)) AS funds`);
      pending = { '/trader/orders': r.orders, '/trader/positions': r.positions, '/trader/funds': r.funds };
    }
    return mergeNavigationCounts(actor.role, pending, updates);
  }

  /** Opening a section acknowledges its updates, without dismissing pending work. */
  async markNavigationRead(actor: Actor, href: string) {
    const seenAt = new Date();
    const kinds = await this.dbs.db.selectDistinct({ kind: notifications.kind }).from(notifications)
      .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt), afterWipe(notifications.createdAt, actor.userId), lte(notifications.createdAt, seenAt)));
    const matching = kinds.filter((n) => notificationDestination(actor.role, n.kind) === href).map((n) => n.kind);
    if (matching.length) await this.dbs.db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt), inArray(notifications.kind, matching), afterWipe(notifications.createdAt, actor.userId), lte(notifications.createdAt, seenAt)));
    return true;
  }

  async markRead(userId: string, id?: string) {
    await this.dbs.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), id ? eq(notifications.id, id) : undefined));
    return true;
  }
}
