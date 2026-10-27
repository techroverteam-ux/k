/**
 * TradeDesk database schema (Drizzle ORM / PostgreSQL).
 *
 * Rules that this schema encodes:
 *  - Money and prices are BIGINT minor units (paise). Never floats.
 *  - journal_entries, ledger_postings and audit_events are append-only.
 *    UPDATE/DELETE is blocked by triggers (see drizzle/0001_integrity.sql).
 *  - Every journal must balance (sum of postings = 0); enforced by a deferred
 *    constraint trigger as well as by LedgerService.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'bigint' });
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const roleEnum = pgEnum('role', ['SUPER_ADMIN', 'BROKER', 'TRADER']);
export const userStatusEnum = pgEnum('user_status', ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED']);
export const accountModeEnum = pgEnum('account_mode', ['SIMULATED', 'LIVE']);

export const users = pgTable(
  'users',
  {
    id: id(),
    username: varchar('username', { length: 40 }).notNull().unique(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 20 }).unique(),
    email: varchar('email', { length: 254 }).unique(),
    passwordHash: text('password_hash'),
    role: roleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('PENDING'),
    mode: accountModeEnum('mode').notNull().default('SIMULATED'),
    isDemo: boolean('is_demo').notNull().default(false),
    brokerId: uuid('broker_id').references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    termsAcceptedAt: ts('terms_accepted_at'),
    passwordChangedAt: ts('password_changed_at'),
    createdById: uuid('created_by_id'),
    /** 'admin' | 'demo' | 'self_signup' */
    signupSource: varchar('signup_source', { length: 20 }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('users_role_status_idx').on(t.role, t.status), index('users_broker_idx').on(t.brokerId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: char('refresh_token_hash', { length: 64 }).notNull().unique(),
    deviceName: varchar('device_name', { length: 120 }),
    userAgent: varchar('user_agent', { length: 400 }),
    ip: varchar('ip', { length: 64 }),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    rotatedAt: ts('rotated_at'),
    revokedAt: ts('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 64 }),
  },
  (t) => [index('sessions_user_idx').on(t.userId, t.revokedAt), index('sessions_family_idx').on(t.familyId)],
);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    phone: varchar('phone', { length: 20 }).notNull(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    requestIp: varchar('request_ip', { length: 64 }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('otp_phone_idx').on(t.phone, t.purpose, t.createdAt)],
);

// ---------------- Configuration (versioned, maker-checker) ----------------
export const configStatusEnum = pgEnum('config_status', ['PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED']);

export const configVersions = pgTable(
  'config_versions',
  {
    id: id(),
    key: varchar('key', { length: 100 }).notNull(),
    version: integer('version').notNull(),
    value: jsonb('value').notNull(),
    status: configStatusEnum('status').notNull().default('PENDING'),
    reason: varchar('reason', { length: 500 }).notNull(),
    makerId: uuid('maker_id'),
    checkerId: uuid('checker_id'),
    rollbackOf: uuid('rollback_of'),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
  },
  (t) => [uniqueIndex('config_key_version_uq').on(t.key, t.version), index('config_key_status_idx').on(t.key, t.status)],
);

// ---------------- Double-entry ledger ----------------
export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', [
  'TRADER_CASH',
  'FUNDING_SOURCE',
  'SIM_MARKET_PNL',
  'FEE_INCOME',
  'ADJUSTMENT',
]);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    code: varchar('code', { length: 80 }).notNull().unique(),
    type: ledgerAccountTypeEnum('type').notNull(),
    mode: accountModeEnum('mode').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('ledger_accounts_owner_idx').on(t.ownerId, t.type)],
);

export const journalKindEnum = pgEnum('journal_kind', [
  'OPENING_BALANCE',
  'DEPOSIT',
  'WITHDRAWAL',
  'TRADE_PNL',
  'FEE',
  'ADJUSTMENT',
  'REVERSAL',
]);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull().unique(),
    kind: journalKindEnum('kind').notNull(),
    mode: accountModeEnum('mode').notNull(),
    memo: varchar('memo', { length: 300 }).notNull(),
    reversesId: uuid('reverses_id').unique().references((): AnyPgColumn => journalEntries.id),
    createdById: uuid('created_by_id'),
    refType: varchar('ref_type', { length: 40 }),
    refId: uuid('ref_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('journal_ref_idx').on(t.refType, t.refId), index('journal_created_idx').on(t.createdAt)],
);

