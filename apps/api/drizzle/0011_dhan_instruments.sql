ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "dhan_security_id" varchar(32);
--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN IF NOT EXISTS "dhan_segment" varchar(20);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instruments_dhan_idx" ON "instruments" ("dhan_segment", "dhan_security_id");

