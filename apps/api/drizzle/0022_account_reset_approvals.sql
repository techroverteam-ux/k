CREATE TABLE "account_reset_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"broker_id" uuid,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"reason" varchar(300) NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_reset_requests" ADD CONSTRAINT "account_reset_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_reset_user_idx" ON "account_reset_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_reset_pending_uq" ON "account_reset_requests" USING btree ("user_id") WHERE "account_reset_requests"."status" = 'PENDING';