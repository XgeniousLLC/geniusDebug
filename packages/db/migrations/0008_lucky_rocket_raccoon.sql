-- Revert to one GitHub App per org. Drop any duplicate rows first (keep the
-- newest per org) so the unique index can be created (FR-GH-1).
DELETE FROM "github_apps" a USING "github_apps" b
  WHERE a."org_id" = b."org_id" AND a."created_at" < b."created_at";--> statement-breakpoint
DROP INDEX IF EXISTS "github_apps_org_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_apps_org_uq" ON "github_apps" USING btree ("org_id");
