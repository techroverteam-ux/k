ALTER TABLE "orders" ADD COLUMN "broker_id_at_fill" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "broker_commission_minor" bigint;