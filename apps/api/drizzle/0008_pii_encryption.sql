-- OTP rows now store a blind index of the phone, never the number; old rows (plaintext, short-lived) are discarded.
DELETE FROM otp_challenges;--> statement-breakpoint
ALTER TABLE "otp_challenges" ALTER COLUMN "phone" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_hash" char(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_hash" char(64);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_hash_unique" UNIQUE("phone_hash");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_hash_unique" UNIQUE("email_hash");