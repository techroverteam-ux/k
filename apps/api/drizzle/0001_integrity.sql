-- Financial and audit integrity guarantees enforced by the database itself,
-- so that a bug or a compromised service account cannot silently rewrite history.

-- 1) Append-only tables: block UPDATE and DELETE.
CREATE OR REPLACE FUNCTION td_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint

-- 2) Every journal must balance to zero and have at least two postings.
--    Deferred to COMMIT so a journal's postings can be inserted one by one inside a transaction.
CREATE OR REPLACE FUNCTION td_check_journal_balanced() RETURNS trigger AS $$
DECLARE
  total numeric;
  n int;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) INTO total, n
    FROM ledger_postings WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced (sum=%)', NEW.journal_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % needs at least two postings', NEW.journal_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION td_check_journal_balanced();
--> statement-breakpoint

-- 3) Postings may only touch accounts with the same mode (SIMULATED vs LIVE) as their journal.
CREATE OR REPLACE FUNCTION td_check_posting_mode() RETURNS trigger AS $$
DECLARE
  jm account_mode;
  am account_mode;
BEGIN
  SELECT mode INTO jm FROM journal_entries WHERE id = NEW.journal_id;
  SELECT mode INTO am FROM ledger_accounts WHERE id = NEW.account_id;
  IF jm IS DISTINCT FROM am THEN
    RAISE EXCEPTION 'posting mode mismatch: journal % vs account %', jm, am
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_postings_mode BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION td_check_posting_mode();
--> statement-breakpoint

-- 4) Value checks.
ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_nonzero CHECK (amount_minor <> 0);
--> statement-breakpoint
ALTER TABLE payment_requests ADD CONSTRAINT payment_amount_positive CHECK (amount_minor > 0);
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_qty_positive CHECK (quantity > 0);
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_limit_price CHECK (
  (type = 'MARKET' AND limit_price_minor IS NULL) OR (type = 'LIMIT' AND limit_price_minor > 0)
);
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_live_venue CHECK (mode = 'LIVE' OR venue = 'SIMULATED');
--> statement-breakpoint
ALTER TABLE instruments ADD CONSTRAINT instruments_tick_positive CHECK (tick_minor > 0 AND lot_size > 0);
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_trader_broker CHECK (role = 'TRADER' OR broker_id IS NULL);
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_no_self_broker CHECK (broker_id IS NULL OR broker_id <> id);
--> statement-breakpoint

-- 5) Only one PENDING proposal per config key at a time.
CREATE UNIQUE INDEX config_one_pending_per_key ON config_versions (key) WHERE status = 'PENDING';
--> statement-breakpoint
-- Only one APPROVED (active) version per key.
CREATE UNIQUE INDEX config_one_active_per_key ON config_versions (key) WHERE status = 'APPROVED';
--> statement-breakpoint

-- 6) Fast balance lookups.
CREATE INDEX ledger_postings_account_amount ON ledger_postings (account_id) INCLUDE (amount_minor);
