import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';

/**
 * After an approved reset, history is hidden only from its owner. Brokers retain trader history,
 * and a broker reset uses that broker's own cutoff. Super Admin sees all.
 * `afterWipe(table.createdAt, table.userId)` keeps only rows at or after that user's users.data_since.
 */
export function afterWipe(at: AnyColumn | SQL, userId: AnyColumn | string): SQL {
  return sql`${at} >= coalesce((select u.data_since from users u where u.id = ${userId}), '-infinity'::timestamptz)`;
}

/** The same, but only for viewers other than Super Admin. */
export function afterWipeFor(actor: Pick<Actor, 'role' | 'userId'>, at: AnyColumn | SQL, userId: AnyColumn | string): SQL | undefined {
  return actor.role === 'SUPER_ADMIN' ? undefined : afterWipe(at, actor.role === 'BROKER' ? actor.userId : userId);
}
