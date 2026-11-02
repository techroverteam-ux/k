CREATE TABLE "account_wipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"by_id" uuid NOT NULL,
	"verified_with" varchar(16) NOT NULL,
	"balance_before_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"journal_id" uuid,
	"snapshot" jsonb NOT NULL,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_wipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"requested_ip" varchar(64),
	"reason" varchar(300) NOT NULL,
	"decided_by_id" uuid,
	"decided_ip" varchar(64),
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_wipes" ADD CONSTRAINT "account_wipes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_wipes_user_idx" ON "account_wipes" USING btree ("user_id","created_at");--> statement-breakpoint
-- Approved Super Admin full wipe only: inside that one transaction the app sets `td.platform_wipe = 'on'`
-- (SET LOCAL), which lets DELETE (never UPDATE) remove ledger and consent rows. The audit log stays
-- append-only no matter what, and keeps the record of the wipe itself.
CREATE OR REPLACE FUNCTION td_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME IN ('journal_entries', 'ledger_postings', 'trading_consents')
     AND coalesce(current_setting('td.platform_wipe', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
