import { db, sql, issues, events, projects, environments, releases, issueActivity, traces, spans, issueCounts, replays } from '@geniusdebug/db';
import { and, eq, sql as dsql } from 'drizzle-orm';
import type { ParsedEnvelope, SentryEventPayload, SentryTransactionPayload } from '@geniusdebug/shared';
import { normalizeEvent } from './normalize';
import { computeFingerprint } from './fingerprint';
import { symbolicate } from './symbolicate';
import { buildShortId } from './short-id';
import { evaluateAlerts } from './alerts';
import { countDrop } from './metrics';

/**
 * Route each envelope item by type (FR-WRK-5). Unknown types ignored safely.
 * `shedLowValue` (FR-WRK-4): under queue back-pressure, drop traces/replay
 * before errors — errors are never shed.
 */
interface BlobPointer {
  type: string;
  r2Key: string;
  size: number;
  filename?: string;
}

export async function processEnvelope(
  projectId: string,
  parsed: ParsedEnvelope,
  opts: { shedLowValue?: boolean; blobs?: BlobPointer[] } = {},
): Promise<void> {
  for (const item of parsed.items) {
    const type = item.header.type;
    try {
      if (type === 'event') {
        const payload = JSON.parse(item.payload.toString('utf8')) as SentryEventPayload;
        await processEvent(projectId, payload);
      } else if (type === 'transaction') {
        if (opts.shedLowValue) {
          await countDrop(projectId, 'shed_transaction');
          continue;
        }
        const payload = JSON.parse(item.payload.toString('utf8')) as SentryTransactionPayload;
        await processTransaction(projectId, payload);
      } else if (type === 'replay_event') {
        if (opts.shedLowValue) {
          await countDrop(projectId, 'shed_replay');
          continue;
        }
        const payload = JSON.parse(item.payload.toString('utf8')) as Record<string, unknown>;
        // Blob(s) for this replay were streamed to R2 by ingest (FR-RPL-2).
        const recBlob = (opts.blobs ?? []).find((b) => b.type === 'replay_recording');
        await processReplay(projectId, payload, recBlob);
      } else if (type === 'client_report') {
        // Sentry client report: SDK-side discarded counts → aggregate (FR-ING-6).
        const payload = JSON.parse(item.payload.toString('utf8')) as {
          discarded_events?: { reason: string; category: string; quantity: number }[];
        };
        for (const d of payload.discarded_events ?? []) {
          await countDrop(projectId, `client_${d.reason}`, d.quantity);
        }
      } else if (type === 'session') {
        await countDrop(projectId, 'session', 1);
      }
      // replay_recording blob is streamed to R2 by ingest (pointer only).
    } catch (err) {
      // Never block the pipeline on one poison item (FR-WRK-1). Rethrow only for
      // event items so BullMQ retries/DLQs; tolerate others.
      if (type === 'event') throw err;
      // eslint-disable-next-line no-console
      console.warn(`[worker] tolerated bad ${type} item:`, (err as Error).message);
    }
  }
}

async function ensureEnvironment(projectId: string, name: string): Promise<string> {
  const rows = await db
    .insert(environments)
    .values({ projectId, name })
    .onConflictDoNothing({ target: [environments.projectId, environments.name] })
    .returning({ id: environments.id });
  if (rows[0]) return rows[0].id;
  const found = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.name, name)))
    .limit(1);
  return found[0].id;
}

async function ensureRelease(projectId: string, version?: string): Promise<string | null> {
  if (!version) return null;
  const rows = await db
    .insert(releases)
    .values({ projectId, version })
    .onConflictDoNothing({ target: [releases.projectId, releases.version] })
    .returning({ id: releases.id });
  if (rows[0]) return rows[0].id;
  const found = await db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.projectId, projectId), eq(releases.version, version)))
    .limit(1);
  return found[0]?.id ?? null;
}

