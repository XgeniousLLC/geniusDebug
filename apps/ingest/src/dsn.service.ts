import { Injectable } from '@nestjs/common';
import { db, dsnKeys, projects } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';

interface CachedKey {
  projectId: string;
  rateLimit: number;
  ingestEnabled: boolean;
  expires: number;
}

/**
 * DSN public-key auth (FR-ING-1). The lookup is a cheap indexed read cached
 * in-process for a few seconds so the hot path stays fast (NFR-PERF-6).
 * The key is write-only — it cannot read data (NFR-SEC-1).
 */
@Injectable()
export class DsnService {
  private cache = new Map<string, CachedKey>();
  private readonly ttlMs = 5000;

  async resolve(publicKey: string, projectId: string): Promise<CachedKey | null> {
    const hit = this.cache.get(publicKey);
    if (hit && hit.expires > Date.now()) {
      return hit.projectId === projectId ? hit : null;
    }
    const rows = await db
      .select({
        projectId: dsnKeys.projectId,
        rateLimit: dsnKeys.rateLimit,
        ingestEnabled: projects.ingestEnabled,
      })
      .from(dsnKeys)
      .innerJoin(projects, eq(projects.id, dsnKeys.projectId))
      .where(and(eq(dsnKeys.publicKey, publicKey), eq(dsnKeys.isActive, true)))
      .limit(1);
    if (rows.length === 0) return null;
    const entry: CachedKey = { ...rows[0], expires: Date.now() + this.ttlMs };
    this.cache.set(publicKey, entry);
    return entry.projectId === projectId ? entry : null;
  }
}
