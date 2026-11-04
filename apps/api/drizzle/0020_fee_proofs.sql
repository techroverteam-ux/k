CREATE TABLE "fee_payment_proofs" (
	"fee_payment_id" uuid PRIMARY KEY NOT NULL,
	"mime" varchar(20) NOT NULL,
	"bytes" integer NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_payment_proofs" ADD CONSTRAINT "fee_payment_proofs_fee_payment_id_fee_payments_id_fk" FOREIGN KEY ("fee_payment_id") REFERENCES "public"."fee_payments"("id") ON DELETE cascade ON UPDATE no action;
