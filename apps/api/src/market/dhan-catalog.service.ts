import { AuditService } from '../audit/audit.service';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db';
import { instruments, integrationState } from '../db/schema';
import { env } from '../config/env';
import { defaultLotClass, defaultLotLabel } from '../trading/instrument-meta';
import {
  CatalogInstrument,
  DOMESTIC_MASTER,
  GLOBAL_MASTER,
  readCatalog,
  sameContract,
  supportedTick,
} from './dhan-catalog';

const STOCKS = new Set(
  'ABB ABCAPITAL ADANIENT ADANIGREEN ADANIPORTS AMBUJACEM RELIANCE TCS INFY HDFCBANK SBIN NIFTY BANKNIFTY FINNIFTY KAYNES SAIL ICICIBANK BHARTIARTL ITC KOTAKBANK LT AXISBANK MARUTI SUNPHARMA BAJFINANCE TITAN ASIANPAINT HCLTECH WIPRO NTPC ONGC POWERGRID JSWSTEEL TATASTEEL COALINDIA HINDUNILVR BAJAJFINSV CIPLA BPCL GRASIM HEROMOTOCO TECHM BEL HAL JIOFIN VEDL'.split(
    ' ',
  ),
);
const GLOBAL = new Set('AAPL MSFT NVDA TSLA AMZN GOOGL META SPY QQQ DIA IWM'.split(' '));
const base = (s: string) => /^[A-Z&]+/.exec(s.toUpperCase())?.[0] ?? s;
@Injectable()
export class DhanCatalogService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private lastVerifiedAt = 0;
  private pending?: Promise<any>;
  private startedAt?: string;
  private stopped = false;
  private listeners: Array<() => Promise<void>> = [];
  private readonly log = new Logger('DhanCatalog');
  constructor(
    private readonly dbs: DbService,
    @Optional() private readonly audit?: AuditService,
  ) {}
  async onModuleInit() {
    const previous = await this.savedStatus();
    this.lastVerifiedAt = previous.lastSuccessAt ? new Date(previous.lastSuccessAt).getTime() : 0;
    if (process.env.NODE_ENV !== 'test' && env().MARKET_FEED === 'dhan' && env().DHAN_CATALOG_SYNC === 'on')
      this.timer = setInterval(() => void this.sync().catch(() => undefined), 60 * 60_000);
  }
  onChange(fn: () => Promise<void>) {
    this.listeners.push(fn);
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
  }
  async status() {
    const saved = await this.savedStatus();
    return this.pending ? { ...saved, status: 'SYNCING', startedAt: this.startedAt, error: undefined } : saved;
  }
  private async savedStatus() {
    return (
      (await this.dbs.db.select().from(integrationState).where(eq(integrationState.name, 'dhan.catalog')))[0]
        ?.value ?? { status: 'NOT_SYNCED' }
    );
  }
  isFresh() {
    const age = Date.now() - this.lastVerifiedAt;
    return this.lastVerifiedAt > 0 && age >= 0 && age < 30 * 60 * 60_000;
  }
  async usable() {
    return this.isFresh();
  }
  sync() {
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.pending) return this.pending;
    this.startedAt = new Date().toISOString();
    this.pending = Promise.resolve()
      .then(() => this.perform())
      .finally(() => {
        this.pending = undefined;
        this.startedAt = undefined;
      });
    return this.pending;
  }
  startSync() {
    if (this.stopped) return { status: 'STOPPED' };
    void this.sync().catch(() =>
      this.log.error('Could not save the catalog refresh result. Check database availability.'),
    );
    return { status: 'SYNCING', startedAt: this.startedAt };
  }
  private async perform() {
    try {
      this.log.log('Refreshing official Dhan instrument catalogs.');
      const now = new Date();
      const wanted = (r: CatalogInstrument) =>
        supportedTick(r.tickMinor) &&
        (!r.expiry || r.expiry > now) &&
        (r.dhanSegment === 'INX_EQ'
          ? GLOBAL.has(r.symbol)
          : r.dhanSegment === 'MCX_COMM'
            ? r.segment === 'COMM' && !!r.expiry
            : r.dhanSegment === 'IDX_I'
              ? ['NIFTY', 'BANKNIFTY', 'FINNIFTY'].includes(r.symbol)
              : r.dhanSegment === 'NSE_EQ'
                ? STOCKS.has(r.symbol)
                : r.dhanSegment === 'NSE_FNO'
                  ? (r.segment === 'FUT' && STOCKS.has(base(r.symbol))) ||
                    (r.segment === 'OPT' && ['NIFTY', 'BANKNIFTY', 'FINNIFTY'].includes(base(r.symbol)))
                  : r.dhanSegment === 'NSE_CURRENCY'
                    ? ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'].includes(base(r.symbol))
                    : false);
      const download = async (url: string, global: boolean) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        return readCatalog(r, global, wanted);
      };
      const domestic = await download(DOMESTIC_MASTER, false);
      const global = await download(GLOBAL_MASTER, true);
      const d = domestic.rows,
        g = global.rows;
      if (domestic.count < 1000 || global.count < 100)
        throw Error('Incomplete catalog rejected; previous catalog retained');
      const optionExpiry = new Map<string, number>();
      for (const r of d)
        if (
          r.dhanSegment === 'NSE_FNO' &&
          r.segment === 'OPT' &&
          ['NIFTY', 'BANKNIFTY', 'FINNIFTY'].includes(base(r.symbol)) &&
          r.expiry &&
          r.expiry > now
        )
          optionExpiry.set(base(r.symbol), Math.min(optionExpiry.get(base(r.symbol)) ?? Infinity, r.expiry.getTime()));
      const candidates = [...d, ...g].filter(
        (r) => r.segment !== 'OPT' || r.expiry?.getTime() === optionExpiry.get(base(r.symbol)),
      );
      const previous = await this.savedStatus();
      if (candidates.length > 4500) throw Error('Catalog exceeds the single-feed subscription budget');
      if (previous.supported && candidates.length < Number(previous.supported) * 0.75)
        throw Error('Unexpected catalog shrink rejected');
      if (candidates.length < 20) throw Error('Empty supported catalog rejected');
      const report = await this.dbs.serializable(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('dhan.catalog.sync'))`);
        const existing = await tx.select().from(instruments);
        const pinnedRows = await tx.execute<{ instrument_id: string }>(
          sql`SELECT instrument_id FROM positions WHERE net_qty<>0 UNION SELECT instrument_id FROM orders WHERE status='OPEN'`,
        );
        const pinned = new Set(pinnedRows.rows.map((r) => r.instrument_id));
        const conflicts: string[] = [];
        const seen = new Set<string>();
        let inserted = 0,
          updated = 0,
          retired = 0;
        const changes: Array<typeof instruments.$inferInsert> = [];
        for (const c of candidates) {
          const pair = existing.find(
            (r) => r.dhanSegment === c.dhanSegment && r.dhanSecurityId === c.securityId && sameContract(r, c),
          );
          const match =
            pair ??
            existing.find(
              (r) =>
                r.symbol === c.symbol &&
                sameContract(r, c) &&
                (!r.dhanSecurityId || r.dhanSecurityId === c.securityId || !pinned.has(r.id)),
            );
          const values = {
            name: c.name.slice(0, 120),
            exchange: c.exchange,
            segment: c.segment,
            expiry: c.expiry,
            lotSize: c.lotSize,
            tickMinor: c.tickMinor,
            dhanSegment: c.dhanSegment,
            dhanSecurityId: c.securityId,
            active: true,
          };
          if (match) {
            const same =
              match.name === values.name &&
              match.exchange === values.exchange &&
              match.segment === values.segment &&
              match.expiry?.getTime() === values.expiry?.getTime() &&
              match.lotSize === values.lotSize &&
              match.tickMinor === values.tickMinor &&
              match.active &&
              match.dhanSegment === values.dhanSegment &&
              match.dhanSecurityId === values.dhanSecurityId;
            if (!same) {
              changes.push({
                ...values,
                symbol: match.symbol,
                refPriceMinor: match.refPriceMinor,
                lotClass: match.lotClass,
                lotLabel:
                  match.lotSize === c.lotSize
                    ? match.lotLabel
                    : c.dhanSegment === 'INX_EQ'
                      ? `${c.lotSize} share(s)`
                      : (defaultLotLabel(c.symbol) ?? `${c.lotSize} units`),
              });
            }
            seen.add(match.id);
            if (!same) updated++;
          } else {
            if (existing.some((r) => r.symbol === c.symbol)) {
              conflicts.push(c.symbol);
              continue;
            }
            changes.push({
              ...values,
              symbol: c.symbol.slice(0, 40),
              lotClass: defaultLotClass(c.exchange, c.symbol),
              lotLabel: c.dhanSegment === 'INX_EQ' ? `${c.lotSize} share(s)` : defaultLotLabel(c.symbol),
              refPriceMinor: 0n,
            });
            inserted++;
          }
        }
        for (let i = 0; i < changes.length; i += 250)
          await tx
            .insert(instruments)
            .values(changes.slice(i, i + 250))
            .onConflictDoUpdate({
              target: instruments.symbol,
              set: {
                name: sql`excluded.name`,
                exchange: sql`excluded.exchange`,
                segment: sql`excluded.segment`,
                expiry: sql`excluded.expiry`,
                lotSize: sql`excluded.lot_size`,
                tickMinor: sql`excluded.tick_minor`,
                dhanSegment: sql`excluded.dhan_segment`,
                dhanSecurityId: sql`excluded.dhan_security_id`,
                active: true,
                lotLabel: sql`excluded.lot_label`,
              },
            });
        const retire = existing.filter((r) => r.active && !seen.has(r.id)).map((r) => r.id);
        retired = retire.length;
        for (const r of existing)
          if (retire.includes(r.id) && pinned.has(r.id) && !conflicts.includes(r.symbol)) conflicts.push(r.symbol);
        for (let i = 0; i < retire.length; i += 500)
          await tx
            .update(instruments)
            .set({ active: false })
            .where(inArray(instruments.id, retire.slice(i, i + 500)));
        const result = {
          status: conflicts.length ? 'ATTENTION' : 'HEALTHY',
          conflicts,
          lastSuccessAt: now.toISOString(),
          inserted,
          updated,
          retired,
          supported: candidates.length,
          available: seen.size + inserted,
          precisionNotice:
            'Contracts requiring sub-paise ticks are unavailable until that price precision is supported.',
        };
        await this.audit?.record(tx, {
          action: 'dhan.catalog_synced',
          outcome: 'SUCCESS',
          entityType: 'integration',
          entityId: 'dhan.catalog',
          metadata: result,
        });
        await tx
          .insert(integrationState)
          .values({ name: 'dhan.catalog', value: result })
          .onConflictDoUpdate({ target: integrationState.name, set: { value: result, updatedAt: now } });
        return result;
      });
      this.lastVerifiedAt = now.getTime();
      for (const fn of this.listeners) await fn();
      this.log.log(
        `Dhan catalog refreshed: ${report.available} available, ${report.inserted} inserted, ${report.updated} updated, ${report.retired} retired.`,
      );
      return report;
    } catch (e) {
      this.log.warn(
        `Catalog refresh failed (${(e as any)?.cause?.code ?? (e as Error)?.message?.slice(0, 140)}); keeping the last catalog.`,
      );
      const previous = await this.savedStatus();
      this.lastVerifiedAt = previous.lastSuccessAt ? new Date(previous.lastSuccessAt).getTime() : 0;
      const result = {
        ...previous,
        status: 'ERROR',
        lastAttemptAt: new Date().toISOString(),
        error: 'Catalog refresh failed validation or upstream availability. The last successful catalog is retained.',
      };
      await this.dbs.db
        .insert(integrationState)
        .values({ name: 'dhan.catalog', value: result })
        .onConflictDoUpdate({ target: integrationState.name, set: { value: result, updatedAt: new Date() } });
      return result;
    }
  }
}