export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: id(),
    journalId: uuid('journal_id').notNull().references(() => journalEntries.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    /** signed minor units: + increases the account, - decreases it. Sum per journal = 0. */
    amountMinor: money('amount_minor').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('postings_account_idx').on(t.accountId, t.createdAt), index('postings_journal_idx').on(t.journalId)],
);

// ---------------- Payments ----------------
export const paymentTypeEnum = pgEnum('payment_type', ['DEPOSIT', 'WITHDRAWAL']);
export const paymentStatusEnum = pgEnum('payment_status', [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'POSTED',
  'CANCELLED',
  'FAILED',
]);

export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    type: paymentTypeEnum('type').notNull(),
    mode: accountModeEnum('mode').notNull(),
    amountMinor: money('amount_minor').notNull(),
    status: paymentStatusEnum('status').notNull().default('REQUESTED'),
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    requestedById: uuid('requested_by_id').notNull(),
    reviewedById: uuid('reviewed_by_id'),
    reviewNote: varchar('review_note', { length: 500 }),
    journalId: uuid('journal_id').unique().references(() => journalEntries.id),
    externalRef: varchar('external_ref', { length: 120 }),
    requestedIp: varchar('requested_ip', { length: 64 }),
    requestedUserAgent: varchar('requested_user_agent', { length: 400 }),
    requestedSessionId: uuid('requested_session_id'),
    reviewedIp: varchar('reviewed_ip', { length: 64 }),
    reviewedAt: ts('reviewed_at'),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_idem_uq').on(t.requestedById, t.idempotencyKey),
    index('payment_status_idx').on(t.status, t.createdAt),
    index('payment_user_idx').on(t.userId, t.createdAt),
  ],
);

// ---------------- Instruments / watchlists / orders / positions ----------------
export const instruments = pgTable(
  'instruments',
  {
    id: id(),
    symbol: varchar('symbol', { length: 40 }).notNull().unique(),
    name: varchar('name', { length: 120 }).notNull(),
    exchange: varchar('exchange', { length: 10 }).notNull(),
    segment: varchar('segment', { length: 10 }).notNull(),
    expiry: ts('expiry'),
    lotSize: integer('lot_size').notNull().default(1),
    tickMinor: integer('tick_minor').notNull().default(5),
    refPriceMinor: money('ref_price_minor').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('instruments_exchange_idx').on(t.exchange, t.segment)],
);

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    listIndex: integer('list_index').notNull(),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watchlist_uq').on(t.userId, t.listIndex, t.instrumentId)],
);

export const orderSideEnum = pgEnum('order_side', ['BUY', 'SELL']);
export const orderTypeEnum = pgEnum('order_type', ['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT']);
export const orderStatusEnum = pgEnum('order_status', ['OPEN', 'FILLED', 'CANCELLED', 'REJECTED']);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id, { onDelete: 'restrict' }),
    side: orderSideEnum('side').notNull(),
    type: orderTypeEnum('type').notNull(),
    quantity: integer('quantity').notNull(),
    limitPriceMinor: money('limit_price_minor'),
    /** STOP_LOSS / TAKE_PROFIT: the last traded price that triggers the order; it then fills at LTP. */
    triggerPriceMinor: money('trigger_price_minor'),
    triggeredAt: ts('triggered_at'),
    fillPriceMinor: money('fill_price_minor'),
    status: orderStatusEnum('status').notNull(),
    mode: accountModeEnum('mode').notNull(),
    /** "SIMULATED" for paper fills. Never presented as an exchange execution. */
    venue: varchar('venue', { length: 40 }).notNull(),
    rejectReason: varchar('reject_reason', { length: 200 }),
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    placedById: uuid('placed_by_id').notNull(),
    /** Where the order came from (stamped from the request context). */
    clientIp: varchar('client_ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 400 }),
    sessionId: uuid('session_id'),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    filledAt: ts('filled_at'),
  },
  (t) => [
    uniqueIndex('orders_idem_uq').on(t.userId, t.idempotencyKey),
    index('orders_user_status_idx').on(t.userId, t.status, t.createdAt),
    index('orders_open_idx').on(t.status, t.instrumentId),
  ],
);

