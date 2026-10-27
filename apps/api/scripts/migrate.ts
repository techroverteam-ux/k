import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  await pool.end();
  console.log('migrations applied');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
