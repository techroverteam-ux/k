ALTER TYPE "public"."order_type" ADD VALUE 'STOP_LOSS';--> statement-breakpoint
ALTER TYPE "public"."order_type" ADD VALUE 'TAKE_PROFIT';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "trigger_price_minor" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_source" varchar(20);