import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db, sql } from './client';
import { projects, dsnKeys } from '../schema';
import { eq } from 'drizzle-orm';

/**
 * Sends an on-error replay (SRS §5.8) for the reference trace so the Replays list
 * + player have data (FR-RPL-3/5/6). replay_recording is a masked, compressed blob
 * in real life (streamed to R2); here it's a tiny placeholder payload.
 */
const INGEST = `http://localhost:${process.env.INGEST_PORT ?? 4001}`;

function buildReplayEnvelope(publicKey: string, projectId: string): string {
  const traceId = 'bba7158e21264876b051c6a0535d0375';
  const replayId = randomBytes(16).toString('hex');
  const now = Date.now() / 1000;
  const header = {
    event_id: replayId,
    sent_at: new Date().toISOString(),
    sdk: { name: 'sentry.javascript.nextjs', version: '8.40.0' },
    dsn: `https://${publicKey}@localhost/${projectId}`,
  };
  const replayEvent = {
    type: 'replay_event',
    replay_id: replayId,
    segment_id: 2,
    replay_start_timestamp: now - 8,
    timestamp: now,
    trace_ids: [traceId],
    urls: ['https://app.taskip.net/acme/dashboard'],
    platform: 'javascript',
    environment: 'vercel-production',
    user: { id: 'u_123', username: 'anon' },
  };
  const recording = { segment_id: 2, masked: true }; // placeholder for the rrweb blob

  return (
    `${JSON.stringify(header)}\n` +
    `${JSON.stringify({ type: 'replay_event' })}\n${JSON.stringify(replayEvent)}\n` +
    `${JSON.stringify({ type: 'replay_recording' })}\n${JSON.stringify(recording)}\n`
  );
}

async function main() {
  const rows = await db
    .select({ projectId: projects.id, publicKey: dsnKeys.publicKey })
    .from(dsnKeys)
    .innerJoin(projects, eq(projects.id, dsnKeys.projectId))
    .where(eq(dsnKeys.isActive, true))
    .limit(1);
  if (rows.length === 0) {
    console.error('[seed-replay] No DSN key. Register first.');
    await sql.end();
    process.exit(1);
  }
  const { projectId, publicKey } = rows[0];
  const res = await fetch(`${INGEST}/api/${projectId}/envelope/?sentry_key=${publicKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body: buildReplayEnvelope(publicKey, projectId),
  });
  console.log(`[seed-replay] ingest responded ${res.status}`);
  await sql.end();
  if (res.status >= 400) process.exit(1);
}

main().catch((err) => {
  console.error('[seed-replay] failed:', err);
  process.exit(1);
});
