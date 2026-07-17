import { ForbiddenException } from '@nestjs/common';
import { db, projects, projectMembers } from '@geniusdebug/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { AuthPrincipal } from './auth/jwt.guard';

/**
 * Project-level access control (NFR-SEC-6). Admins implicitly see every project
 * in their org; members only see projects granted to them via `project_members`.
 * This is the single choke point every project-scoped read/write funnels through.
 */
export async function accessibleProjectIds(user: AuthPrincipal): Promise<string[]> {
  const all = await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, user.orgId));
  const ids = all.map((r) => r.id);
  if (user.role === 'admin') return ids;
  if (ids.length === 0) return [];
  const grants = await db
    .select({ pid: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, user.userId), inArray(projectMembers.projectId, ids)));
  const granted = new Set(grants.map((g) => g.pid));
  return ids.filter((id) => granted.has(id));
}

/** True if the user may access this specific project (org + grant for members). */
export async function hasProjectAccess(user: AuthPrincipal, projectId: string): Promise<boolean> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, user.orgId)))
    .limit(1);
  if (owned.length === 0) return false;
  if (user.role === 'admin') return true;
  const grant = await db
    .select({ pid: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.userId)))
    .limit(1);
  return grant.length > 0;
}

/** Throws 403 unless the user may access the project. */
export async function assertProjectAccess(user: AuthPrincipal, projectId: string): Promise<void> {
  if (!(await hasProjectAccess(user, projectId))) throw new ForbiddenException('no access to this project');
}
