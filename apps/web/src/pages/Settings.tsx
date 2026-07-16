import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Card, IdChip, Skeleton } from '../components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  platform: string;
  ingestEnabled: boolean;
}

export function Settings() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const project = projects.data?.[0];
  const keys = useQuery({
    queryKey: ['keys', project?.id],
    enabled: !!project?.id,
    queryFn: () => api<{ publicKey: string; isActive: boolean; rateLimit: number }[]>(`/projects/${project!.id}/keys`),
  });

  if (projects.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  const dsn = keys.data?.[0];
  const host = window.location.hostname + ':4001';
  const dsnUrl = dsn && project ? `https://${dsn.publicKey}@${host}/${project.id}` : '…';

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <h1 className="mb-4 text-h1 font-semibold">Settings</h1>

      <Section title="General">
        <Row k="Project" v={project?.name ?? '—'} />
        <Row k="Slug" v={project?.slug ?? '—'} />
        <Row k="Platform" v={project?.platform ?? '—'} />
      </Section>

      <Section title="Client Keys (DSN)" hint="Public, write-only — safe to embed. Cannot read data (NFR-SEC-1).">
        {keys.isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="flex flex-col gap-2">
            {keys.data?.map((k) => (
              <div key={k.publicKey} className="flex items-center gap-3">
                <IdChip label="key" value={k.publicKey} />
                <span className="text-caption text-text-muted">{k.rateLimit}/min</span>
                <span className={`text-caption ${k.isActive ? 'text-status-resolved' : 'text-status-muted'}`}>
                  {k.isActive ? 'active' : 'revoked'}
                </span>
              </div>
            ))}
            <div className="mt-2">
              <div className="mb-1 text-caption uppercase text-text-faint">Sentry.init DSN</div>
              <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">
{`Sentry.init({
  dsn: "${dsnUrl}",
  tunnelRoute: "/monitoring",
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
});`}
              </pre>
            </div>
          </div>
        )}
      </Section>

      <Section title="Remote config / Kill switch" hint="Throttle or disable geniusDebug in Taskip without a redeploy (FR-SDK-8, NFR-PERF-4).">
        <Row k="Ingest enabled" v={project?.ingestEnabled ? 'Yes — accepting events' : 'No — dropping cheaply'} />
      </Section>

      <Section title="GitHub Integration" hint="Connect a repo so stack frames deep-link to source at the deployed commit (FR-GH-1/3).">
        {project ? <GithubLink projectId={project.id} /> : null}
      </Section>

      <Section title="Retention & Usage" hint="Purge ages out old data to control cost (FR-RET-1).">
        <Row k="Events" v="30 days" />
        <Row k="Replays" v="14 days" />
        <Row k="Source maps" v="aligned to release retention" />
      </Section>
    </div>
  );
}

function GithubLink({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const repo = useQuery({
    queryKey: ['repo', projectId],
    queryFn: () => api<{ owner: string; name: string; defaultBranch: string } | null>(`/projects/${projectId}/repository`),
  });
  const [owner, setOwner] = React.useState('XgeniousLLC');
  const [name, setName] = React.useState('taskip');
  const [branch, setBranch] = React.useState('main');
  const [commitSha, setCommitSha] = React.useState('ab12cd34');

  const link = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/repository`, {
        method: 'POST',
        body: JSON.stringify({ owner, name, defaultBranch: branch, releaseVersion: 'ab12cd34', commitSha }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repo', projectId] }),
  });

  if (repo.isLoading) return <Skeleton className="h-8 w-full" />;

  if (repo.data) {
    return (
      <div className="flex items-center justify-between text-small">
        <div>
          <span className="font-mono text-text">
            {repo.data.owner}/{repo.data.name}
          </span>
          <span className="ml-2 text-text-muted">@ {repo.data.defaultBranch}</span>
        </div>
        <span className="text-status-resolved">connected · frame deep-links on</span>
      </div>
    );
  }

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-faint">owner</span>
        <input className={inp} value={owner} onChange={(e) => setOwner(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-faint">repo</span>
        <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-faint">branch</span>
        <input className={inp} value={branch} onChange={(e) => setBranch(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-faint">commit (release ab12cd34)</span>
        <input className={inp} value={commitSha} onChange={(e) => setCommitSha(e.target.value)} />
      </label>
      <Button variant="primary" size="sm" disabled={link.isPending} onClick={() => link.mutate()}>
        {link.isPending ? 'Linking…' : 'Connect repository'}
      </Button>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2">
        <h2 className="text-h2 font-semibold">{title}</h2>
        {hint && <div className="text-caption text-text-muted">{hint}</div>}
      </div>
      {children}
    </Card>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-1.5 text-small last:border-0">
      <span className="text-text-muted">{k}</span>
      <span className="font-mono text-text">{v}</span>
    </div>
  );
}
