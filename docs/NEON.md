# Database on Neon

The repo is linked to Neon project `round-mouse-08140594` (org `org-soft-frog-44073326`), branch `production`.
Link files: `.neon` (ids only, no secrets) and `neon.ts` (branch policy; non-default branches auto-expire after 7 days).

## First-time setup (on your Mac, in the repo root)

```bash
npm i -g neon@latest          # or use: npx neon@latest …
npm install                   # installs @neon/config and @neon/env for neon.ts
neon login                    # opens the browser to sign in
neon deploy                   # provisions neon.ts, writes DATABASE_URL + DATABASE_URL_UNPOOLED to .env.local
cd apps/api
npm run db:migrate            # prints "migrating ep-….neon.tech" (direct host, no -pooler)
npm run db:seed               # demo accounts (dev only)
npm run dev                   # logs "database ep-….neon.tech (direct, DATABASE_URL_UNPOOLED)"
```

`.env.local` is git-ignored. Never commit it or paste its contents anywhere.

## How the API picks the connection

| Variable | From | Used for |
|---|---|---|
| `DATABASE_URL_UNPOOLED` | `neon deploy` / `neon env pull` | **Preferred** for the API, migrations, seed, key rotation and log archiving |
| `DATABASE_URL` | same (pooled, `-pooler` host), or your own Postgres | Fallback when no direct string is set |

The rule lives in `apps/api/src/db/database-url.ts`. The driver stays `node-postgres` (`pg`) with Drizzle. That is the right fit for a long-running NestJS server, and Neon's guidance says to keep an existing driver.

The direct connection is preferred because the API keeps session state that a transaction-mode pooler (PgBouncer) does not preserve:

- per-connection `statement_timeout` and `idle_in_transaction_session_timeout`;
- the session-level advisory lock that keeps log maintenance on one instance.

Migrations need a direct connection anyway. Keep `DB_POOL_MAX` small (5 on the free plan).

The API's npm scripts load `apps/api/.env` first, then `../../.env.local`. The first file that defines a variable wins, and real environment variables override both. So Neon's file supplies the database strings, and `apps/api/.env` keeps the app secrets.

## Render

In the Render service, set `DATABASE_URL` to the **direct** string: run `neon connection-string`, or copy `DATABASE_URL_UNPOOLED` from `.env.local`. Setting `DATABASE_URL_UNPOOLED` instead also works.

## Free-plan notes

- 1 GB storage per project.
- 100 CU-hours a month.
- The compute suspends after 5 idle minutes. The first query after that takes a moment longer.
