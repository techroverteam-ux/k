import { Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db';
import { reconciliationRuns } from '../db/schema';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  sample?: unknown[];
}

/**
 * Independent consistency checks over the books. Run on a schedule (cron / worker) and on demand.
 * Any failure should page the on-call and freeze payouts until explained.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  async run(actor?: Actor) {
    const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await this.dbs.db.execute<T>(s)).rows;
    const checks: Check[] = [];

    const unbalanced = await q(sql`SELECT journal_id::text, SUM(amount_minor)::text AS sum FROM ledger_postings GROUP BY journal_id HAVING SUM(amount_minor) <> 0 LIMIT 20`);
    checks.push({ name: 'journals_balanced', ok: unbalanced.length === 0, detail: `${unbalanced.length} unbalanced journals`, sample: unbalanced });

    const modeTotals = await q<{ mode: string; total: string }>(
      sql`SELECT a.mode::text, SUM(p.amount_minor)::text AS total FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id GROUP BY a.mode`,
    );
    const nonzero = modeTotals.filter((r) => r.total !== '0');
    checks.push({ name: 'trial_balance_zero', ok: nonzero.length === 0, detail: modeTotals.map((r) => `${r.mode}=${r.total}`).join(', ') || 'no postings' });

    const badPayments = await q(sql`
      SELECT pr.id::text, pr.status::text, pr.amount_minor::text,
             (SELECT SUM(ABS(p.amount_minor))/2 FROM ledger_postings p WHERE p.journal_id = pr.journal_id)::text AS posted
        FROM payment_requests pr
       WHERE (pr.status = 'POSTED' AND (pr.journal_id IS NULL OR
              (SELECT SUM(ABS(p.amount_minor))/2 FROM ledger_postings p WHERE p.journal_id = pr.journal_id) <> pr.amount_minor))
          OR (pr.status <> 'POSTED' AND pr.journal_id IS NOT NULL)
       LIMIT 20`);
    checks.push({ name: 'payments_match_ledger', ok: badPayments.length === 0, detail: `${badPayments.length} payment/ledger mismatches`, sample: badPayments });

    const pnlMismatch = await q(sql`
      WITH pos AS (SELECT user_id, SUM(realized_pnl_minor) AS pnl FROM positions WHERE mode = 'SIMULATED' GROUP BY user_id),
           led AS (SELECT a.owner_id AS user_id, SUM(p.amount_minor) AS pnl
                     FROM ledger_postings p JOIN journal_entries j ON j.id = p.journal_id AND j.kind = 'TRADE_PNL'
                     JOIN ledger_accounts a ON a.id = p.account_id AND a.type = 'TRADER_CASH' AND a.mode = 'SIMULATED'
                    GROUP BY a.owner_id)
      SELECT COALESCE(pos.user_id, led.user_id)::text AS user_id, COALESCE(pos.pnl,0)::text AS positions, COALESCE(led.pnl,0)::text AS ledger
        FROM pos FULL OUTER JOIN led ON led.user_id = pos.user_id
       WHERE COALESCE(pos.pnl,0) <> COALESCE(led.pnl,0) LIMIT 20`);
    checks.push({ name: 'positions_pnl_match_ledger', ok: pnlMismatch.length === 0, detail: `${pnlMismatch.length} users with P&L drift`, sample: pnlMismatch });

    const filledNoFee = await q(sql`
      SELECT o.id::text FROM orders o
       WHERE o.status = 'FILLED' AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.idempotency_key = 'fee:' || o.id::text)
       LIMIT 20`);
    checks.push({ name: 'filled_orders_have_fees', ok: filledNoFee.length === 0, detail: `${filledNoFee.length} filled orders without a fee posting (ok only if brokerage is 0)`, sample: filledNoFee });

    const negative = await q(sql`
      SELECT a.owner_id::text, SUM(p.amount_minor)::text AS balance
        FROM ledger_accounts a JOIN ledger_postings p ON p.account_id = a.id
       WHERE a.type = 'TRADER_CASH' GROUP BY a.owner_id HAVING SUM(p.amount_minor) < 0 LIMIT 20`);
    checks.push({ name: 'no_negative_cash', ok: negative.length === 0, detail: `${negative.length} accounts below zero`, sample: negative });

    const chain = await this.audit.verifyChain();
    checks.push({ name: 'audit_chain_intact', ok: chain.ok, detail: chain.ok ? `${chain.checked} events verified` : `broken at seq ${chain.brokenAtSeq}` });

    const ok = checks.every((c) => c.ok || c.name === 'filled_orders_have_fees');
    const [run] = await this.dbs.db.insert(reconciliationRuns).values({ ok, summary: { checks } as object, startedById: actor?.userId }).returning();
    await this.audit.recordStandalone({ actor, action: 'recon.run', entityType: 'reconciliation', entityId: run.id, outcome: ok ? 'SUCCESS' : 'FAILURE' });
    return run;
  }

  latest(limit = 10) {
    return this.dbs.db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.createdAt)).limit(limit);
  }
}
