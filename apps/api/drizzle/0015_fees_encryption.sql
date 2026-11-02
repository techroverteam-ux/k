ALTER TABLE "fee_payments" DROP CONSTRAINT "fee_payments_utr_unique";--> statement-breakpoint
ALTER TABLE "fee_payments" ALTER COLUMN "utr" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payee_accounts" ALTER COLUMN "account_number" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "payee_accounts" ALTER COLUMN "upi_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "utr_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_utr_hash_unique" UNIQUE("utr_hash");