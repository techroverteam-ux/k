/**
 * Which Postgres connection string the API uses.
 *
 * Neon (`neon deploy` / `neon env pull`) provides two:
 *  - DATABASE_URL           pooled (PgBouncer, transaction mode, host contains "-pooler")
 *  - DATABASE_URL_UNPOOLED  direct
 *
 * This API is one long-running Node process with a small pg pool, and it relies on session state:
 * per-connection statement/idle timeouts and a session-level advisory lock for log maintenance.
 * Those need a direct connection, so the direct string wins when it is present. Migrations
 * must use a direct connection too. Without Neon, DATABASE_URL alone keeps working as before.
 */
export function databaseUrl(e: NodeJS.ProcessEnv = process.env): string {
  const url = e.DATABASE_URL_UNPOOLED || e.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_UNPOOLED) is required');
  return url;
}

/** Host only, for start-up logs. Never log the full string: it contains the password. */
export function databaseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}
