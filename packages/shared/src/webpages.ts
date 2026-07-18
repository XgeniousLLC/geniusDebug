/**
 * Branded HTML pages for the backend services (ingest / api / workers).
 *
 * These are NestJS/HTTP-level responses, not the React SPA. When a human hits a
 * service URL in a browser they get a themed page; API clients (JSON Accept,
 * wildcard Accept, Sentry SDKs) still get JSON. Keeps the machine contract
 * intact while giving a friendly face to `debug-api.taskip.net/` etc.
 */

export type ServiceName = 'ingest' | 'api' | 'workers';

/** True when the caller looks like a browser and should get HTML, not JSON. */
export function wantsHtml(accept?: string | null): boolean {
  if (!accept) return false; // no Accept (most SDKs/curl) → JSON
  // Only serve HTML when text/html is explicitly preferred over JSON.
  const a = accept.toLowerCase();
  if (a.includes('application/json')) return false;
  return a.includes('text/html');
}

const BLURB: Record<ServiceName, string> = {
  ingest: 'Envelope intake — receives Sentry envelopes and enqueues them.',
  api: 'Dashboard API — issues, projects, auth and admin.',
  workers: 'Pipeline workers — symbolicate, group and persist events.',
};

interface PageOpts {
  service: ServiceName;
  code: number; // 200 / 404 / 500
  title: string;
  message: string;
}

function shell({ service, code, title, message }: PageOpts): string {
  const accent = '#6d5efc';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · geniusDebug ${escapeHtml(service)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0e0e14; color: #e7e7ee;
  }
  @media (prefers-color-scheme: light) {
    body { background: #ffffff; color: #1a1a22; }
    .card { border-color: #e6e6ee !important; }
    .muted { color: #6b6b7b !important; }
    .code { background: #f4f4f9 !important; }
  }
  .card {
    width: min(92vw, 460px); padding: 32px; border: 1px solid #23232e;
    border-radius: 14px; text-align: center;
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; letter-spacing: -.01em; }
  .dot { width: 10px; height: 10px; border-radius: 3px; background: ${accent}; display: inline-block; }
  .status { margin: 20px 0 6px; font-size: 46px; font-weight: 700; letter-spacing: -.03em; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  .muted { color: #9a9aab; font-size: 14px; line-height: 1.5; margin: 0; }
  .code {
    display: inline-block; margin-top: 18px; padding: 6px 10px; border-radius: 8px;
    background: #1a1a24; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${accent};
  }
</style>
</head>
<body>
  <main class="card">
    <span class="brand"><span class="dot"></span>geniusDebug</span>
    <div class="status">${code}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="muted">${escapeHtml(message)}</p>
    <span class="code">${escapeHtml(service)} service</span>
  </main>
</body>
</html>`;
}

/** Home page (200) — service is up. */
export function homePage(service: ServiceName): string {
  return shell({ service, code: 200, title: 'Service is running', message: BLURB[service] });
}

/** 404 page. */
export function notFoundPage(service: ServiceName): string {
  return shell({ service, code: 404, title: 'Not found', message: 'The page or endpoint you requested does not exist.' });
}

/** 500 page. */
export function errorPage(service: ServiceName): string {
  return shell({ service, code: 500, title: 'Something went wrong', message: 'An unexpected error occurred. It has been logged.' });
}

/** JSON bodies — the machine contract stays identical regardless of the HTML above. */
export function homeJson(service: ServiceName) {
  return { service, status: 'ok', message: BLURB[service] };
}
export function notFoundJson(service: ServiceName) {
  return { service, statusCode: 404, message: 'Not Found' };
}
export function errorJson(service: ServiceName) {
  return { service, statusCode: 500, message: 'Internal server error' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
