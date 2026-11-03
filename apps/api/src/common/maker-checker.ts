import { and, eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import type { DbOrTx } from '../db/db';
import { users } from '../db/schema';

/**
 * Maker-checker: normally the person who asked for something sensitive can't also approve it.
 * Exception (SINGLE_ADMIN_MODE=true): while exactly one Super Admin is active, they may approve their own request.
 * Returns true when this approval may go ahead for the maker themselves.
 */
export async function soleAdminMayApprove(db: DbOrTx): Promise<boolean> {
  if (!env().SINGLE_ADMIN_MODE) return false;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
  return (r?.n ?? 0) <= 1;
}
