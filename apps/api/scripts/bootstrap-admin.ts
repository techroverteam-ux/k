/**
 * Create the first Super Admin on a real (production) database, or reset one whose password was lost.
 * Runs on container start when BOOTSTRAP_ADMIN_USERNAME is set (scripts/docker-start.sh). Creates only that one
 * account: no demo brokers, traders or balances. Remove the variables from Render once you have signed in.
 *
 *   BOOTSTRAP_ADMIN_USERNAME   e.g. ashok.admin   (4–40 chars: lowercase letters, digits, _ or .)
 *   BOOTSTRAP_ADMIN_PASSWORD   ≥10 chars, three of: lowercase, uppercase, digits, symbols
 *   BOOTSTRAP_ADMIN_NAME       optional display name
 *   BOOTSTRAP_ADMIN_RESET      "true" to set a new password on an EXISTING Super Admin (also unlocks it and signs it out)
 *   BOOTSTRAP_ADMIN_RESET_MFA  "true" to also remove its authenticator (re-enrol on next sign-in), e.g. a lost phone
 *   BOOTSTRAP_DELETE_OTHER_ACCOUNTS  a label such as 2026-11-03: permanently delete EVERY other account (other Super
 *                              Admins, brokers, traders) and all their data, keeping only this Super Admin. Runs once
 *                              per label (recorded in platform_wipes and the audit log), so a restart never repeats it.
 *
 * The password is never printed or logged. Without RESET an existing account is never changed.
 */
import 'reflect-metadata';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseUrl } from '../src/db/database-url';
import { createPool } from '../src/db/db';
import * as schema from '../src/db/schema';
import { deviceCredentials, otpChallenges, platformWipes, sessions, users } from '../src/db/schema';
import { AuditService } from '../src/audit/audit.service';
import type { DbService } from '../src/db/db';
import { purgeAccounts } from '../src/wipe/wipe.service';
import { PasswordService } from '../src/auth/password.service';
import { USERNAME_RE } from '../src/users/users.service';

async function main() {
  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const displayName = (process.env.BOOTSTRAP_ADMIN_NAME ?? '').trim().slice(0, 80) || 'Super Admin';
  const reset = process.env.BOOTSTRAP_ADMIN_RESET === 'true';
  const resetMfa = process.env.BOOTSTRAP_ADMIN_RESET_MFA === 'true';
  const clearLabel = (process.env.BOOTSTRAP_DELETE_OTHER_ACCOUNTS ?? '').trim().slice(0, 60);
  if (!username) return;
  if (!USERNAME_RE.test(username)) throw new Error('BOOTSTRAP_ADMIN_USERNAME: 4–40 characters, starting with a letter; letters, digits and _ . - @ # only.');
  const pw = new PasswordService();
  try { pw.assertStrong(password, username); } catch (e) { throw new Error(`BOOTSTRAP_ADMIN_PASSWORD: ${(e as Error).message}`); }

  const pool = createPool(databaseUrl(), 1);
  const db = drizzle(pool, { schema });
  try {
    const [existing] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.username, username));
    if (!existing) {
      await db.insert(users).values({ username, displayName, role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash: await pw.hash(password), termsAcceptedAt: new Date(), passwordChangedAt: new Date(), signupSource: 'bootstrap' });
      console.log(`bootstrap-admin: created Super Admin "${username}". Sign in, set up the authenticator app, then remove the BOOTSTRAP_ADMIN_* variables.`);
    } else if (existing.role !== 'SUPER_ADMIN') {
      throw new Error(`bootstrap-admin: "${username}" exists and is not a Super Admin; refusing to change it.`);
    } else if (!reset) {
      console.log(`bootstrap-admin: Super Admin "${username}" already exists; left unchanged (set BOOTSTRAP_ADMIN_RESET=true to reset its password).`);
    } else {
      await db.transaction(async (tx) => {
        await tx.update(users).set({
          passwordHash: await pw.hash(password), passwordChangedAt: new Date(), status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(),
          ...(resetMfa ? { mfaEnabled: false, mfaSecretEnc: null } : {}),
        }).where(eq(users.id, existing.id));
        await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'bootstrap_reset' }).where(and(eq(sessions.userId, existing.id), isNull(sessions.revokedAt)));
        await tx.update(deviceCredentials).set({ revokedAt: new Date(), revokedReason: 'bootstrap_reset' }).where(and(eq(deviceCredentials.userId, existing.id), isNull(deviceCredentials.revokedAt)));
      });
      console.log(`bootstrap-admin: reset password for "${username}"${resetMfa ? ' and removed its authenticator' : ''}; all its devices were signed out. Remove the BOOTSTRAP_ADMIN_* variables now.`);
    }
    if (clearLabel) await deleteOtherAccounts(db, username, clearLabel);
  } finally {
    await pool.end();
  }
}

/** Keep only `keep` (a Super Admin); delete every other account and its data, once per label. */
async function deleteOtherAccounts(db: ReturnType<typeof drizzle<typeof schema>>, keep: string, label: string) {
  const reason = `bootstrap:${label}`;
  const [done] = await db.select({ id: platformWipes.id }).from(platformWipes).where(and(eq(platformWipes.reason, reason), eq(platformWipes.status, 'EXECUTED'))).limit(1);
  if (done) { console.log(`bootstrap-admin: other accounts were already deleted for "${label}"; nothing to do. Remove BOOTSTRAP_DELETE_OTHER_ACCOUNTS.`); return; }
  const audit = new AuditService({} as DbService);
  const counts = await db.transaction(async (tx) => {
    const [admin] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.username, keep));
    if (!admin || admin.role !== 'SUPER_ADMIN') throw new Error(`bootstrap-admin: "${keep}" must be an existing Super Admin.`);
    await tx.execute(sql`SET LOCAL td.platform_wipe = 'on'`);
    const targets = (await tx.select({ id: users.id }).from(users).where(ne(users.id, admin.id))).map((u) => u.id);
    const c = await purgeAccounts(tx, targets, []);
    await tx.delete(otpChallenges);
    await tx.insert(platformWipes).values({ status: 'EXECUTED', requestedById: admin.id, reason, decidedById: admin.id, decidedAt: new Date(), expiresAt: new Date(), summary: c });
    await audit.record(tx, { actor: { userId: admin.id, role: 'SUPER_ADMIN' }, action: 'platform.bootstrap_cleared', entityType: 'platform_wipe', outcome: 'SUCCESS', metadata: { kept: keep, label, ...c } });
    return c;
  });
  console.log(`bootstrap-admin: deleted ${counts.accounts} other account(s) and their data; only "${keep}" is left. Remove BOOTSTRAP_DELETE_OTHER_ACCOUNTS now.`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
