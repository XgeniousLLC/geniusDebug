import { db } from './client';
import { integrations } from '../schema';
import { and, eq } from 'drizzle-orm';

/**
 * Fetch the active integration row for a kind ('r2' | 'ses'). Self-hosted is
 * single-org, so `orgId` is optional — when omitted the first active row wins.
 * Returns non-secret `config` plus the still-encrypted `secretEnc`; the caller
 * decrypts with the shared crypto helper (keeps decryption out of the db layer).
 */
export async function getActiveIntegration(
  kind: string,
  orgId?: string,
): Promise<{ orgId: string; config: Record<string, unknown>; secretEnc: string | null } | null> {
  const where = orgId
    ? and(eq(integrations.kind, kind), eq(integrations.isActive, true), eq(integrations.orgId, orgId))
    : and(eq(integrations.kind, kind), eq(integrations.isActive, true));
  const rows = await db
    .select({ orgId: integrations.orgId, config: integrations.config, secretEnc: integrations.secretEnc })
    .from(integrations)
    .where(where)
    .limit(1);
  return rows[0] ?? null;
}