async function processEvent(projectId: string, payload: SentryEventPayload): Promise<void> {
  const norm = normalizeEvent(payload);
  const eventId = norm.eventId;
  if (!eventId) return;

  // Idempotency on event_id (FR-WRK-2): if already persisted, do nothing.
  const existing = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
  if (existing.length > 0) return;

  const symbolicated = await symbolicate(norm, projectId);
  const fingerprint = computeFingerprint(symbolicated);

  const proj = await db.select({ platform: projects.platform }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const projectPlatform = proj[0]?.platform ?? 'javascript-nextjs';

  const envId = await ensureEnvironment(projectId, symbolicated.environment);
  const releaseId = await ensureRelease(projectId, symbolicated.release);
  const title = symbolicated.exceptionValue ?? symbolicated.message ?? symbolicated.exceptionType ?? 'Error';
  const seenAt = new Date(symbolicated.timestamp);

  // Upsert Issue by (project, fingerprint) — bump counts, detect regression.
  const { issueId, regressed } = await upsertIssue({
    projectId,
    fingerprint,
    title,
    culprit: symbolicated.culprit ?? null,
    type: symbolicated.exceptionType ?? null,
    level: symbolicated.level,
    projectPlatform,
    eventPlatform: symbolicated.platform,
    seenAt,
    releaseId,
    isNewUser: !!symbolicated.user,
  });

  // Persist the event row (FR-WRK-3 / §3.2 step 5).
  await db.insert(events).values({
    id: eventId,
    issueId,
    projectId,
    environmentId: envId,
    releaseId: releaseId ?? undefined,
    timestamp: seenAt,
    level: symbolicated.level,
    handled: symbolicated.handled,
    transaction: symbolicated.transaction,
    url: symbolicated.url,
    message: symbolicated.message,
    platform: symbolicated.platform,
    exception: {
      type: symbolicated.exceptionType,
      value: symbolicated.exceptionValue,
      frames: symbolicated.frames,
    },
    contexts: symbolicated.contexts as Record<string, unknown>,
    request: symbolicated.request,
    user: symbolicated.user,
    tags: symbolicated.tags,
    breadcrumbs: symbolicated.breadcrumbs,
    sdk: symbolicated.sdk as Record<string, unknown>,
    traceId: symbolicated.traceId,
    spanId: symbolicated.spanId,
  });

  // Ensure a trace row exists so "Open trace waterfall" (FR-TRC-4) resolves even
  // when only an error — no `transaction` item — carried the trace context. A real
  // transaction arriving later still inserts its spans (waterfall reads the spans
  // table, not this row); onConflictDoNothing keeps whichever row landed first.
  if (symbolicated.traceId) {
    await db
      .insert(traces)
      .values({
        traceId: symbolicated.traceId,
        projectId,
        rootTransaction: symbolicated.transaction ?? null,
        startTs: seenAt,
        endTs: seenAt,
        platform: symbolicated.platform,
      })
      .onConflictDoNothing({ target: [traces.traceId] });
  }

  // Time-series bucket (FR-RET-2).
  const bucket = new Date(seenAt);
  bucket.setMinutes(0, 0, 0);
  await db
    .insert(issueCounts)
    .values({ issueId, bucket, count: 1 })
    .onConflictDoUpdate({
      target: [issueCounts.issueId, issueCounts.bucket],
      set: { count: dsql`${issueCounts.count} + 1` },
    });

  if (regressed) {
    await db.insert(issueActivity).values({ issueId, action: 'regressed', payload: { eventId } });
  }

  // Evaluate alerts (new issue / regression), deduped + throttled (FR-ALR).
  await evaluateAlerts({ projectId, issueId, title, isNew: false, regressed });
}

interface UpsertArgs {
  projectId: string;
  fingerprint: string;
  title: string;
  culprit: string | null;
  type: string | null;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  projectPlatform: string;
  eventPlatform: string;
  seenAt: Date;
  releaseId: string | null;
  isNewUser: boolean;
}

async function upsertIssue(a: UpsertArgs): Promise<{ issueId: string; regressed: boolean }> {
  const found = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(eq(issues.projectId, a.projectId), eq(issues.fingerprint, a.fingerprint)))
    .limit(1);

  if (found.length > 0) {
    const regressed = found[0].status === 'resolved';
    await db
      .update(issues)
      .set({
        lastSeen: a.seenAt,
        timesSeen: dsql`${issues.timesSeen} + 1`,
        usersAffected: a.isNewUser ? dsql`${issues.usersAffected} + 1` : dsql`${issues.usersAffected}`,
        status: regressed ? 'unresolved' : undefined,
        isRegressed: regressed ? true : undefined,
      })
      .where(eq(issues.id, found[0].id));
    return { issueId: found[0].id, regressed };
  }

  // New issue — assign a short ID from a per-project sequence.
  const countRows = await db
    .select({ c: dsql<number>`count(*)::int` })
    .from(issues)
    .where(eq(issues.projectId, a.projectId));
  const seq = (countRows[0]?.c ?? 0) + 1;
  const shortId = buildShortId(a.projectPlatform, a.eventPlatform, seq);

  const inserted = await db
    .insert(issues)
    .values({
      projectId: a.projectId,
      shortId,
      fingerprint: a.fingerprint,
      title: a.title,
      culprit: a.culprit,
      type: a.type,
      level: a.level,
      status: 'unresolved',
      firstSeen: a.seenAt,
      lastSeen: a.seenAt,
      timesSeen: 1,
      usersAffected: a.isNewUser ? 1 : 0,
      firstReleaseId: a.releaseId ?? undefined,
    })
    .onConflictDoNothing({ target: [issues.projectId, issues.fingerprint] })
    .returning({ id: issues.id });

  if (inserted[0]) {
    await evaluateAlerts({ projectId: a.projectId, issueId: inserted[0].id, title: a.title, isNew: true, regressed: false });
    return { issueId: inserted[0].id, regressed: false };
  }

  // Lost a race — re-read.
  const again = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, a.projectId), eq(issues.fingerprint, a.fingerprint)))
    .limit(1);
  return { issueId: again[0].id, regressed: false };
}

