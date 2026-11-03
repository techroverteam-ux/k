ALTER TABLE "platform_wipes" ADD COLUMN "target_user_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_wipes" ADD COLUMN "target_username" varchar(40);--> statement-breakpoint
ALTER TABLE "platform_wipes" ADD COLUMN "target_role" varchar(20);