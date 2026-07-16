import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db, sql } from './client';
import { projects, dsnKeys } from '../schema';
import { eq, and } from 'drizzle-orm';

/**
 * Seeds the SRS §1.5 reference incident by POSTing a real Sentry envelope to the
 * ingest hot path — exercising ingest → worker → issue end-to-end (SRS §9).
 * Requires a project + active DSN key to exist first (created by registration).
 */
const INGEST = `http://localhost:${process.env.INGEST_PORT ?? 4001}`;

function buildEnvelope(publicKey: string, projectId: string): { body: string; eventId: string } {
  // Fresh event_id per run → re-seeding adds occurrences (and picks up a newly
  // linked GitHub repo on the frames). Trace/issue identity stays the reference.
  const eventId = randomBytes(16).toString('hex');
  const traceId = 'bba7158e21264876b051c6a0535d0375';
  const now = new Date().toISOString();
  const header = {
    event_id: eventId,
    sent_at: now,
    sdk: { name: 'sentry.javascript.nextjs', version: '8.40.0' },
    dsn: `https://${publicKey}@localhost/${projectId}`,
  };
  const itemHeader = { type: 'event' };
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    transaction: '/:workspace/dashboard',
    release: 'ab12cd34',
    environment: 'vercel-production',
    request: { url: 'https://app.taskip.net/acme/dashboard', method: 'GET' },
    exception: {
      values: [
        {
          type: 'TypeError',
          value: "Cannot read properties of undefined (reading 'json')",
          mechanism: { handled: true, type: 'generic' },
          stacktrace: {
            frames: [
              {
                filename: 'app://bundle.js',
                function: 'fetchConversations',
                abs_path: './stores/inbox/useInboxConversations.ts',
                module: 'stores/inbox/useInboxConversations',
                lineno: 42,
                colno: 17,
                in_app: true,
                pre_context: ['  const res = await fetch(url);', '  // parse body'],
                context_line: '  const data = await res.json();',
                post_context: ['  return data.conversations;', '}'],
              },
              {
                filename: 'node_modules/react-dom/cjs/react-dom.production.min.js',
                function: 'commitHookEffectListMount',
                lineno: 1,
                colno: 2345,
                in_app: false,
              },
            ],
          },
        },
      ],
    },
    contexts: {
      browser: { name: 'Chrome Mobile', version: '150' },
      os: { name: 'Android', version: '10' },
      device: { family: 'Android', model: 'Pixel' },
      trace: { trace_id: traceId, span_id: 'a1b2c3d4e5f60718', op: 'navigation' },
    },
    tags: { workspace: 'acme', 'browser.name': 'Chrome Mobile' },
    user: { id: 'u_123', username: 'anon' },
    breadcrumbs: {
      values: [
        { category: 'navigation', message: '/acme/dashboard', timestamp: Date.now() / 1000 - 3 },
        { category: 'fetch', message: 'GET /api/conversations 200', timestamp: Date.now() / 1000 - 1 },
      ],
    },
    sdk: { name: 'sentry.javascript.nextjs', version: '8.40.0' },
  };
  const body = `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(event)}\n`;
  return { body, eventId };
}

async function main() {
  const rows = await db
    .select({ projectId: projects.id, publicKey: dsnKeys.publicKey })
    .from(dsnKeys)
    .innerJoin(projects, eq(projects.id, dsnKeys.projectId))
    .where(eq(dsnKeys.isActive, true))
    .limit(1);

  if (rows.length === 0) {
    console.error('[seed] No active DSN key found. Register in the dashboard first (it provisions a project).');
    await sql.end();
    process.exit(1);
  }

  const { projectId, publicKey } = rows[0];
  const { body, eventId } = buildEnvelope(publicKey, projectId);
  const url = `${INGEST}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
  console.log(`[seed] POST ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body,
  });
  console.log(`[seed] ingest responded ${res.status} for event ${eventId}`);
  await sql.end();
  if (res.status >= 400) process.exit(1);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
