CREATE TABLE "activity_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"user_id" uuid,
	"role" varchar(20),
	"session_id" uuid,
	"ip" varchar(64) NOT NULL,
	"user_agent" varchar(400),
	"client" varchar(20),
	"op_type" varchar(20) NOT NULL,
	"op_name" varchar(120),
	"fields" varchar(400),
	"variables" jsonb,
	"outcome" varchar(10) NOT NULL,
	"error_code" varchar(40),
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "log_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" varchar(10) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"rows" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"location" varchar(500) NOT NULL,
	"first_id" varchar(40),
	"last_id" varchar(40),
	"last_audit_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "user_agent" varchar(400);--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "client_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "user_agent" varchar(400);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "requested_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "requested_user_agent" varchar(400);--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "requested_session_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "reviewed_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
CREATE INDEX "activity_at_idx" ON "activity_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "activity_ip_idx" ON "activity_log" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "activity_op_idx" ON "activity_log" USING btree ("op_name","at");--> statement-breakpoint
CREATE INDEX "activity_request_idx" ON "activity_log" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "log_archives_day_kind_uq" ON "log_archives" USING btree ("day","kind");--> statement-breakpoint
CREATE INDEX "audit_ip_idx" ON "audit_events" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "audit_request_idx" ON "audit_events" USING btree ("request_id");