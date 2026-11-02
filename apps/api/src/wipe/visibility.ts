import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';

/**
 * After a "wipe out", a user's earlier history is hidden from them and their broker (Super Admin sees all).
 * `afterWipe(table.createdAt, table.userId)` keeps only rows at or after that user's users.data_since.
 */
export function afterWipe(at: AnyColumn | SQL, userId: AnyColumn | string): SQL {
  return sql`${at} >= coalesce((select u.data_since from users u where u.id = ${userId}), '-infinity'::timestamptz)`;
}

/** The same, but only for viewers other than Super Admin. */
export function afterWipeFor(actor: Pick<Actor, 'role'>, at: AnyColumn | SQL, userId: AnyColumn | string): SQL | undefined {
  return actor.role === 'SUPER_ADMIN' ? undefined : afterWipe(at, userId);
}
