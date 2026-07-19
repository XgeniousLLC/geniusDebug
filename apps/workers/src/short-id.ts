import { randomBytes } from 'node:crypto';

/**
 * Human-readable Issue short ID: a project prefix + a short random id, e.g.
 * `TASKIP-9F2A1C` (FR-GRP-3, GD-137). Random (not a per-project sequence) so it
 * reads cleanly and doesn't leak issue counts; the `(project_id, short_id)`
 * unique index guards the (astronomically rare) collision — caller retries.
 */
export function buildShortId(projectSlug: string, projectPlatform?: string): string {
  const source = projectSlug || projectPlatform || 'issue';
  const prefix =
    source
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 12) || 'ISSUE';
  const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `${prefix}-${rand}`;
}
