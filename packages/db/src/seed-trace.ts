import 'dotenv/config';
import { db, sql } from './client';
import { projects, dsnKeys } from '../schema';
import { eq } from 'drizzle-orm';

/**
 * Sends a `transaction` envelope for the reference trace (SRS §1.5,
 * bba7158e…d0375) so the Trace waterfall (FR-TRC-2) has spans to render and
 * links back to the issue in that trace (FR-TRC-4).
 */
const INGEST = `http://localhost:${process.env.INGEST_PORT ?? 4001}`;

function buildTransactionEnvelope(publicKey: string, projectId: string): string {
  const traceId = 'bba7158e21264876b051c6a0535d0375';
  const rootSpan = 'a1b2c3d4e5f60718';
  const now = Date.now() / 1000;
  const t0 = now - 1.2;

  const header = {
    event_id: cryptoRandom(),
    sent_at: new Date().toISOString(),
    sdk: { name: 'sentry.javascript.nextjs', version: '8.40.0' },
    dsn: `https://${publicKey}@localhost/${projectId}`,
  };
  const itemHeader = { type: 'transaction' };
  const transaction = {
    type: 'transaction',
    event_id: cryptoRandom(),
    transaction: '/:workspace/dashboard',
    platform: 'javascript',
    release: 'ab12cd34',
    environment: 'vercel-production',
    start_timestamp: t0,
    timestamp: now,
    contexts: {
      trace: { trace_id: traceId, span_id: rootSpan, op: 'navigation', description: '/:workspace/dashboard' },
      browser: { name: 'Chrome Mobile', version: '150' },
    },
    spans: [
      { span_id: 's0000000000000a1', parent_span_id: rootSpan, trace_id: traceId, op: 'http.client', description: 'GET /api/conversations', start_timestamp: t0 + 0.1, timestamp: t0 + 0.5, status: 'ok' },
      { span_id: 's0000000000000a2', parent_span_id: rootSpan, trace_id: traceId, op: 'resource.script', description: 'bundle.js', start_timestamp: t0 + 0.15, timestamp: t0 + 0.35, status: 'ok' },
      { span_id: 's0000000000000a3', parent_span_id: 's0000000000000a1', trace_id: traceId, op: 'react.render', description: 'InboxConversations', start_timestamp: t0 + 0.5, timestamp: t0 + 0.9, status: 'internal_error' },
    ],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(transaction)}\n`;
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:crypto').randomBytes(16).toString('hex');
}

async function main() {
  const rows = await db
    .select({ projectId: projects.id, publicKey: dsnKeys.publicKey })
    .from(dsnKeys)
    .innerJoin(projects, eq(projects.id, dsnKeys.projectId))
    .where(eq(dsnKeys.isActive, true))
    .limit(1);
  if (rows.length === 0) {
    console.error('[seed-trace] No DSN key. Register in the dashboard first.');
    await sql.end();
    process.exit(1);
  }
  const { projectId, publicKey } = rows[0];
  const body = buildTransactionEnvelope(publicKey, projectId);
  const url = `${INGEST}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body,
  });
  console.log(`[seed-trace] ingest responded ${res.status} (trace bba7158e…d0375)`);
  await sql.end();
  if (res.status >= 400) process.exit(1);
}

main().catch((err) => {
  console.error('[seed-trace] failed:', err);
  process.exit(1);
});
