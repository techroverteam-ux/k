CREATE TYPE "public"."strategy_status" AS ENUM('DRAFT', 'RUNNING', 'STOPPED');--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"instrument_id" uuid NOT NULL,
	"interval" varchar(4) NOT NULL,
	"rules" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "strategy_status" DEFAULT 'DRAFT' NOT NULL,
	"max_daily_loss_minor" bigint NOT NULL,
	"max_orders_per_day" integer DEFAULT 20 NOT NULL,
	"pos_qty" integer DEFAULT 0 NOT NULL,
	"entry_price_minor" bigint,
	"entry_at" timestamp with time zone,
	"last_bar_at" timestamp with time zone,
	"reject_streak" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"started_session_id" uuid,
	"stopped_at" timestamp with time zone,
	"stop_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"message" varchar(300) NOT NULL,
	"order_id" uuid,
	"pnl_minor" bigint
);
--> statement-breakpoint
CREATE TABLE "strategy_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"interval" varchar(4) NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"rules" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"trades" jsonb NOT NULL,
	"equity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "strategy_id" uuid;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_events" ADD CONSTRAINT "strategy_events_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_events" ADD CONSTRAINT "strategy_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runs" ADD CONSTRAINT "strategy_runs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runs" ADD CONSTRAINT "strategy_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategies_user_idx" ON "strategies" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "strategies_status_idx" ON "strategies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "strategy_events_strategy_idx" ON "strategy_events" USING btree ("strategy_id","at");--> statement-breakpoint
CREATE INDEX "strategy_runs_strategy_idx" ON "strategy_runs" USING btree ("strategy_id","created_at");