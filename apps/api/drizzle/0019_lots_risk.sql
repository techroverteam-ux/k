ALTER TABLE "instruments" ADD COLUMN "lot_class" varchar(5) DEFAULT 'MINI' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "commission_mini_minor" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "commission_mega_minor" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "risk_state" varchar(5) DEFAULT 'OK' NOT NULL;--> statement-breakpoint
UPDATE "instruments" SET "lot_class" = 'MEGA' WHERE "exchange" = 'MCX' AND regexp_replace("symbol", '[0-9]{2}[A-Z]{3}FUT.*$', '') !~ '(M|MINI|MIC|PETAL|GUINEA)$';
