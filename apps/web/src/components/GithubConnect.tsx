import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { toast } from '../store/toast';
import { Button, Skeleton } from './ui';

/**
 * Coolify-style GitHub App manifest flow for a project: create App(s) → install →
 * pick repo, plus manual repo link and per-app disconnect (FR-GH-1/3). Shared by
 * Settings → GitHub and the post-create project setup page.
 */
export function GithubConnect({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const installationId = params.get('installation_id') ?? undefined;

  const app = useQuery({
    queryKey: ['gh-app'],
    queryFn: () =>
      api<{ installed: boolean; app: { id: string; slug: string; ownerLogin?: string | null; installUrl: string } | null }>('/github/app'),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repo', projectId] });
      toast.success('Repository linked');
    },
    onError: (e: unknown) => toast.error(`Link failed: ${errMsg(e)}`),
  });

  const unlink = useMutation({
    mutationFn: () => api(`/github/projects/${projectId}/unlink`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repo', projectId] });
      toast.success('Repository unlinked');
    },
    onError: (e: unknown) => toast.error(`Unlink failed: ${errMsg(e)}`),
  });

  // Disconnect a connected App (admin) — removes stored creds + cascades linked repos.
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/github/app/${id}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gh-app'] });
      qc.invalidateQueries({ queryKey: ['repo', projectId] });
      toast.success('GitHub App disconnected');
    },
    onError: (e: unknown) => toast.error(`Disconnect failed: ${errMsg(e)}`),
  });

  if (app.isLoading || repo.isLoading) return <Skeleton className="h-10 w-full" />;

  const connectedApp = app.data?.app ?? null;

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';

  // Create the App (personal or org) — one App per org.
  const createForm = (
    <div className="flex flex-col gap-2">
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
        Creates a least-privilege App (contents + metadata, read-only) under your {account} account, then install it on a repo.
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Connected App (org-scoped) — install repo or disconnect. */}
      {connectedApp && (
        <div className="flex flex-col gap-1">
          <div className="text-caption uppercase text-text-faint">Connected app</div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-small">
            <span className="text-text-muted">
              App <span className="font-mono text-text">{connectedApp.slug}</span>
              {connectedApp.ownerLogin ? ` · ${connectedApp.ownerLogin}` : ''}
            </span>
            <span className="flex items-center gap-3">
              <a href={connectedApp.installUrl} className="text-accent hover:underline">
                Install / add repos →
              </a>
              <Button size="sm" variant="danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate(connectedApp.id)}>
                Disconnect
              </Button>
            </span>
          </div>
        </div>
      )}

      {/* Repo picker after an install (installation_id in the URL). */}
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
                  <Button size="sm" variant="primary" disabled={link.isPending} onClick={() => link.mutate(r)}>
                    {link.isPending ? 'Linking…' : 'Link'}
                  </Button>
                </div>
              ))}
              {(repos.data ?? []).length === 0 && <span className="text-caption text-text-muted">No repos on this installation.</span>}
            </div>
          )}
        </div>
      )}

      {/* This project's linked repo status. */}
      {repo.data && (
        <div className="flex items-center justify-between rounded-md border border-border bg-bg px-3 py-1.5 text-small">
          <span className="font-mono text-text">
            {repo.data.owner}/{repo.data.name} <span className="text-text-muted">@ {repo.data.defaultBranch}</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="text-status-resolved">connected · frame deep-links on</span>
            <Button size="sm" variant="danger" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              Unlink
            </Button>
          </span>
        </div>
      )}

      {!connectedApp && createForm}
      {!repo.data && <ManualLink projectId={projectId} />}
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
