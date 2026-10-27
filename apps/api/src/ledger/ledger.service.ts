import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { badInput, conflict, notFound } from '../common/errors';
import { DbService, type DbOrTx, type Tx } from '../db/db';
import {
  journalEntries,
  ledgerAccounts,
  ledgerPostings,
  type AccountMode,
} from '../db/schema';

type JournalKind = (typeof journalEntries.$inferInsert)['kind'];
type SystemAccountType = 'FUNDING_SOURCE' | 'SIM_MARKET_PNL' | 'FEE_INCOME' | 'ADJUSTMENT';

export interface PostingInput {
  accountId: string;
  amountMinor: bigint;
}

export interface JournalInput {
  idempotencyKey: string;
  kind: JournalKind;
  mode: AccountMode;
  memo: string;
  postings: PostingInput[];
  createdById?: string;
  refType?: string;
  refId?: string;
  reversesId?: string;
}

/**
 * Double-entry ledger. Posted entries are immutable; corrections are compensating entries.
 * Invariants (also enforced by DB triggers):
 *   - sum(postings) = 0 per journal, ≥ 2 postings, no zero postings
 *   - idempotency key unique → retries never double-post
 *   - journal mode = account mode (SIMULATED and LIVE money never mix)
 */
@Injectable()
export class LedgerService {
  constructor(private readonly dbs: DbService) {}

  async cashAccount(tx: DbOrTx, userId: string, mode: AccountMode): Promise<string> {
    const code = `cash:${mode}:${userId}`;
    await tx
      .insert(ledgerAccounts)
      .values({ code, type: 'TRADER_CASH', mode, ownerId: userId })
      .onConflictDoNothing({ target: ledgerAccounts.code });
    const [a] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
    return a.id;
  }

  async systemAccount(tx: DbOrTx, type: SystemAccountType, mode: AccountMode): Promise<string> {
    const code = `sys:${type}:${mode}`;
    await tx.insert(ledgerAccounts).values({ code, type, mode }).onConflictDoNothing({ target: ledgerAccounts.code });
    const [a] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
    return a.id;
  }

  /** Row-lock an account so concurrent debits are serialized (prevents overdraft races). */
  async lock(tx: Tx, accountId: string): Promise<void> {
    await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(eq(ledgerAccounts.id, accountId)).for('update');
  }

  async balance(tx: DbOrTx, accountId: string): Promise<bigint> {
    const [r] = await tx
      .select({ s: sql<string>`COALESCE(SUM(${ledgerPostings.amountMinor}), 0)::text` })
      .from(ledgerPostings)
      .where(eq(ledgerPostings.accountId, accountId));
    return BigInt(r.s);
  }

  /** Post a balanced journal. Returns the existing journal if the idempotency key was already used. */
  async post(tx: Tx, j: JournalInput): Promise<{ id: string; replayed: boolean }> {
    if (!j.idempotencyKey || j.idempotencyKey.length > 160) throw badInput('Invalid idempotency key.');
    if (j.postings.length < 2) throw badInput('A journal needs at least two postings.');
    let sum = 0n;
    for (const p of j.postings) {
      if (p.amountMinor === 0n) throw badInput('Zero-amount posting.');
      sum += p.amountMinor;
    }
    if (sum !== 0n) throw badInput('Unbalanced journal.');

    const [existing] = await tx
      .select({ id: journalEntries.id, kind: journalEntries.kind })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, j.idempotencyKey));
    if (existing) {
      if (existing.kind !== j.kind) throw conflict('Idempotency key reused for a different operation.');
      return { id: existing.id, replayed: true };
    }

    const [je] = await tx
      .insert(journalEntries)
      .values({
        idempotencyKey: j.idempotencyKey,
        kind: j.kind,
        mode: j.mode,
        memo: j.memo.slice(0, 300),
        createdById: j.createdById,
        refType: j.refType,
        refId: j.refId,
        reversesId: j.reversesId,
      })
      .returning({ id: journalEntries.id });
    await tx.insert(ledgerPostings).values(j.postings.map((p) => ({ journalId: je.id, accountId: p.accountId, amountMinor: p.amountMinor })));
    return { id: je.id, replayed: false };
  }

  /** Compensating entry that exactly negates a posted journal. Can only be done once per journal. */
  async reverse(tx: Tx, journalId: string, actorId: string, reason: string) {
    const [je] = await tx.select().from(journalEntries).where(eq(journalEntries.id, journalId));
    if (!je) throw notFound('Journal');
    if (je.kind === 'REVERSAL') throw badInput('A reversal cannot itself be reversed; post a new adjustment.');
    const ps = await tx.select().from(ledgerPostings).where(eq(ledgerPostings.journalId, journalId));
    return this.post(tx, {
      idempotencyKey: `reversal:${journalId}`,
      kind: 'REVERSAL',
      mode: je.mode,
      memo: `Reversal of ${je.kind}: ${reason}`,
      postings: ps.map((p) => ({ accountId: p.accountId, amountMinor: -p.amountMinor })),
      createdById: actorId,
      reversesId: journalId,
      refType: je.refType ?? undefined,
      refId: je.refId ?? undefined,
    });
  }

  async history(accountId: string, limit: number, before?: Date) {
    return this.dbs.db
      .select({
        postingId: ledgerPostings.id,
        journalId: journalEntries.id,
        kind: journalEntries.kind,
        memo: journalEntries.memo,
        amountMinor: ledgerPostings.amountMinor,
        createdAt: ledgerPostings.createdAt,
        refType: journalEntries.refType,
        refId: journalEntries.refId,
      })
      .from(ledgerPostings)
      .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
      .where(and(eq(ledgerPostings.accountId, accountId), before ? lt(ledgerPostings.createdAt, before) : undefined))
      .orderBy(desc(ledgerPostings.createdAt), desc(ledgerPostings.id))
      .limit(limit);
  }
}
