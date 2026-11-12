import { Injectable } from '@nestjs/common';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { blindIndex, decryptField, encryptField } from '../common/crypto';
import { badInput, conflict, notFound } from '../common/errors';
import { formatMoney } from '../common/money';
import { DbService, type Tx } from '../db/db';
import { payeeAccounts, paymentEvidence } from '../db/schema';
import { openPayee, parseProof, UTR_RE } from '../fees/fees.service';
import { PolicyService } from '../policy/policy.service';
import { afterWipeFor } from '../wipe/visibility';
import { PaymentEvidenceInput } from './payment-evidence.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class PaymentEvidenceService {
  constructor(
    private readonly dbs: DbService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  async record(
    tx: Tx,
    actor: Actor,
    userId: string,
    amountMinor: bigint,
    input: PaymentEvidenceInput,
    paymentRequestId?: string,
  ) {
    const utr = input.utr.trim().toUpperCase(),
      payerName = input.payerName.trim();
    const paidAt = new Date(input.paidAt);
    if (!UTR_RE.test(utr)) throw badInput('Enter the UTR / payment reference (6–30 letters and digits).');
    if (payerName.length < 2 || payerName.length > 120) throw badInput('Enter the payer name (2–120 characters).');
    if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000)
      throw badInput('Enter a valid payment date that is not in the future.');
    const proof = input.proof ? parseProof(input.proof) : undefined;
    const [payee] = await tx
      .select({ id: payeeAccounts.id })
      .from(payeeAccounts)
      .where(and(eq(payeeAccounts.id, input.payeeAccountId), eq(payeeAccounts.status, 'ACTIVE')))
      .for('share');
    if (!payee) throw badInput('Choose an active Super Admin receiving account.');
    const utrHash = blindIndex(utr, 'utr');
    if (
      (await tx.select({ id: paymentEvidence.id }).from(paymentEvidence).where(eq(paymentEvidence.utrHash, utrHash)))
        .length
    )
      throw conflict('This payment reference was already submitted. Each payment can be used only once.');
    try {
      const [row] = await tx
        .insert(paymentEvidence)
        .values({
          userId,
          amountMinor,
          purpose: paymentRequestId ? 'DEPOSIT' : 'OPENING',
          paymentRequestId,
          payeeAccountId: payee.id,
          submittedById: actor.userId,
          utr: encryptField(utr, 'payment_evidence.utr'),
          utrHash,
          payerName: encryptField(payerName, 'payment_evidence.payer_name'),
          paidAt,
          proofMime: proof?.mime,
          proofData: proof ? encryptField(proof.base64, 'payment_evidence.proof') : undefined,
        })
        .returning({ id: paymentEvidence.id });
      return row;
    } catch (e) {
      if (((e as any)?.cause?.code ?? (e as any)?.code) === '23505')
        throw conflict('This payment reference was already submitted.');
      throw e;
    }
  }

  async assertReplay(tx: Tx, paymentRequestId: string, input?: PaymentEvidenceInput) {
    const [stored] = await tx
      .select({ utrHash: paymentEvidence.utrHash, payeeId: paymentEvidence.payeeAccountId })
      .from(paymentEvidence)
      .where(eq(paymentEvidence.paymentRequestId, paymentRequestId));
    if (
      !!stored !== !!input ||
      (stored &&
        input &&
        (stored.payeeId !== input.payeeAccountId ||
          stored.utrHash !== blindIndex(input.utr.trim().toUpperCase(), 'utr')))
    )
      throw conflict('Idempotency key reused with different payment details.');
  }

  async opening(actor: Actor, userId: string) {
    await this.policy.assertCanAccessUser(actor, userId);
    return (
      (
        await this.rows(
          and(
            eq(paymentEvidence.userId, userId),
            eq(paymentEvidence.purpose, 'OPENING'),
            afterWipeFor(actor, paymentEvidence.createdAt, paymentEvidence.userId),
          ),
        )
      )[0] ?? null
    );
  }

  /** Call only with request IDs already scoped by PaymentsService.list. */
  async forRequests(ids: string[]) {
    return ids.length ? this.rows(inArray(paymentEvidence.paymentRequestId, ids)) : [];
  }

  private async rows(where: SQL | undefined) {
    const rows = await this.dbs.db
      .select({
        id: paymentEvidence.id,
        userId: paymentEvidence.userId,
        paymentRequestId: paymentEvidence.paymentRequestId,
        payeeAccountId: paymentEvidence.payeeAccountId,
        amountMinor: paymentEvidence.amountMinor,
        utr: paymentEvidence.utr,
        payerName: paymentEvidence.payerName,
        paidAt: paymentEvidence.paidAt,
        hasProof: paymentEvidence.proofMime,
        createdAt: paymentEvidence.createdAt,
        payee: payeeAccounts,
      })
      .from(paymentEvidence)
      .innerJoin(payeeAccounts, eq(payeeAccounts.id, paymentEvidence.payeeAccountId))
      .where(where);
    return rows.map((r) => {
      const p = openPayee(r.payee);
      return {
        id: r.id,
        userId: r.userId,
        paymentRequestId: r.paymentRequestId ?? undefined,
        payeeAccountId: r.payeeAccountId,
        payee: p.label,
        accountName: p.accountName,
        bankName: p.bankName ?? undefined,
        accountNumber: p.accountNumber ?? undefined,
        ifsc: p.ifsc ?? undefined,
        branch: p.branch ?? undefined,
        upiId: p.upiId ?? undefined,
        amount: formatMoney(r.amountMinor),
        utr: decryptField(r.utr, 'payment_evidence.utr'),
        payerName: decryptField(r.payerName, 'payment_evidence.payer_name'),
        paidAt: r.paidAt,
        hasProof: !!r.hasProof,
        createdAt: r.createdAt,
      };
    });
  }

  async proof(actor: Actor, id: string, ip: string) {
    const [row] = await this.dbs.db
      .select()
      .from(paymentEvidence)
      .where(and(eq(paymentEvidence.id, id), afterWipeFor(actor, paymentEvidence.createdAt, paymentEvidence.userId)));
    if (!row?.proofMime || !row.proofData) throw notFound('Payment screenshot');
    await this.policy.assertCanAccessUser(actor, row.userId);
    if (actor.role === 'SUPER_ADMIN')
      await this.audit.recordStandalone({
        actor,
        action: 'payment.proof_viewed',
        entityType: 'payment_evidence',
        entityId: id,
        outcome: 'SUCCESS',
        ip,
      });
    return `data:${row.proofMime};base64,${decryptField(row.proofData, 'payment_evidence.proof')}`;
  }
}
