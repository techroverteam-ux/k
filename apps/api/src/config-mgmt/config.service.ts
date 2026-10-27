import { Injectable } from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { badInput, conflict, forbidden, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db';
import { configVersions } from '../db/schema';
import { CONFIG_REGISTRY, isConfigKey, type ConfigKey, type ConfigValue } from './registry';

const CACHE_MS = 5_000;

@Injectable()
export class ConfigService {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Current approved value, or the registry default. Short TTL cache (safe: limits are re-checked in-tx). */
  async get<K extends ConfigKey>(key: K): Promise<ConfigValue<K>> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as ConfigValue<K>;
    const [row] = await this.dbs.db
      .select({ value: configVersions.value })
      .from(configVersions)
      .where(and(eq(configVersions.key, key), eq(configVersions.status, 'APPROVED')))
      .limit(1);
    const parsed = CONFIG_REGISTRY[key].schema.safeParse(row?.value);
    const value = parsed.success ? parsed.data : CONFIG_REGISTRY[key].default;
    this.cache.set(key, { at: Date.now(), value });
    return value as ConfigValue<K>;
  }

  invalidate() {
    this.cache.clear();
  }

  async listAll() {
    const rows = await this.dbs.db.select().from(configVersions).orderBy(desc(configVersions.createdAt));
    return Object.entries(CONFIG_REGISTRY).map(([key, def]) => {
      const active = rows.find((r) => r.key === key && r.status === 'APPROVED');
      const pending = rows.find((r) => r.key === key && r.status === 'PENDING');
      return {
        key,
        description: def.description,
        value: active?.value ?? def.default,
        version: active?.version ?? 0,
        isDefault: !active,
        pending: pending ?? null,
      };
    });
  }

  history(key: string) {
    if (!isConfigKey(key)) throw notFound('Config key');
    return this.dbs.db
      .select()
      .from(configVersions)
      .where(eq(configVersions.key, key))
      .orderBy(desc(configVersions.version))
      .limit(100);
  }

  /** Maker step: propose a new value. Validated against the registry schema. */
  async propose(actor: Actor, key: string, value: unknown, reason: string, ip: string, rollbackOf?: string) {
    if (!isConfigKey(key)) throw badInput('Unknown configuration key.');
    const parsed = CONFIG_REGISTRY[key].schema.safeParse(value);
    if (!parsed.success) throw badInput(`Invalid value: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (reason.trim().length < 5) throw badInput('Please give a reason (min 5 characters).');
    return this.dbs.serializable(async (tx) => {
      const [{ v }] = await tx.select({ v: max(configVersions.version) }).from(configVersions).where(eq(configVersions.key, key));
      const [pending] = await tx
        .select({ id: configVersions.id })
        .from(configVersions)
        .where(and(eq(configVersions.key, key), eq(configVersions.status, 'PENDING')));
      if (pending) throw conflict('There is already a pending change for this key. Approve or reject it first.');
      const [row] = await tx
        .insert(configVersions)
        .values({ key, version: (v ?? 0) + 1, value: parsed.data as object, reason: reason.trim(), makerId: actor.userId, rollbackOf })
        .returning();
      await this.audit.record(tx, {
        actor,
        action: rollbackOf ? 'config.rollback_proposed' : 'config.proposed',
        entityType: 'config',
        entityId: key,
        outcome: 'SUCCESS',
        ip,
        metadata: { version: row.version, value: parsed.data, reason },
      });
      return row;
    });
  }

  /** Checker step: a DIFFERENT super admin approves or rejects. */
  async decide(actor: Actor, id: string, approve: boolean, ip: string) {
    const out = await this.dbs.serializable(async (tx) => {
      const [row] = await tx.select().from(configVersions).where(eq(configVersions.id, id)).for('update');
      if (!row) throw notFound('Change request');
      if (row.status !== 'PENDING') throw conflict('This change has already been decided.');
      if (row.makerId === actor.userId) {
        await this.audit.recordStandalone({ actor, action: 'config.self_approval_blocked', entityType: 'config', entityId: row.key, outcome: 'DENIED', ip });
        throw forbidden('Maker-checker: you cannot approve your own change.');
      }
      if (approve) {
        await tx
          .update(configVersions)
          .set({ status: 'SUPERSEDED' })
          .where(and(eq(configVersions.key, row.key), eq(configVersions.status, 'APPROVED')));
      }
      const [updated] = await tx
        .update(configVersions)
        .set({ status: approve ? 'APPROVED' : 'REJECTED', checkerId: actor.userId, decidedAt: new Date() })
        .where(eq(configVersions.id, id))
        .returning();
      await this.audit.record(tx, {
        actor,
        action: approve ? 'config.approved' : 'config.rejected',
        entityType: 'config',
        entityId: row.key,
        outcome: 'SUCCESS',
        ip,
        metadata: { version: row.version, makerId: row.makerId },
      });
      return updated;
    });
    this.invalidate();
    return out;
  }

  /** Rollback = propose an earlier approved value again (still needs a checker). */
  async proposeRollback(actor: Actor, key: string, toVersion: number, ip: string) {
    if (!isConfigKey(key)) throw badInput('Unknown configuration key.');
    const [old] = await this.dbs.db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.key, key), eq(configVersions.version, toVersion)));
    if (!old || (old.status !== 'SUPERSEDED' && old.status !== 'APPROVED')) throw badInput('Only previously approved versions can be restored.');
    return this.propose(actor, key, old.value, `Rollback to v${toVersion}`, ip, old.id);
  }
}
