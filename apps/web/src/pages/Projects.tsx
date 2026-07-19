import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useUi } from '../store/ui';
import { Button, Card, Skeleton } from '../components/ui';
import { NoProject } from '../components/NoProject';
import { IntegrationGuide } from '../components/IntegrationGuide';

interface Project {
  id: string;
  name: string;
  slug: string;
  platform: string;
  ingestEnabled: boolean;
  setupCompletedAt: string | null;
}

export function Projects() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, currentProjectId, setCurrentProject } = useUi();
  const isAdmin = user?.role === 'admin';
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const list = projects.data ?? [];

  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = React.useState(params.get('new') === 'project');
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [platform, setPlatform] = React.useState('javascript-nextjs');
  const [err, setErr] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggleGuide = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: () => api<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, slug: slug || undefined, platform }) }),
    onSuccess: (proj) => {
      setName('');
      setSlug('');
      setShowNew(false);
      setErr(null);
      invalidate();
      setCurrentProject(proj.id);
      clearNewParam();
      // Redirect straight to the setup instructions for the new project (better onboarding UX).
      navigate(`/projects/${proj.id}/setup`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'create failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, deletedId) => {
      invalidate();
      if (deletedId === currentProjectId) {
        const next = list.find((p) => p.id !== deletedId)?.id ?? null;
        setCurrentProject(next);
      }
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'delete failed'),
  });

  function clearNewParam() {
    if (params.get('new')) {
      params.delete('new');
      setParams(params, { replace: true });
    }
  }
  function confirmDelete(p: Project) {
    if (window.confirm(`Delete "${p.name}"? This permanently removes its issues, events, traces and replays. This cannot be undone.`)) {
      setErr(null);
      remove.mutate(p.id);
    }
  }

  const inp = 'h-9 rounded-md border border-border bg-bg px-2.5 text-small text-text';

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-h1 font-semibold">Projects</h1>
          <p className="text-caption text-text-muted">Each project has its own DSN, environments and alert rules.</p>
        </div>
        {isAdmin && !showNew && (
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
            + New project
          </Button>
        )}
      </div>

      {err && (
        <div className="mb-3 rounded-md border border-level-error/40 bg-level-error/10 px-3 py-2 text-small text-level-error">{err}</div>
      )}

      {isAdmin && showNew && (
        <Card className="mb-4 p-4">
          <h2 className="mb-3 text-h2 font-semibold">New project</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-caption text-text-faint">Name</span>
              <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site" autoFocus />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption text-text-faint">Slug (optional)</span>
              <input className={inp} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from name" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption text-text-faint">Platform</span>
              <select className={inp} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="javascript-nextjs">javascript-nextjs</option>
                <option value="javascript-react">javascript-react</option>
                <option value="javascript">javascript</option>
                <option value="php">php</option>
                <option value="php-laravel">php-laravel</option>
              </select>
            </label>
            <Button variant="primary" size="sm" disabled={create.isPending || !name.trim()} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowNew(false);
                clearNewParam();
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {projects.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : list.length === 0 && !showNew ? (
        <NoProject />
      ) : (
        <Card className="overflow-hidden p-0">
          {list.map((p) => (
            <div key={p.id} className="border-b border-border last:border-0">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => setCurrentProject(p.id)} className="text-body text-text hover:underline">
                      {p.name}
                    </button>
                    {p.id === currentProjectId && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-caption text-accent">current</span>}
                    {!p.ingestEnabled && <span className="rounded bg-level-error/15 px-1.5 py-0.5 text-caption text-level-error">paused</span>}
                    {p.setupCompletedAt ? (
                      <span className="rounded bg-status-resolved/15 px-1.5 py-0.5 text-caption text-status-resolved">✓ setup complete</span>
                    ) : (
                      <span className="rounded bg-level-warning/15 px-1.5 py-0.5 text-caption text-level-warning">setup pending</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-3 font-mono text-caption text-text-muted">
                    <span>{p.slug}</span>
                    <span>{p.platform}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => toggleGuide(p.id)} className="text-caption text-accent hover:underline">
                    {expanded.has(p.id) ? 'Hide guide' : 'Setup guide'}
                  </button>
                  {p.id !== currentProjectId && (
                    <button onClick={() => setCurrentProject(p.id)} className="text-caption text-accent hover:underline">
                      switch to
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      onClick={() => confirmDelete(p)}
                      disabled={list.length <= 1 || remove.isPending}
                      className="text-caption text-level-error hover:underline disabled:cursor-not-allowed disabled:text-text-faint disabled:no-underline"
                      title={list.length <= 1 ? 'Cannot delete the last project' : 'Delete project'}
                    >
                      delete
                    </button>
                  )}
                </div>
              </div>
              {expanded.has(p.id) && (
                <div className="border-t border-border bg-bg/40 px-4 py-4">
                  <IntegrationGuide project={p} onChanged={invalidate} />
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

