CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" varchar(120),
	"session_id" uuid,
	"mpin_hash" varchar(200) NOT NULL,
	"bio_key_hash" char(64),
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_credentials_user_idx" ON "device_credentials" USING btree ("user_id","revoked_at");
