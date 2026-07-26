-- Make github_apps project-scoped (one per project, not one per org).
-- Each project can have its own GitHub App instead of sharing the org's app.

ALTER TABLE github_apps ADD COLUMN project_id UUID;

-- Backfill: for each existing org app, create copies for each project in that org.
-- This preserves existing org apps by assigning them to the first project per org.
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
WHERE p.org_id = ga.org_id
ON CONFLICT DO NOTHING;

-- Drop old unique constraint on (org_id) only.
DROP INDEX github_apps_org_uq;

-- Add new unique constraint on (project_id).
CREATE UNIQUE INDEX github_apps_project_uq ON github_apps(project_id);

-- Add NOT NULL constraint after backfill.
ALTER TABLE github_apps ALTER COLUMN project_id SET NOT NULL;

-- Add FK for project_id (cascade delete when project is deleted).
ALTER TABLE github_apps ADD CONSTRAINT github_apps_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Keep org_id for cascading deletes at the org level (already has FK).
