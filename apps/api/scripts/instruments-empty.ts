/** Exit 0 when the instruments table is empty (so docker-start.sh loads them), 1 otherwise. */
import { Pool } from 'pg';
import { databaseUrl } from '../src/db/database-url';
import { dbSsl } from '../src/db/db';

const url = databaseUrl();
const pool = new Pool({ connectionString: url, max: 1, ssl: dbSsl(url, process.env.NODE_ENV) });
pool.query<{ n: number }>('SELECT count(*)::int AS n FROM instruments')
  .then((r) => { process.exitCode = r.rows[0].n === 0 ? 0 : 1; })
  .catch(() => { process.exitCode = 1; })
  .finally(() => pool.end());