export const positions = pgTable(
  'positions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id, { onDelete: 'restrict' }),
    mode: accountModeEnum('mode').notNull(),
    netQty: integer('net_qty').notNull().default(0),
    avgPriceMinor: money('avg_price_minor').notNull().default(sql`0`),
    realizedPnlMinor: money('realized_pnl_minor').notNull().default(sql`0`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('positions_uq').on(t.userId, t.instrumentId, t.mode)],
);

// ---------------- Audit / notifications / reconciliation ----------------
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    id: uuid('id').notNull().unique().default(sql`gen_random_uuid()`),
    actorId: uuid('actor_id'),
    actorRole: varchar('actor_role', { length: 20 }),
    action: varchar('action', { length: 80 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }),
    entityId: varchar('entity_id', { length: 80 }),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 400 }),
    sessionId: uuid('session_id'),
    requestId: varchar('request_id', { length: 64 }),
    metadata: jsonb('metadata'),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_actor_idx').on(t.actorId, t.createdAt),
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_action_idx').on(t.action, t.createdAt),
    index('audit_ip_idx').on(t.ip, t.createdAt),
    index('audit_request_idx').on(t.requestId),
  ],
);

/**
 * Activity log: one row per API operation (every query, mutation and subscription connect),
 * with time, IP, device, user, session, outcome and duration. Append-only; rows can only be
 * removed by the retention job via td_purge_activity() after the day has been archived.
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    userId: uuid('user_id'),
    role: varchar('role', { length: 20 }),
    sessionId: uuid('session_id'),
    ip: varchar('ip', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 400 }),
    client: varchar('client', { length: 20 }),
    opType: varchar('op_type', { length: 20 }).notNull(),
    opName: varchar('op_name', { length: 120 }),
    fields: varchar('fields', { length: 400 }),
    variables: jsonb('variables'),
    outcome: varchar('outcome', { length: 10 }).notNull(),
    errorCode: varchar('error_code', { length: 40 }),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    index('activity_at_idx').on(t.at),
    index('activity_user_idx').on(t.userId, t.at),
    index('activity_ip_idx').on(t.ip, t.at),
    index('activity_op_idx').on(t.opName, t.at),
    index('activity_request_idx').on(t.requestId),
  ],
);

/** One row per archived UTC day per log kind, with the checksum of the archive file. */
export const logArchives = pgTable(
  'log_archives',
  {
    id: id(),
    day: varchar('day', { length: 10 }).notNull(), // YYYY-MM-DD (UTC)
    kind: varchar('kind', { length: 20 }).notNull(), // 'audit' | 'activity'
    rows: integer('rows').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    location: varchar('location', { length: 500 }).notNull(),
    firstId: varchar('first_id', { length: 40 }),
    lastId: varchar('last_id', { length: 40 }),
    lastAuditHash: char('last_audit_hash', { length: 64 }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('log_archives_day_kind_uq').on(t.day, t.kind)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 40 }).notNull(),
    title: varchar('title', { length: 140 }).notNull(),
    body: varchar('body', { length: 1000 }).notNull(),
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: id(),
  startedById: uuid('started_by_id'),
  ok: boolean('ok').notNull(),
  summary: jsonb('summary').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type PaymentRow = typeof paymentRequests.$inferSelect;
export type ActivityRow = typeof activityLog.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type AccountMode = (typeof accountModeEnum.enumValues)[number];

/**
 * Trading consent: the rules a trader accepted before trading in a session — with the exact
 * rules text, its SHA-256, time, IP, device and session. Append-only (database trigger).
 */
export const tradingConsents = pgTable(
  'trading_consents',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    termsVersion: char('terms_version', { length: 64 }).notNull(),
    termsText: jsonb('terms_text').notNull(),
    acceptedAt: ts('accepted_at').notNull().defaultNow(),
    ip: varchar('ip', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 400 }),
    client: varchar('client', { length: 20 }),
    requestId: varchar('request_id', { length: 64 }),
  },
  (t) => [
    uniqueIndex('consent_session_version_uq').on(t.sessionId, t.termsVersion),
    index('consent_user_idx').on(t.userId, t.acceptedAt),
    index('consent_at_idx').on(t.acceptedAt),
    index('consent_ip_idx').on(t.ip, t.acceptedAt),
  ],
);
export type ConsentRow = typeof tradingConsents.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
