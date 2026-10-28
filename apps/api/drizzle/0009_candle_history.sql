CREATE TABLE "candles_1d" (
	"instrument_id" uuid NOT NULL,
	"t" timestamp with time zone NOT NULL,
	"o" bigint NOT NULL,
	"h" bigint NOT NULL,
	"l" bigint NOT NULL,
	"c" bigint NOT NULL,
	CONSTRAINT "candles_1d_pk" PRIMARY KEY("instrument_id","t")
);
--> statement-breakpoint
CREATE TABLE "candles_1m" (
	"instrument_id" uuid NOT NULL,
	"t" timestamp with time zone NOT NULL,
	"o" bigint NOT NULL,
	"h" bigint NOT NULL,
	"l" bigint NOT NULL,
	"c" bigint NOT NULL,
	CONSTRAINT "candles_1m_pk" PRIMARY KEY("instrument_id","t")
);
--> statement-breakpoint
ALTER TABLE "candles_1d" ADD CONSTRAINT "candles_1d_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candles_1m" ADD CONSTRAINT "candles_1m_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;