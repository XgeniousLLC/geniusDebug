import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
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
        {project ? <KillSwitch projectId={project.id} enabled={project.ingestEnabled} /> : null}
      </Section>

      <Section title="Members" hint="Invite teammates; admin-only controls are gated (FR-ADM-6, NFR-SEC-6).">
        <Members />
      </Section>

      <Section title="GitHub Integration" hint="Create a GitHub App (personal or org), install it, and link a repo so frames deep-link to source (FR-GH-1/3).">
        {project ? <GithubApp projectId={project.id} /> : null}
      </Section>

      <Section title="Retention & Usage" hint="Purge ages out old data to control cost (FR-RET-1).">
        <Row k="Events" v="30 days" />
        <Row k="Replays" v="14 days" />
        <Row k="Source maps" v="aligned to release retention" />
      </Section>
    </div>
  );
}

function KillSwitch({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api(`/projects/${projectId}/ingest`, { method: 'POST', body: JSON.stringify({ enabled: next }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
  return (
    <div className="flex items-center justify-between text-small">
      <span className={enabled ? 'text-status-resolved' : 'text-level-error'}>
        Ingest {enabled ? 'enabled — accepting events' : 'disabled — dropping cheaply (202)'}
      </span>
      <Button
        size="sm"
        variant={enabled ? 'danger' : 'primary'}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!enabled)}
      >
        {enabled ? 'Disable ingest' : 'Enable ingest'}
      </Button>
    </div>
  );
}

interface Member {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
}
function Members() {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/members') });
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');

  const invite = useMutation({
    mutationFn: () => api('/members', { method: 'POST', body: JSON.stringify({ name, email, role: 'member' }) }),
    onSuccess: () => {
      setName('');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/members/${id}/remove`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';
  return (
    <div>
      <div className="mb-3 overflow-hidden rounded-md border border-border">
        {members.data?.map((m) => (
          <div key={m.id} className="flex items-center justify-between border-b border-border px-3 py-2 text-small last:border-0">
            <div>
              <span className="text-text">{m.name}</span>
              <span className="ml-2 font-mono text-caption text-text-muted">{m.email}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-border px-2 py-0.5 text-caption capitalize text-text-muted">{m.role}</span>
              <button onClick={() => remove.mutate(m.id)} className="text-caption text-level-error hover:underline">
                remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">name</span>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">email</span>
          <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <Button size="sm" variant="primary" disabled={invite.isPending || !name || !email} onClick={() => invite.mutate()}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
    </div>
  );
}

/** Coolify-style GitHub App manifest flow: create → install → pick repo (FR-GH-1). */
function GithubApp({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const installationId = params.get('installation_id') ?? undefined;

  const app = useQuery({
    queryKey: ['gh-app'],
    queryFn: () => api<{ installed: boolean; slug?: string; ownerLogin?: string; installUrl?: string }>('/github/app'),
  });
  const repo = useQuery({
    queryKey: ['repo', projectId],
    queryFn: () => api<{ owner: string; name: string; defaultBranch: string } | null>(`/projects/${projectId}/repository`),
  });

  const [account, setAccount] = React.useState<'personal' | 'org'>('personal');
  const [org, setOrg] = React.useState('');

  // Step 1 — create the App: fetch a manifest, then POST a form to GitHub.
  async function createApp() {
    const { postUrl, manifest, state } = await api<{ postUrl: string; manifest: object; state: string }>(
      '/github/app/manifest',
      { method: 'POST', body: JSON.stringify({ account, org: org || undefined }) },
    );
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${postUrl}?state=${encodeURIComponent(state)}`;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'manifest';
    input.value = JSON.stringify(manifest);
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }

  // Step 3 — pick a repo the installation can access.
  const repos = useQuery({
    queryKey: ['gh-repos', installationId],
    enabled: !!installationId,
    queryFn: () => api<{ owner: string; name: string; defaultBranch: string }[]>(`/github/installations/${installationId}/repos`),
  });
  const link = useMutation({
    mutationFn: (r: { owner: string; name: string; defaultBranch: string }) =>
      api(`/github/projects/${projectId}/link`, {
        method: 'POST',
        body: JSON.stringify({ installationId, ...r }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repo', projectId] }),
  });

  if (app.isLoading || repo.isLoading) return <Skeleton className="h-10 w-full" />;

  // Already linked.
  if (repo.data) {
    return (
      <div className="flex items-center justify-between text-small">
        <span className="font-mono text-text">
          {repo.data.owner}/{repo.data.name} <span className="text-text-muted">@ {repo.data.defaultBranch}</span>
        </span>
        <span className="text-status-resolved">connected · frame deep-links on</span>
      </div>
    );
  }

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';

  // App exists → install + repo picker.
  if (app.data?.installed) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-small">
          <span className="text-text-muted">
            App <span className="font-mono text-text">{app.data.slug}</span>
            {app.data.ownerLogin ? ` · ${app.data.ownerLogin}` : ''}
          </span>
          <a href={app.data.installUrl} className="text-accent hover:underline">
            Install / add repos →
          </a>
        </div>
        {installationId && (
          <div>
            <div className="mb-1 text-caption uppercase text-text-faint">Pick a repo (installation {installationId})</div>
            {repos.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <div className="flex flex-col gap-1">
                {(repos.data ?? []).map((r) => (
                  <div key={`${r.owner}/${r.name}`} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-small">
                    <span className="font-mono text-text">{r.owner}/{r.name}</span>
                    <Button size="sm" variant="primary" onClick={() => link.mutate(r)}>
                      Link
                    </Button>
                  </div>
                ))}
                {(repos.data ?? []).length === 0 && <span className="text-caption text-text-muted">No repos on this installation.</span>}
              </div>
            )}
          </div>
        )}
        <ManualLink projectId={projectId} />
      </div>
    );
  }

  // No app yet → create one (personal or org).
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">account</span>
          <select className={inp} value={account} onChange={(e) => setAccount(e.target.value as 'personal' | 'org')}>
            <option value="personal">Personal</option>
            <option value="org">Organization</option>
          </select>
        </label>
        {account === 'org' && (
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-faint">org login</span>
            <input className={inp} value={org} onChange={(e) => setOrg(e.target.value)} placeholder="XgeniousLLC" />
          </label>
        )}
        <Button variant="primary" size="sm" onClick={createApp} disabled={account === 'org' && !org}>
          Create GitHub App
        </Button>
      </div>
      <div className="text-caption text-text-muted">
        Creates a least-privilege App (contents + metadata, read-only) under your {account} account, then install it on repos.
      </div>
      <ManualLink projectId={projectId} />
    </div>
  );
}

function ManualLink({ projectId }: { projectId: string }) {
  const [open, setOpen] = React.useState(false);
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="text-left text-caption text-text-faint hover:text-accent">
        or link a repo manually →
      </button>
    );
  return <GithubLink projectId={projectId} />;
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
