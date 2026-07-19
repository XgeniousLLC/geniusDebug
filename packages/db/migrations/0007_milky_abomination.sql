DROP INDEX IF EXISTS "github_apps_org_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_apps_org_idx" ON "github_apps" USING btree ("org_id");