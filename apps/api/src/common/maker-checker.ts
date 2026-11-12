import type { DbOrTx } from '../db/db';

/** Compatibility helper: administrative actions no longer require a second administrator.
 * Role guards and service authorization still apply. */
export async function soleAdminMayApprove(_db: DbOrTx): Promise<boolean> {
  return true;
}
