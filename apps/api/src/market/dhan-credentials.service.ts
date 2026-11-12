import { AuditService } from '../audit/audit.service';
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { DbService } from '../db/db';
import { dhanConnections, integrationState, users } from '../db/schema';
import { decryptField, encryptField } from '../common/crypto';
import { env } from '../config/env';
import type { Actor } from '../common/context';
import { badInput, forbidden } from '../common/errors';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export function dhanExpiry(value: string) {
  const date = new Date(/[Zz]|[+-]\d\d:\d\d$/.test(value) ? value : value + '+05:30');
  if (!Number.isFinite(date.getTime()) || date <= new Date()) throw badInput('Dhan returned an invalid token expiry.');
  return date;
}
@Injectable()
export class DhanCredentialsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private version = '';
  private listeners: Array<() => void> = [];
  constructor(
    private readonly dbs: DbService,
    @Optional() private readonly audit?: AuditService,
  ) {}
  private fingerprint() {
    return hash((env().DHAN_CLIENT_ID ?? '') + ':' + (env().DHAN_API_KEY ?? ''));
  }
  configured() {
    return !!(env().DHAN_CLIENT_ID && env().DHAN_API_KEY && env().DHAN_API_SECRET && env().DHAN_REDIRECT_URL);
  }
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test' && this.configured())
      this.timer = setInterval(() => {
        if (!this.pending)
          this.pending = this.check()
            .catch(() => undefined)
            .finally(() => {
              this.pending = undefined;
            });
      }, 30000);
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
  private async check() {
    const status = await this.status();
    const v = (status.expiresAt ?? '') + ':' + status.connected;
    if (!this.stopped && v !== this.version) {
      this.version = v;
      for (const fn of this.listeners) fn();
    }
  }
  async token() {
    if (!env().DHAN_API_KEY) return env().DHAN_ACCESS_TOKEN;
    const row = (await this.dbs.db.select().from(integrationState).where(eq(integrationState.name, 'dhan.token')))[0]
      ?.value;
    if (!row || row.fingerprint !== this.fingerprint() || new Date(row.expiresAt) <= new Date()) return undefined;
    return decryptField(row.ciphertext, 'integration.dhan.token');
  }
  async status() {
    const row = (await this.dbs.db.select().from(integrationState).where(eq(integrationState.name, 'dhan.token')))[0]
      ?.value;
    return {
      configured: this.configured(),
      mode: env().DHAN_API_KEY ? 'API_KEY' : 'ACCESS_TOKEN',
      connected: env().DHAN_API_KEY
        ? !!(row && row.fingerprint === this.fingerprint() && new Date(row.expiresAt) > new Date())
        : !!env().DHAN_ACCESS_TOKEN,
      expiresAt: row?.fingerprint === this.fingerprint() ? String(row.expiresAt) : undefined,
    };
  }
  async begin(actor: Actor) {
    if (actor.role !== 'SUPER_ADMIN' || !actor.mfaVerified) throw forbidden();
    if (!this.configured())
      throw badInput('Configure the Dhan client ID, API key, secret and redirect URL on the backend.');
    await this.dbs.db.delete(dhanConnections).where(lt(dhanConnections.expiresAt, new Date(Date.now() - 86400000)));
    const ticket = random();
    await this.dbs.db
      .insert(dhanConnections)
      .values({ ticketHash: hash(ticket), actorId: actor.userId, expiresAt: new Date(Date.now() + 15 * 60000) });
    await this.audit?.recordStandalone({
      actor,
      action: 'dhan.connection_requested',
      outcome: 'SUCCESS',
      entityType: 'integration',
      entityId: 'dhan',
    });
    return new URL(
      '/integrations/dhan/start?ticket=' + encodeURIComponent(ticket),
      env().DHAN_REDIRECT_URL!,
    ).toString();
  }
  private async provider(url: string, method = 'GET') {
    const r = await fetch(url, {
      method,
      headers: { app_id: env().DHAN_API_KEY!, app_secret: env().DHAN_API_SECRET! },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw badInput('Dhan authorization failed. Please reconnect from the integration panel.');
    return (await r.json()) as Record<string, any>;
  }
  async start(ticket: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket ?? '')) throw badInput('Connection link expired.');
    const nonce = random();
    const [request] = await this.dbs.db
      .update(dhanConnections)
      .set({ status: 'STARTED', browserHash: hash(nonce) })
      .where(
        and(
          eq(dhanConnections.ticketHash, hash(ticket)),
          eq(dhanConnections.status, 'CREATED'),
          gt(dhanConnections.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!request) throw badInput('Connection link expired or already used.');
    const consent = await this.provider(
      'https://auth.dhan.co/app/generate-consent?client_id=' + encodeURIComponent(env().DHAN_CLIENT_ID!),
      'POST',
    );
    if (typeof consent.consentAppId !== 'string' || !consent.consentAppId)
      throw badInput('Dhan did not issue a login session.');
    return {
      cookie: ticket + '.' + nonce,
      url: 'https://auth.dhan.co/login/consentApp-login?consentAppId=' + encodeURIComponent(consent.consentAppId),
    };
  }
  async complete(cookie: string, tokenId: string) {
    const [ticket, nonce] = String(cookie ?? '').split('.');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(ticket ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce ?? '') ||
      typeof tokenId !== 'string' ||
      !tokenId ||
      tokenId.length > 2000
    )
      throw badInput('Connection session expired. Start again from the integration panel.');
    const [request] = await this.dbs.db
      .update(dhanConnections)
      .set({ status: 'CONSUMING' })
      .where(
        and(
          eq(dhanConnections.ticketHash, hash(ticket)),
          eq(dhanConnections.browserHash, hash(nonce)),
          eq(dhanConnections.status, 'STARTED'),
          gt(dhanConnections.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!request) throw badInput('Connection session expired or already used.');
    const [admin] = await this.dbs.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, request.actorId), eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
    if (!admin) throw forbidden();
    try {
      const result = await this.provider(
        'https://auth.dhan.co/app/consumeApp-consent?tokenId=' + encodeURIComponent(tokenId),
      );
      if (
        String(result.dhanClientId) !== env().DHAN_CLIENT_ID ||
        typeof result.accessToken !== 'string' ||
        !result.accessToken
      )
        throw badInput('Dhan account did not match the configured client ID.');
      const expiresAt = dhanExpiry(result.expiryTime);
      await this.dbs.serializable(async (tx) => {
        await tx
          .insert(integrationState)
          .values({
            name: 'dhan.token',
            value: {
              ciphertext: encryptField(result.accessToken, 'integration.dhan.token'),
              expiresAt: expiresAt.toISOString(),
              fingerprint: this.fingerprint(),
            },
          })
          .onConflictDoUpdate({
            target: integrationState.name,
            set: {
              value: {
                ciphertext: encryptField(result.accessToken, 'integration.dhan.token'),
                expiresAt: expiresAt.toISOString(),
                fingerprint: this.fingerprint(),
              },
              updatedAt: new Date(),
            },
          });
        await this.audit?.record(tx, {
          action: 'dhan.connected',
          outcome: 'SUCCESS',
          entityType: 'integration',
          entityId: 'dhan',
          metadata: { initiatedBy: request.actorId, expiresAt: expiresAt.toISOString() },
        });
        await tx
          .update(dhanConnections)
          .set({ status: 'COMPLETE' })
          .where(eq(dhanConnections.ticketHash, request.ticketHash));
      });
      this.version = expiresAt.toISOString() + ':true';
      for (const fn of this.listeners) fn();
    } catch (e) {
      await this.dbs.db
        .update(dhanConnections)
        .set({ status: 'FAILED' })
        .where(eq(dhanConnections.ticketHash, request.ticketHash));
      throw e;
    }
  }
}
