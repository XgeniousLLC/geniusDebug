-- Make github_apps project-scoped (one per project, not one per org).
-- Each project can have its own GitHub App instead of sharing the org's app.

ALTER TABLE github_apps ADD COLUMN IF NOT EXISTS project_id UUID;

-- Drop old unique constraint on (org_id) BEFORE backfilling — otherwise it still
-- allows only one row per org_id, so every backfill insert below (one row per
-- project, same org_id) conflicts against the still-present original row and
-- ON CONFLICT DO NOTHING silently skips ALL of them.
DROP INDEX IF EXISTS github_apps_org_uq;

-- Backfill: for each existing org app, create copies for each project in that org.
-- This preserves existing org apps by assigning them to the first project per org.
-- Guarded on ga.project_id IS NULL so a re-run (e.g. after a partial prior
-- failure) never re-copies rows that are already project-scoped.
INSERT INTO github_apps (id, project_id, org_id, name, slug, app_id, client_id, client_secret_enc, private_key_enc, webhook_secret_enc, owner_login, created_at)
SELECT
  gen_random_uuid(),
  p.id,
  ga.org_id,
  ga.name,
  ga.slug,
  ga.app_id,
  ga.client_id,
  ga.client_secret_enc,
  ga.private_key_enc,
  ga.webhook_secret_enc,
  ga.owner_login,
  NOW()
FROM github_apps ga
CROSS JOIN projects p
WHERE p.org_id = ga.org_id AND ga.project_id IS NULL
ON CONFLICT DO NOTHING;

-- Drop the original org-scoped rows now that each project has its own copy —
-- otherwise they're left behind with project_id still NULL and the NOT NULL
-- constraint below fails on any org that had a pre-existing app.
DELETE FROM github_apps WHERE project_id IS NULL;

-- Add new unique constraint on (project_id).
CREATE UNIQUE INDEX IF NOT EXISTS github_apps_project_uq ON github_apps(project_id);

-- Add NOT NULL constraint after backfill.
ALTER TABLE github_apps ALTER COLUMN project_id SET NOT NULL;

-- Add FK for project_id (cascade delete when project is deleted).
DO $$ BEGIN
  ALTER TABLE github_apps ADD CONSTRAINT github_apps_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Keep org_id for cascading deletes at the org level (already has FK).
