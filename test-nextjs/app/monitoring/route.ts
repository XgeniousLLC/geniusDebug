/**
 * Tunnel route — the Sentry SDK POSTs envelopes same-origin to `/monitoring`;
 * this handler forwards the RAW body to the local geniusDebug ingest. Same-origin
 * avoids CORS against localhost:4001. Fails fast, never throws into the app.
 */
export const runtime = 'nodejs';
export const maxDuration = 10;

const GENIUSDEBUG_HOST = process.env.GENIUSDEBUG_INGEST_HOST ?? 'http://localhost:4001';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.arrayBuffer();
    const text = Buffer.from(body).toString('utf8');
    const firstNewline = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, firstNewline));
    const dsn = new URL(header.dsn);
    const projectId = dsn.pathname.replace('/', '');
    const publicKey = dsn.username;

    const url = `${GENIUSDEBUG_HOST}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body,
    }).catch(() => null);

    // Surface the ingest status locally so the test page can show it.
    return new Response(res ? await res.text().catch(() => '') : 'ingest unreachable', {
      status: res?.status ?? 202,
    });
  } catch {
    return new Response(null, { status: 202 });
  }
}
