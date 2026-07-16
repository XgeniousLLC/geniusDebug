/**
 * Taskip — tunnel route (FR-SDK-3 / FR-BLD-4). The Sentry SDK POSTs envelopes
 * same-origin to `/monitoring`; this handler forwards the RAW body to geniusDebug
 * ingest unmodified. It must fail fast and NEVER block/throw into the app
 * (NFR-PERF-3/8): if geniusDebug is down, we swallow and return 202.
 *
 * The DSN host + project id are derived from the envelope header's `dsn` field.
 */
export const runtime = 'nodejs';
export const maxDuration = 10;

const GENIUSDEBUG_HOST = process.env.GENIUSDEBUG_INGEST_HOST!; // e.g. https://ingest.geniusdebug.xgenious.com

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.arrayBuffer();
    const text = Buffer.from(body).toString('utf8');
    const firstNewline = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, firstNewline));
    const dsn = new URL(header.dsn);
    const projectId = dsn.pathname.replace('/', '');
    const publicKey = dsn.username;

    // Fire-and-forget forward; do not await long or block the user's request path.
    const url = `${GENIUSDEBUG_HOST}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body,
    }).catch(() => {}); // geniusDebug down → swallow (Taskip unaffected, NFR-PERF-8)

    return new Response(null, { status: 202 });
  } catch {
    return new Response(null, { status: 202 }); // never surface tunnel errors to the app
  }
}
