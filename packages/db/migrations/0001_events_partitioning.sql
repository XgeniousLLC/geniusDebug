-- Hand-authored: convert `events` to a range-partitioned table by `timestamp`
-- (SRS §7 / NFR-SCALE-3). Postgres cannot ALTER a plain table into a partitioned
-- one, so we drop the freshly-created empty base table and recreate it PARTITIONED,
-- then add monthly partitions + a default catch-all. Indexes are recreated on the
-- parent (they propagate to partitions). Re-apply this after any regenerate.

DROP TABLE IF EXISTS "events" CASCADE;
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"release_id" uuid,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "issue_level" DEFAULT 'error' NOT NULL,
	"handled" boolean DEFAULT true NOT NULL,
	"transaction" text,
	"url" text,
	"message" text,
	"platform" varchar(64) DEFAULT 'javascript' NOT NULL,
	"exception" jsonb,
	"contexts" jsonb,
	"request" jsonb,
	"user" jsonb,
	"tags" jsonb,
	"breadcrumbs" jsonb,
	"sdk" jsonb,
	"trace_id" varchar(64),
	"span_id" varchar(64),
	CONSTRAINT "events_id_timestamp_pk" PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_issue_ts_idx" ON "events" USING btree ("issue_id","timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_project_ts_idx" ON "events" USING btree ("project_id","timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_trace_idx" ON "events" USING btree ("trace_id");
--> statement-breakpoint
-- Monthly partitions covering the current window (extend via a housekeeping job).
CREATE TABLE IF NOT EXISTS "events_2026_06" PARTITION OF "events"
	FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_2026_07" PARTITION OF "events"
	FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events_2026_08" PARTITION OF "events"
	FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
--> statement-breakpoint
-- Default catch-all so an event outside known ranges is never rejected (FR-WRK-1).
CREATE TABLE IF NOT EXISTS "events_default" PARTITION OF "events" DEFAULT;