CREATE TABLE "fee_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payee_account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"purpose" varchar(120) NOT NULL,
	"utr" varchar(40) NOT NULL,
	"status" varchar(12) DEFAULT 'SUBMITTED' NOT NULL,
	"review_note" varchar(300),
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_payments_utr_unique" UNIQUE("utr")
);
--> statement-breakpoint
CREATE TABLE "payee_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(8) NOT NULL,
	"label" varchar(80) NOT NULL,
	"account_name" varchar(120) NOT NULL,
	"bank_name" varchar(120),
	"account_number" varchar(20),
	"ifsc" varchar(11),
	"branch" varchar(120),
	"upi_id" varchar(120),
	"status" varchar(12) DEFAULT 'PENDING' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_payee_account_id_payee_accounts_id_fk" FOREIGN KEY ("payee_account_id") REFERENCES "public"."payee_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_payments_user_idx" ON "fee_payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "fee_payments_status_idx" ON "fee_payments" USING btree ("status","created_at");