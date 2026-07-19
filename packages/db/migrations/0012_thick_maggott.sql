ALTER TABLE "issues" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_share_token_uq" ON "issues" USING btree ("share_token");