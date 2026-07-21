import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError, API_BASE } from '../lib/api';
import { Button, Skeleton } from './ui';
import { GithubConnect } from './GithubConnect';
import { buildDsn } from '../lib/ingest';
import { useUi } from '../store/ui';

export interface GuideProject {
  id: string;
  name: string;
  platform?: string;
  setupCompletedAt: string | null;
}

/** Per-project SDK setup guide: DSN snippet, mark-complete, email-to-developer. */
export function IntegrationGuide({ project, onChanged }: { project: GuideProject; onChanged: () => void }) {
  const isPhp = (project.platform ?? '').startsWith('php');

  const keys = useQuery({
    queryKey: ['keys', project.id],
    queryFn: () => api<{ publicKey: string; isActive: boolean }[]>(`/projects/${project.id}/keys`),
  });
  const dsnKey = keys.data?.find((k) => k.isActive) ?? keys.data?.[0];
  const dsn = dsnKey ? buildDsn(dsnKey.publicKey, project.id) : '…';

  const snippet = isPhp
    ? `# .env
SENTRY_LARAVEL_DSN="${dsn}"
SENTRY_TRACES_SAMPLE_RATE=0.2
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=\${GIT_COMMIT_SHA}

# bootstrap/app.php (Laravel 11+) — report exceptions to Sentry
use Sentry\\Laravel\\Integration;

->withExceptions(function (Exceptions $exceptions) {
    Integration::handles($exceptions);
})

# app/Exceptions/Handler.php (Laravel 8–10) — inside register()
use Sentry\\Laravel\\Integration;
Integration::handles($this);

# config/sentry.php → 'tracing' (published by artisan sentry:publish)
# — this is what feeds the Trace waterfall, incl. DB query spans:
'tracing' => [
    'queue_job_transactions' => true,   // queue jobs as spans
    'sql_queries'            => true,   // every DB query as a timed span (the "query waterfall")
    'sql_bindings'           => false,  // true = show bound params in span desc (may leak PII)
    'sql_origin'             => true,   // tag the calling file:line per query
    'http_client_requests'   => true,   // outbound Http::/Guzzle calls as spans
    'cache'                  => true,   // cache get/put/hit/miss as spans
    'views'                  => true,   // Blade view render as spans
    'missing_routes'         => false,  // trace 404s too
],`
    : `// sentry.client.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "${dsn}",
  tunnelRoute: "/monitoring",
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
});`;

  const [copied, setCopied] = React.useState(false);
  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const setup = useMutation({
    mutationFn: (completed: boolean) => api(`/projects/${project.id}/setup`, { method: 'POST', body: JSON.stringify({ completed }) }),
    onSuccess: onChanged,
  });

  // Email-to-developer
  const [devEmail, setDevEmail] = React.useState('');
  const [note, setNote] = React.useState('');
  const [emailMsg, setEmailMsg] = React.useState<{ ok: boolean; text: string; mailto?: string } | null>(null);
  const sendEmail = useMutation({
    mutationFn: () => api<{ sent: boolean; reason?: string; to: string }>(`/projects/${project.id}/setup/email`, {
      method: 'POST',
      body: JSON.stringify({ email: devEmail, note: note || undefined, dsn }),
    }),
    onSuccess: (r) => {
      if (r.sent) setEmailMsg({ ok: true, text: `Sent to ${r.to}.` });
      else setEmailMsg({ ok: false, text: `Couldn't send (${r.reason ?? 'email not configured'}). Use the mail-client link instead.`, mailto: buildMailto(devEmail, project.name, dsn, isPhp, note) });
    },
    onError: (e) => setEmailMsg({ ok: false, text: e instanceof ApiError ? e.message : 'send failed' }),
  });

  const inp = 'h-9 rounded-md border border-border bg-bg px-2.5 text-small text-text';

  return (
    <div className="flex flex-col gap-4">
      {/* Status + mark complete */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-small">
          {project.setupCompletedAt ? (
            <span className="text-status-resolved">✓ Integration marked complete</span>
          ) : (
            <span className="text-text-muted">Wire the SDK below, then mark this project complete.</span>
          )}
        </div>
        {project.setupCompletedAt ? (
          <span className="rounded-full border border-status-resolved/40 px-2.5 py-1 text-caption text-status-resolved">
            Completed
          </span>
        ) : (
          <Button size="sm" variant="primary" disabled={setup.isPending} onClick={() => setup.mutate(true)}>
            {setup.isPending ? '…' : 'Mark as complete'}
          </Button>
        )}
      </div>

      {/* Steps */}
      <ol className="ml-4 list-decimal space-y-1 text-small text-text-muted">
        {isPhp ? (
          <>
            <li>Install the SDK: <code className="font-mono text-text">composer require sentry/sentry-laravel</code></li>
            <li>Publish config + stub .env: <code className="font-mono text-text">php artisan sentry:publish --dsn="{dsn}"</code> (creates <code className="font-mono text-text">config/sentry.php</code>).</li>
            <li>Register the handler in <code className="font-mono text-text">bootstrap/app.php</code> (Laravel 11+) or <code className="font-mono text-text">app/Exceptions/Handler.php</code> (Laravel ≤10) — see below.</li>
            <li>Set <code className="font-mono text-text">.env</code> and (optionally) the <code className="font-mono text-text">tracing</code> toggles in <code className="font-mono text-text">config/sentry.php</code> below.</li>
            <li>Set <code className="font-mono text-text">SENTRY_TRACES_SAMPLE_RATE</code> above 0 to get performance traces — this is what populates the query waterfall.</li>
            <li>Verify locally: <code className="font-mono text-text">php artisan sentry:test</code>.</li>
            <li>Deploy — events appear here within seconds.</li>
          </>
        ) : (
          <>
            <li>Install the SDK: <code className="font-mono text-text">npm i @sentry/nextjs</code></li>
            <li>Add the config below to <code className="font-mono text-text">sentry.client.config.ts</code> (and server/edge).</li>
            <li>Wrap <code className="font-mono text-text">next.config.js</code> with <code className="font-mono text-text">withSentryConfig</code> + tunnel route.</li>
            <li>Deploy — events appear here within seconds.</li>
          </>
        )}
      </ol>

      {/* DSN + snippet */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-caption uppercase text-text-faint">{isPhp ? '.env / config' : 'Sentry.init'}</span>
          <button onClick={() => copy(snippet)} className="text-caption text-accent hover:underline">
            {copied ? 'copied ✓' : 'copy'}
          </button>
        </div>
        {keys.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">{snippet}</pre>
        )}
      </div>

      {isPhp && (
        <div className="rounded-md border border-accent/30 bg-accent/5 p-3 text-caption text-text-muted">
          <div className="mb-1 font-semibold text-text">What you get on an API-only Laravel project</div>
          <ul className="ml-4 list-disc space-y-1">
            <li><span className="text-text">Query waterfall, yes</span> — with <code className="font-mono">sql_queries: true</code> the SDK auto-wraps every DB query as a span (SQL text, duration, source file:line via <code className="font-mono">sql_origin</code>). It shows in the Trace waterfall the same as JS spans, sorted by start time with per-span duration bars. Bound parameter values are hidden by default (<code className="font-mono">sql_bindings: false</code>) — flip on only if you're OK with that data reaching geniusDebug.</li>
            <li>Also auto-instrumented as spans: cache ops, outbound HTTP client calls, queue jobs, Blade view renders — all timed and nested under the request transaction.</li>
            <li><span className="text-text">No session replay</span> — replay is a browser/DOM (rrweb) recording feature; a server-side API has no DOM to record. You still get: error + stack trace, breadcrumbs, request context (method/url/headers/user), and the full trace/query waterfall above.</li>
          </ul>
        </div>
      )}

      {!isPhp && <SourceMapCallout project={project} />}

      {/* Email a developer */}
      <div className="rounded-md border border-border bg-surface/50 p-3">
        <div className="mb-2 text-small font-semibold text-text">Send setup instructions to a developer</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-faint">Developer email</span>
            <input className={`${inp} w-56`} type="email" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} placeholder="dev@yourteam.com" />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-caption text-text-faint">Note (optional)</span>
            <input className={`${inp} w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Please wire this before Friday" />
          </label>
          <Button size="sm" variant="primary" disabled={sendEmail.isPending || !devEmail.trim()} onClick={() => { setEmailMsg(null); sendEmail.mutate(); }}>
            {sendEmail.isPending ? 'Sending…' : 'Send email'}
          </Button>
        </div>
        {emailMsg && (
          <div className={`mt-2 text-caption ${emailMsg.ok ? 'text-status-resolved' : 'text-level-error'}`}>
            {emailMsg.text}
            {emailMsg.mailto && (
              <a href={emailMsg.mailto} className="ml-2 text-accent hover:underline">Open in mail client →</a>
            )}
          </div>
        )}
      </div>

      {/* Connect a GitHub repo (optional) — deep-links stack frames to source. */}
      <div className="rounded-md border border-border bg-surface/50 p-3">
        <div className="mb-2">
          <div className="text-small font-semibold text-text">Connect a GitHub repo</div>
          <div className="text-caption text-text-muted">
            Optional — link this project's repo so stack frames deep-link to the exact source line (FR-GH-1/3).
          </div>
        </div>
        <GithubConnect projectId={project.id} />
      </div>
    </div>
  );
}

function buildMailto(to: string, projectName: string, dsn: string, isPhp: boolean, note?: string): string {
  const subject = `Set up error monitoring for ${projectName}`;
  const steps = isPhp
    ? [
        `1. composer require sentry/sentry-laravel`,
        `2. php artisan sentry:publish --dsn="${dsn}"`,
        `3. Register the handler:`,
        `   - Laravel 11+ (bootstrap/app.php): Integration::handles($exceptions) inside ->withExceptions(...)`,
        `   - Laravel <=10 (app/Exceptions/Handler.php): Integration::handles($this) inside register()`,
        `4. Set SENTRY_TRACES_SAMPLE_RATE > 0 in .env to get performance traces + the DB query waterfall.`,
        `5. Verify: php artisan sentry:test`,
        ``,
        `.env:`,
        `SENTRY_LARAVEL_DSN="${dsn}"`,
        `SENTRY_TRACES_SAMPLE_RATE=0.2`,
        ``,
        `Note: this is an API-only project — no session replay (that's browser-only). You do get errors, stack`,
        `traces, and a full performance/query waterfall (every DB query timed as a span) once tracing is on.`,
      ]
    : [
        `1. npm i @sentry/nextjs`,
        `2. sentry.client.config.ts:`,
        ``,
        `Sentry.init({ dsn: "${dsn}", tunnelRoute: "/monitoring" });`,
      ];
  const body = [
    note ? `${note}\n` : '',
    `Please wire ${projectName} to geniusDebug (Sentry-SDK compatible):`,
    ``,
    ...steps,
    ``,
    `DSN is public + write-only — safe to commit.`,
  ].join('\n');
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * JS/Next.js-only callout (GD-171): production builds minify JS, so without
 * uploading source maps to geniusDebug, stack traces show mangled variable
 * names and no real file/line — exactly the "Minified React error #422, no
 * source context" symptom this project hit in prod. Explains why + gets the
 * upload token right here instead of sending the user hunting through Settings.
 */
function SourceMapCallout({ project }: { project: GuideProject }) {
  const isAdmin = useUi((s) => s.user?.role === 'admin');
  const [token, setToken] = React.useState<string | null>(null);
  const issue = useMutation({
    mutationFn: () => api<{ token: string }>(`/projects/${project.id}/upload-token`, { method: 'POST' }),
    onSuccess: (r) => setToken(r.token),
  });
  const [copied, setCopied] = React.useState(false);
  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  // Per-project vars only. R2_* is org-level (Settings → Integrations →
  // Cloudflare R2, connected once for the whole platform, not per project) —
  // the uploader picks it up server-side, so it's not shown here. GENIUSDEBUG_ORG_TOKEN
  // is a secret, shown once below. RELEASE is intentionally omitted (auto falls
  // back to Vercel's own VERCEL_GIT_COMMIT_SHA).
  const sourceMapEnvBlock = `GENIUSDEBUG_API=${API_BASE}
GENIUSDEBUG_PROJECT_ID=${project.id}
GENIUSDEBUG_ORG_TOKEN=<paste the token issued below>`;
  return (
    <div className="rounded-md border border-level-warning/30 bg-level-warning/5 p-3 text-caption text-text-muted">
      <div className="mb-1 font-semibold text-text">Set up source maps — or production errors stay minified</div>
      <p className="mb-2">
        Deployed JS is minified. Without this step, errors here look like{' '}
        <code className="font-mono text-text">Minified React error #422</code> with no real file, line, or
        variable names — undebuggable. Sentry's own SaaS upload is deliberately disabled for this project;
        geniusDebug uploads maps straight to your own R2 with a separate post-build step.
      </p>
      <ol className="ml-4 list-decimal space-y-1">
        <li>Add a post-build step in your Vercel project: <code className="font-mono text-text">node scripts/upload-sourcemaps.mjs</code></li>
        <li>
          Set these env vars in Vercel (Project → Settings → Environment Variables):
          <div className="mb-1 mt-1 flex items-center justify-between">
            <span className="text-caption uppercase text-text-faint">Vercel env vars</span>
            <button onClick={() => copy(sourceMapEnvBlock)} className="text-caption text-accent hover:underline">{copied ? 'copied ✓' : 'copy'}</button>
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">{sourceMapEnvBlock}</pre>
          <div className="mt-1 text-text-faint">
            R2_* values are the same ones you connected under Settings → Integrations → Cloudflare R2 (server-side secrets — never returned to the client, so re-enter them here). <code className="font-mono text-text">RELEASE</code> doesn't need to be set — Vercel auto-provides <code className="font-mono text-text">VERCEL_GIT_COMMIT_SHA</code> and the script falls back to it automatically.
          </div>
        </li>
        <li>
          Issue <code className="font-mono text-text">GENIUSDEBUG_ORG_TOKEN</code> (shown once) — never Sentry's own auth token:
          {isAdmin ? (
            token ? (
              <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">{token}</pre>
            ) : (
              <div className="mt-1">
                <Button size="sm" variant="secondary" disabled={issue.isPending} onClick={() => issue.mutate()}>
                  {issue.isPending ? 'Issuing…' : 'Issue upload token'}
                </Button>
              </div>
            )
          ) : (
            <span className="text-text-muted"> ask an admin (Settings → General → Source Maps).</span>
          )}
          {issue.isError && (
            <div className="mt-1 text-level-error">{issue.error instanceof ApiError ? issue.error.message : 'Failed to issue token'}</div>
          )}
        </li>
      </ol>
    </div>
  );
}
