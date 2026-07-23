ALTER TABLE "events" ADD COLUMN "replay_id" varchar(64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_replay_idx" ON "events" USING btree ("replay_id");