async function processReplay(
  projectId: string,
  payload: Record<string, unknown>,
  recBlob?: { r2Key: string; size: number },
): Promise<void> {
  // Assemble replay metadata (FR-RPL-3/5); the recording blob lives in R2 (pointer).
  const traceIds = (payload.trace_ids as string[] | undefined) ?? [];
  const traceId = traceIds[0];
  const start = payload.replay_start_timestamp
    ? new Date(Number(payload.replay_start_timestamp) * 1000)
    : new Date();
  const end = payload.timestamp ? new Date(Number(payload.timestamp) * 1000) : new Date();
  const durationMs = Math.max(0, end.getTime() - start.getTime());
  const segmentId = typeof payload.segment_id === 'number' ? payload.segment_id : 0;

  // Link to the issue that shares this trace, if any.
  let issueId: string | undefined;
  if (traceId) {
    const ev = await db.select({ issueId: events.issueId }).from(events).where(eq(events.traceId, traceId)).limit(1);
    issueId = ev[0]?.issueId;
  }

  await db.insert(replays).values({
    projectId,
    issueId,
    traceId,
    user: (payload.user as Record<string, unknown>) ?? undefined,
    startedAt: start,
    durationMs,
    segmentCount: segmentId + 1,
    r2Prefix: recBlob?.r2Key ?? `replays/${projectId}/${payload.replay_id ?? 'unknown'}`,
    size: recBlob?.size ?? 0,
  });
}

async function processTransaction(projectId: string, payload: SentryTransactionPayload): Promise<void> {
  const traceId = payload.contexts?.trace?.trace_id;
  if (!traceId) return;
  const start = payload.start_timestamp ? new Date(payload.start_timestamp * 1000) : new Date();
  const end = typeof payload.timestamp === 'number' ? new Date(payload.timestamp * 1000) : new Date();

  await db
    .insert(traces)
    .values({
      traceId,
      projectId,
      rootTransaction: payload.transaction,
      startTs: start,
      endTs: end,
      platform: payload.platform ?? 'javascript',
    })
    .onConflictDoNothing({ target: [traces.traceId] });

  const spanRows = payload.spans ?? [];
  for (const s of spanRows) {
    await db
      .insert(spans)
      .values({
        id: s.span_id,
        traceId: s.trace_id,
        parentSpanId: s.parent_span_id,
        op: s.op,
        description: s.description,
        startTs: new Date(s.start_timestamp * 1000),
        endTs: new Date(s.timestamp * 1000),
        durationMs: Math.round((s.timestamp - s.start_timestamp) * 1000),
        status: s.status,
      })
      .onConflictDoNothing({ target: [spans.id] });
  }
}
