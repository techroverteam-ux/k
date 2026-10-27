import DataLoader from 'dataloader';
import { inArray } from 'drizzle-orm';
import type { Database } from '../db/db';
import { instruments, users, type InstrumentRow, type UserRow } from '../db/schema';

/** Per-request batching loaders (avoid N+1 queries in nested GraphQL fields). */
export function createLoaders(db: Database) {
  return {
    instrument: new DataLoader<string, InstrumentRow | undefined>(async (ids) => {
      const rows = await db.select().from(instruments).where(inArray(instruments.id, [...ids]));
      const m = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => m.get(id));
    }),
    user: new DataLoader<string, UserRow | undefined>(async (ids) => {
      const rows = await db.select().from(users).where(inArray(users.id, [...ids]));
      const m = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => m.get(id));
    }),
  };
}
export type Loaders = ReturnType<typeof createLoaders>;
