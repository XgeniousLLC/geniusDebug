import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Skeleton } from './ui';
import { GithubConnect } from './GithubConnect';

export interface GuideProject {
  id: string;
  name: string;
  setupCompletedAt: string | null;
}

/** Per-project SDK setup guide: DSN snippet, mark-complete, email-to-developer. */
export function IntegrationGuide({ project, onChanged }: { project: GuideProject; onChanged: () => void }) {
  const keys = useQuery({
    queryKey: ['keys', project.id],
    queryFn: () => api<{ publicKey: string; isActive: boolean }[]>(`/projects/${project.id}/keys`),
  });
  const dsnKey = keys.data?.find((k) => k.isActive) ?? keys.data?.[0];
  const host = `${window.location.hostname}:4001`;
  const dsn = dsnKey ? `https://${dsnKey.publicKey}@${host}/${project.id}` : '…';

  const snippet = `// sentry.client.config.ts
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
      else setEmailMsg({ ok: false, text: `Couldn't send (${r.reason ?? 'email not configured'}). Use the mail-client link instead.`, mailto: buildMailto(devEmail, project.name, dsn, note) });
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
        <Button
          size="sm"
          variant={project.setupCompletedAt ? 'secondary' : 'primary'}
          disabled={setup.isPending}
          onClick={() => setup.mutate(!project.setupCompletedAt)}
        >
          {setup.isPending ? '…' : project.setupCompletedAt ? 'Mark as incomplete' : 'Mark as complete'}
        </Button>
      </div>

      {/* Steps */}
      <ol className="ml-4 list-decimal space-y-1 text-small text-text-muted">
        <li>Install the SDK: <code className="font-mono text-text">npm i @sentry/nextjs</code></li>
        <li>Add the config below to <code className="font-mono text-text">sentry.client.config.ts</code> (and server/edge).</li>
        <li>Wrap <code className="font-mono text-text">next.config.js</code> with <code className="font-mono text-text">withSentryConfig</code> + tunnel route.</li>
        <li>Deploy — events appear here within seconds.</li>
      </ol>

      {/* DSN + snippet */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-caption uppercase text-text-faint">Sentry.init</span>
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

function buildMailto(to: string, projectName: string, dsn: string, note?: string): string {
  const subject = `Set up error monitoring for ${projectName}`;
  const body = [
    note ? `${note}\n` : '',
    `Please wire ${projectName} to geniusDebug (Sentry-SDK compatible):`,
    ``,
    `1. npm i @sentry/nextjs`,
    `2. sentry.client.config.ts:`,
    ``,
    `Sentry.init({ dsn: "${dsn}", tunnelRoute: "/monitoring" });`,
    ``,
    `DSN is public + write-only — safe to commit.`,
  ].join('\n');
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
