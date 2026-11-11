import { Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import { databaseUrl } from './database-url';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** Either the root db handle or a transaction handle. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

/**
 * TLS to the database. In production every connection to a non-local database is encrypted and the server
 * certificate is verified, even if the connection string forgot `sslmode` (Neon and other managed Postgres
 * use publicly trusted certificates). `sslmode=disable` in production is refused.
 */
export function dbSsl(url: string, nodeEnv: string | undefined = env().NODE_ENV): { rejectUnauthorized: true } | undefined {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname) || !u.hostname.includes('.') || u.searchParams.has('host');
  const mode = u.searchParams.get('sslmode');
  if (nodeEnv !== 'production' || local) return undefined;
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') throw new Error(`DATABASE_URL has sslmode=${mode}; production needs an encrypted connection (sslmode=require or verify-full).`);
  return mode ? undefined : { rejectUnauthorized: true };
}

export function createPool(url = databaseUrl({ DATABASE_URL: env().DATABASE_URL, DATABASE_URL_UNPOOLED: env().DATABASE_URL_UNPOOLED }), max = env().DB_POOL_MAX) {
  return new Pool({
    connectionString: url,
    ssl: dbSsl(url),
    max,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: 'tradedesk-api',
  });
}

@Injectable()
export class DbService implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly db: Database;

  constructor() {
    this.pool = createPool();
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Run a financial write in a SERIALIZABLE transaction with automatic retry on
   * serialization failures / deadlocks. Callers must be idempotent (they are: every
   * financial write is keyed by an idempotency key).
   */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, attempts = 5): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.db.transaction(fn, { isolationLevel: 'serializable' });
      } catch (e: any) {
        const code = e?.code ?? e?.cause?.code;
        if (code === '40001' || code === '40P01') {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 10 * 2 ** i + Math.random() * 20));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // Close after all providers have drained their work in onModuleDestroy.
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [DbService], exports: [DbService] })
export class DbModule {}
