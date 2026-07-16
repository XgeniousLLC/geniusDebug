ALTER TABLE "alert_rules" ADD COLUMN "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_expires" timestamp with time zone;