import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { db, sql, organizations, projects, dsnKeys, issues, events } from '@geniusdebug/db';
import { eq } from 'drizzle-orm';
import { parseEnvelope } from './parse-envelope';
import { processEnvelope } from './processor';
import { closeMetrics } from './metrics';

/**
 * End-to-end pipeline smoke (SRS §9 acceptance path, backend half): a real Sentry
 * event envelope round-trips normalize → fingerprint → group → persist against the
 * live DB, producing exactly one Issue. Creates + tears down its own org/project.
 */
const slug = `smoke-${randomBytes(4).toString('hex')}`;
let orgId = '';
let projectId = '';

function eventEnvelope(eventId: string, value: string) {
  const header = { event_id: eventId };
  const event = {
    event_id: eventId,
    platform: 'javascript',
    level: 'error',
    timestamp: Date.now() / 1000,
    exception: {
      values: [
        {
          type: 'TypeError',
          value,
          stacktrace: { frames: [{ module: 'stores/inbox/useInboxConversations', function: 'fetchConversations', in_app: true, lineno: 42 }] },
        },
      ],
    },
  };
  return parseEnvelope(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`, 'utf8'));
}

test('setup: create org + project', async () => {
  const org = await db.insert(organizations).values({ name: `Smoke ${slug}` }).returning({ id: organizations.id });
  orgId = org[0].id;
  const proj = await db.insert(projects).values({ orgId, name: 'Smoke', slug, platform: 'javascript-nextjs' }).returning({ id: projects.id });
  projectId = proj[0].id;
  await db.insert(dsnKeys).values({ projectId, publicKey: randomBytes(8).toString('hex') });
});

test('event envelope → exactly one grouped Issue (FR-WRK/FR-GRP)', async () => {
  await processEnvelope(projectId, eventEnvelope('a'.repeat(32), "Cannot read properties of undefined (reading 'json')"));
  const rows = await db.select().from(issues).where(eq(issues.projectId, projectId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].culprit, 'stores/inbox/useInboxConversations');
  assert.equal(rows[0].timesSeen, 1);
});

test('same fingerprint, new event_id → grouped, times_seen bumps (idempotent per event)', async () => {
  await processEnvelope(projectId, eventEnvelope('b'.repeat(32), "Cannot read properties of undefined (reading 'json')"));
  // re-send the SAME event_id — must NOT double-count (FR-WRK-2)
  await processEnvelope(projectId, eventEnvelope('b'.repeat(32), "Cannot read properties of undefined (reading 'json')"));
  const rows = await db.select().from(issues).where(eq(issues.projectId, projectId));
  assert.equal(rows.length, 1, 'still one issue');
  assert.equal(rows[0].timesSeen, 2, 'two distinct events counted, duplicate ignored');
});

after(async () => {
  // events is partitioned (no FK cascade) — delete explicitly, then cascade the rest.
  if (projectId) await db.delete(events).where(eq(events.projectId, projectId));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId)); // cascades project/issues/counts
  await closeMetrics(); // release the Redis handle opened via processor→metrics
  await sql.end();
});
