CREATE TABLE "trading_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"terms_version" char(64) NOT NULL,
	"terms_text" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" varchar(64) NOT NULL,
	"user_agent" varchar(400),
	"client" varchar(20),
	"request_id" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "trading_consents" ADD CONSTRAINT "trading_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_session_version_uq" ON "trading_consents" USING btree ("session_id","terms_version");--> statement-breakpoint
CREATE INDEX "consent_user_idx" ON "trading_consents" USING btree ("user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "consent_at_idx" ON "trading_consents" USING btree ("accepted_at");--> statement-breakpoint
CREATE INDEX "consent_ip_idx" ON "trading_consents" USING btree ("ip","accepted_at");