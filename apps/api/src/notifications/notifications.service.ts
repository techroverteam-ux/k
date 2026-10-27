import { Injectable } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DbService, type DbOrTx } from '../db/db';
import { notifications } from '../db/schema';

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
    return this.dbs.db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
  }

  async unreadCount(userId: string) {
    const [r] = await this.dbs.db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return r.c;
  }

  async markRead(userId: string, id?: string) {
    await this.dbs.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), id ? eq(notifications.id, id) : undefined));
    return true;
  }
}
