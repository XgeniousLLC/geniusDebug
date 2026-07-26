import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { db, sql, organizations, projects, dsnKeys, issues, events, replays } from '@geniusdebug/db';
import { eq } from 'drizzle-orm';
import { parseEnvelope } from './parse-envelope';
import { processEnvelope } from './processor';
import { closeMetrics } from './metrics';

/**
 * Reproduces GD-197/GD-203: real prod SDK (sentry.javascript.nextjs 10.x) stamps
 * replayId onto the error event as `tags.replayId`, NOT `contexts.replay.replay_id`.
 * Verifies both directions of the race: replay_event arriving first (backfilled
 * once the event lands) and event arriving first (replay linked at insert time).
 */
const slug = `replaylink-${randomBytes(4).toString('hex')}`;
let orgId = '';
let projectId = '';

function eventEnvelope(eventId: string, replayId: string) {
  const header = { event_id: eventId };
  const event = {
    event_id: eventId,
    platform: 'javascript',
    level: 'error',
    timestamp: Date.now() / 1000,
    tags: { replayId }, // real SDK shape — no contexts.replay at all
    exception: {
      values: [
        {
          type: 'TypeError',
          value: `boom ${eventId}`,
          stacktrace: { frames: [{ module: 'app/page', function: 'onClick', in_app: true, lineno: 10 }] },
        },
      ],
    },
  };
  return parseEnvelope(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`, 'utf8'));
}

function replayEnvelope(replayId: string) {
  const header = { event_id: randomBytes(16).toString('hex') };
  const payload = {
    replay_id: replayId,
    timestamp: Date.now() / 1000,
    replay_start_timestamp: Date.now() / 1000 - 5,
    trace_ids: [],
  };
  return parseEnvelope(Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ type: 'replay_event' })}\n${JSON.stringify(payload)}\n`, 'utf8'));
}

test('setup: create org + project', async () => {
  const org = await db.insert(organizations).values({ name: `ReplayLink ${slug}` }).returning({ id: organizations.id });
  orgId = org[0].id;
  const proj = await db.insert(projects).values({ orgId, name: 'ReplayLink', slug, platform: 'javascript-nextjs' }).returning({ id: projects.id });
  projectId = proj[0].id;
  await db.insert(dsnKeys).values({ projectId, publicKey: randomBytes(8).toString('hex') });
});

test('replay lands BEFORE its error event → backfilled by tags.replayId once event processes', async () => {
  const replayId = `r-${randomBytes(6).toString('hex')}`;
  const eventId = 'a'.repeat(32);

  await processEnvelope(projectId, replayEnvelope(replayId));
  const before = await db.select().from(replays).where(eq(replays.replayId, replayId));
  assert.equal(before.length, 1, 'replay row inserted');
  assert.equal(before[0].issueId, null, 'issueId not yet known — event has not landed');

  await processEnvelope(projectId, eventEnvelope(eventId, replayId));
  const issueRows = await db.select().from(issues).where(eq(issues.projectId, projectId));
  assert.equal(issueRows.length, 1, 'exactly one issue created');

  const after_ = await db.select().from(replays).where(eq(replays.replayId, replayId));
  assert.equal(after_.length, 1);
  assert.equal(after_[0].issueId, issueRows[0].id, 'replay backfilled to the issue via tags.replayId match');
});

test('error event lands BEFORE its replay_event → replay linked immediately at insert', async () => {
  const replayId = `r-${randomBytes(6).toString('hex')}`;
  const eventId = 'b'.repeat(32);

  await processEnvelope(projectId, eventEnvelope(eventId, replayId));
  const evRows = await db.select().from(events).where(eq(events.id, eventId));
  assert.equal(evRows[0].replayId, replayId, 'events.replay_id captured from tags.replayId');

  await processEnvelope(projectId, replayEnvelope(replayId));
  const replayRows = await db.select().from(replays).where(eq(replays.replayId, replayId));
  assert.equal(replayRows.length, 1);
  assert.ok(replayRows[0].issueId, 'replay linked to an issue immediately (matched by events.replay_id)');
});

after(async () => {
  if (projectId) await db.delete(events).where(eq(events.projectId, projectId));
  if (projectId) await db.delete(replays).where(eq(replays.projectId, projectId));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await closeMetrics();
  await sql.end();
});
