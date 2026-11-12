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
  parseCatalog,
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
  private stopped = false;
  private listeners: Array<() => Promise<void>> = [];
  private readonly log = new Logger('DhanCatalog');
  constructor(
    private readonly dbs: DbService,
    @Optional() private readonly audit?: AuditService,
  ) {}
  onModuleInit() {
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
    this.pending = this.perform().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async perform() {
    try {
      const download = async (url: string) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw Error('Official catalog unavailable');
        return r.text();
      };
      const [domestic, global] = await Promise.all([download(DOMESTIC_MASTER), download(GLOBAL_MASTER)]);
      const d = parseCatalog(domestic),
        g = parseCatalog(global, true);
      if (d.length < 1000 || g.length < 100) throw Error('Incomplete catalog rejected; previous catalog retained');
      const now = new Date();
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
        (r) =>
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
                      (r.segment === 'OPT' && r.expiry?.getTime() === optionExpiry.get(base(r.symbol)))
                    : r.dhanSegment === 'NSE_CURRENCY'
                      ? ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'].includes(base(r.symbol))
                      : false),
      );
      const previous = await this.status();
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
      return report;
    } catch (e) {
      this.log.warn(
        `Catalog refresh failed (${(e as any)?.cause?.code ?? (e as Error)?.message?.slice(0, 140)}); keeping the last catalog.`,
      );
      const previous = await this.status();
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
