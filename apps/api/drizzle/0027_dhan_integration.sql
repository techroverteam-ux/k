CREATE TABLE "dhan_connections" (
	"ticket_hash" char(64) PRIMARY KEY NOT NULL,
	"browser_hash" char(64),
	"actor_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'CREATED' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_state" (
	"name" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dhan_connections" ADD CONSTRAINT "dhan_connections_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;