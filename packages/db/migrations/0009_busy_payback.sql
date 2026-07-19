ALTER TABLE "replays" ADD COLUMN "replay_id" varchar(64);--> statement-breakpoint
ALTER TABLE "replays" ADD COLUMN "segment_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replays_replay_idx" ON "replays" USING btree ("replay_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "replays_replay_segment_uq" ON "replays" USING btree ("replay_id","segment_id");