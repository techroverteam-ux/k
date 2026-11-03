/**
 * Reset the whole database to a single Super Admin, from your own computer.
 *
 *   cd apps/api
 *   npm run db:reset
 *
 * It asks for the database connection string (or uses DATABASE_URL if set), the Super Admin username and password
 * to keep, and for you to type DELETE EVERYTHING. Then, in one transaction:
 *  - that Super Admin is created, or its password is set (Enter keeps the current one); it is unlocked and active;
 *  - every other account (other Super Admins, brokers, traders) is deleted with all its data;
 *  - settings go back to their defaults; bank/UPI details, fee payments, instruments, price history, notifications
 *    and the platform's ledger accounts are deleted.
 * The audit log is kept (it is append-only by design) and records the reset. Nothing is changed unless you confirm.
 * The password is never printed or logged.
 */
import 'reflect-metadata';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { deviceCredentials, platformWipes, sessions, users } from '../src/db/schema';
import { dbSsl } from '../src/db/db';
import { databaseHost } from '../src/db/database-url';
import { PasswordService } from '../src/auth/password.service';
import { USERNAME_RE } from '../src/users/users.service';
import { AuditService } from '../src/audit/audit.service';
import type { DbService } from '../src/db/db';
import { clearPlatformData, purgeAccounts } from '../src/wipe/wipe.service';

const CONFIRM = 'DELETE EVERYTHING';

/** One reader for the whole run; lines are queued so none are lost. While `muted`, typing isn't echoed. */
let muted = false;
const echo = new Writable({ write(chunk, _enc, done) { if (!muted) stdout.write(chunk); done(); } });
const rl = createInterface({ input: stdin, output: echo, terminal: !!stdin.isTTY });
const lines: string[] = [];
const waiting: ((l: string | null) => void)[] = [];
let ended = false;
rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
rl.on('close', () => { ended = true; for (const w of waiting.splice(0)) w(null); });
async function ask(prompt: string, hide = false): Promise<string> {
  stdout.write(prompt);
  muted = hide;
  try {
    const l = lines.length ? lines.shift()! : ended ? null : await new Promise<string | null>((r) => waiting.push(r));
    if (l === null) throw new Error('No answer given; nothing was changed.');
    return l.trim();
  } finally { muted = false; if (hide) stdout.write('\n'); }
}
const hidden = (prompt: string) => ask(prompt, true);

async function main() {
  const url = process.env.DATABASE_URL || (await hidden('Database connection string (from Neon → Connect): '));
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('That is not a postgres:// connection string.');
  const pool = new Pool({ connectionString: url, max: 1, ssl: dbSsl(url, 'production'), application_name: 'tradedesk-reset' });
  const db = drizzle(pool, { schema });
  try {
    const roles = await db.select({ role: users.role, n: sql<number>`count(*)::int` }).from(users).groupBy(users.role);
    console.log(`\nConnected to ${databaseHost(url)}. Accounts now: ${roles.map((r) => `${r.n} ${r.role}`).join(', ') || 'none'}.`);

    const username = (await ask('Super Admin username to keep (e.g. ashok.admin): ')).toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Error('Username: 4–40 characters, starting with a letter; letters, digits and _ . - @ # only.');
    const [existing] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.username, username));
    if (existing && existing.role !== 'SUPER_ADMIN') throw new Error(`"${username}" exists and is a ${existing.role}, not a Super Admin. Pick another username.`);

    const pw = new PasswordService();
    let password = await hidden(existing ? `New password for ${username} (Enter to keep the current one): ` : `Password for ${username}: `);
    if (password || !existing) {
      pw.assertStrong(password, username);
      if ((await hidden('Type the password again: ')) !== password) throw new Error('The passwords don’t match.');
    }
    const resetMfa = existing ? /^y/i.test(await ask('Remove its authenticator so you set it up again at next sign-in? (y/N): ')) : false;

    console.log(`\nThis permanently deletes every account except "${username}" and all trading data, settings, bank/UPI details,`);
    console.log('instruments and price history. Only the audit log is kept.');
    if ((await ask(`Type ${CONFIRM} to continue: `)) !== CONFIRM) { console.log('Nothing was changed.'); return; }

    const hash = password ? await pw.hash(password) : null;
    password = '';
    const audit = new AuditService({} as DbService);
    const counts = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL td.platform_wipe = 'on'`);
      let adminId: string;
      if (!existing) {
        const [u] = await tx.insert(users).values({ username, displayName: 'Super Admin', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash: hash!, termsAcceptedAt: new Date(), passwordChangedAt: new Date(), signupSource: 'reset' }).returning({ id: users.id });
        adminId = u.id;
      } else {
        adminId = existing.id;
        await tx.update(users).set({
          status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(), brokerId: null,
          ...(hash ? { passwordHash: hash, passwordChangedAt: new Date() } : {}),
          ...(resetMfa ? { mfaEnabled: false, mfaSecretEnc: null } : {}),
        }).where(eq(users.id, adminId));
        if (hash || resetMfa) {
          await tx.delete(sessions).where(eq(sessions.userId, adminId));
          await tx.delete(deviceCredentials).where(eq(deviceCredentials.userId, adminId));
        }
      }
      const others = (await tx.select({ id: users.id }).from(users).where(ne(users.id, adminId))).map((u) => u.id);
      const c = { ...(await purgeAccounts(tx, others, [])), ...(await clearPlatformData(tx)) };
      await tx.delete(platformWipes).where(eq(platformWipes.status, 'PENDING'));
      await tx.insert(platformWipes).values({ status: 'EXECUTED', requestedById: adminId, reason: 'reset-database script', decidedById: adminId, decidedAt: new Date(), expiresAt: new Date(), summary: c });
      await audit.record(tx, { actor: { userId: adminId, role: 'SUPER_ADMIN' }, action: 'platform.reset_script', entityType: 'platform_wipe', outcome: 'SUCCESS', metadata: { kept: username, passwordChanged: !!hash, authenticatorRemoved: resetMfa, ...c } });
      return c;
    });
    console.log(`\nDone. Deleted ${counts.accounts} account(s), ${counts.instruments} instrument(s), ${counts.payeeAccounts} bank/UPI detail(s); settings are back to defaults.`);
    console.log(`Only "${username}" can sign in now${existing && !hash ? ' (password unchanged)' : ''}.`);
    console.log('Restart k-api on Render (Manual Deploy → Restart service) so it forgets cached prices and settings.');
    console.log('To trade again, load instruments: npm run instruments:sync-dhan');
  } finally {
    await pool.end();
  }
}

main()
  .catch((e) => { console.error(`\n${(e as Error).message}`); process.exitCode = 1; })
  .finally(() => rl.close());
