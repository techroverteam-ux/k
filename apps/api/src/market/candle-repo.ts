import type { Pool } from 'pg';
import { MIN, type Bar } from './candles';

/**
 * Postgres storage for candles (tables candles_1m and candles_1d, see db/schema.ts).
 * Raw SQL on the shared pool: bulk upserts with unnest() and an IST-aligned date_bin() for paging,
 * which are awkward to express through the query builder. Prices are paise (bigint).
 */

const CHUNK = 5000;
/** date_bin origin at an IST midnight, so buckets start on the hour / at midnight IST. */
const IST_ORIGIN = '2000-01-01T00:00:00+05:30';

export interface StoredBar extends Bar {
  instrumentId: string;
}

interface Row { instrument_id: string; t: Date; o: string; h: string; l: string; c: string }
const toBar = (r: Row): StoredBar => ({ instrumentId: r.instrument_id, t: r.t.getTime(), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) });

export class CandleRepo {
  constructor(private readonly pool: Pool) {}

  /** Insert or update bars. `table` is fixed by the caller, never user input. */
  async upsert(table: 'candles_1m' | 'candles_1d', bars: StoredBar[]) {
    for (let i = 0; i < bars.length; i += CHUNK) {
      const part = bars.slice(i, i + CHUNK);
      await this.pool.query(
        `INSERT INTO ${table} (instrument_id, t, o, h, l, c)
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[])
         ON CONFLICT (instrument_id, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c`,
        [
          part.map((b) => b.instrumentId),
          part.map((b) => new Date(b.t).toISOString()),
          part.map((b) => String(b.o)),
          part.map((b) => String(b.h)),
          part.map((b) => String(b.l)),
          part.map((b) => String(b.c)),
        ],
      );
    }
  }

  /** All 1-minute bars at or after `since`, for every instrument, oldest first. */
  async minutesSince(since: number): Promise<StoredBar[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT instrument_id, t, o, h, l, c FROM candles_1m WHERE t >= $1 ORDER BY instrument_id, t`,
      [new Date(since).toISOString()],
    );
    return rows.map(toBar);
  }

  /** Every daily bar, oldest first. */
  async daily(): Promise<StoredBar[]> {
    const { rows } = await this.pool.query<Row>(`SELECT instrument_id, t, o, h, l, c FROM candles_1d ORDER BY instrument_id, t`);
    return rows.map(toBar);
  }

  /**
   * Up to `limit` candles of `stepMs` built from stored minutes that start before `before`, oldest first.
   * Reads at most (limit + 1) buckets' worth of minutes through the primary key, then drops the oldest bucket,
   * which may be cut short, unless the start of history was reached.
   */
  async page(instrumentId: string, stepMs: number, before: number, limit: number): Promise<Bar[]> {
    const per = Math.max(1, Math.round(stepMs / MIN));
    const rowsWanted = (limit + 1) * per;
    const { rows } = await this.pool.query<{ b: Date; o: string; h: string; l: string; c: string; k: string }>(
      `WITH m AS (
         SELECT t, o, h, l, c FROM candles_1m
         WHERE instrument_id = $1 AND t < $2
         ORDER BY t DESC
         LIMIT $3
       )
       SELECT date_bin($4::interval, t, $5::timestamptz) AS b,
              (array_agg(o ORDER BY t))[1] AS o, max(h) AS h, min(l) AS l, (array_agg(c ORDER BY t DESC))[1] AS c,
              count(*) AS k
       FROM m GROUP BY b ORDER BY b`,
      [instrumentId, new Date(before).toISOString(), rowsWanted, `${per} minutes`, IST_ORIGIN],
    );
    let bars: Bar[] = rows.map((r) => ({ t: r.b.getTime(), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
    const read = rows.reduce((n, r) => n + Number(r.k), 0);
    if (read >= rowsWanted && bars.length > 1) bars = bars.slice(1); // more history exists: oldest bucket may be partial
    return bars.slice(-limit);
  }

  /** Delete 1-minute bars older than `before`. Daily bars are kept. */
  async pruneMinutes(before: number): Promise<number> {
    const r = await this.pool.query(`DELETE FROM candles_1m WHERE t < $1`, [new Date(before).toISOString()]);
    return r.rowCount ?? 0;
  }
}
