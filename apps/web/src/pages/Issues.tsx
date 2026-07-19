import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { IssueDto } from '@geniusdebug/shared';
import { api, errMsg } from '../lib/api';
import { useUi } from '../store/ui';
import { toast, ACTION_PAST } from '../store/toast';
import { timeAgo, compact } from '../lib/format';
import { Button, LevelPill, StatusChip, Skeleton, EmptyState, ErrorState } from '../components/ui';
import { NoProject } from '../components/NoProject';
import { CheckIcon } from '../components/icons';

type StatusFilter = 'unresolved' | 'resolved' | 'archived' | 'all';
type Sort = 'lastSeen' | 'firstSeen' | 'events' | 'users';

export function Issues() {
  const environment = useUi((s) => s.environment);
  const range = useUi((s) => s.range);
  const currentProjectId = useUi((s) => s.currentProjectId);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = React.useState<StatusFilter>('unresolved');
  const [sort, setSort] = React.useState<Sort>('lastSeen');
  const [query, setQuery] = React.useState(params.get('query') ?? '');
  const [cursor, setCursor] = React.useState(0); // keyboard nav selection
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const qc = useQueryClient();

  // Keep query in sync when the global search routes here with ?query=.
  React.useEffect(() => {
    const q = params.get('query');
    if (q !== null) setQuery(q);
  }, [params]);

  const key = ['issues', { environment, range, status, sort, query, projectId: currentProjectId }];
  const issues = useQuery({
    queryKey: key,
    queryFn: () => {
      const p = new URLSearchParams({ status, sort });
      if (environment !== 'all') p.set('environment', environment);
      if (range !== 'all') p.set('range', range);
      if (query) p.set('query', query);
      if (currentProjectId) p.set('projectId', currentProjectId);
      return api<IssueDto[]>(`/issues?${p.toString()}`);
    },
    refetchInterval: 5000, // subtle real-time feel (brief §14)
  });

  const act = useMutation({
    mutationFn: (v: { shortId: string; action: string }) =>
      api(`/issues/${v.shortId}/actions`, { method: 'POST', body: JSON.stringify({ action: v.action }) }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['issues'] });
      toast.success(`${v.shortId} ${ACTION_PAST[v.action] ?? v.action}`);
    },
    onError: (e: unknown, v) => toast.error(`Couldn't ${v.action} ${v.shortId}: ${errMsg(e)}`),
  });
  const merge = useMutation({
    mutationFn: (v: { source: string; target: string }) =>
      api(`/issues/${v.source}/merge`, { method: 'POST', body: JSON.stringify({ targetShortId: v.target }) }),
    onSuccess: (_r, v) => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['issues'] });
      toast.success(`Merged ${v.source} into ${v.target}`);
    },
    onError: (e: unknown, v) => toast.error(`Couldn't merge ${v.source}: ${errMsg(e)}`),
  });

  const rows = issues.data ?? [];

  // Org-level empty state: no projects at all (cached — Shell already fetched it).
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ id: string }[]>('/projects') });
  const noProjects = !projects.isLoading && (projects.data?.length ?? 0) === 0;

  // Keyboard nav (brief §5): j/k move, e resolve, enter open.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'e' && rows[cursor]) act.mutate({ shortId: rows[cursor].shortId, action: rows[cursor].status === 'resolved' ? 'unresolve' : 'resolve' });
      else if (e.key === 'Enter' && rows[cursor]) navigate(`/issues/${rows[cursor].shortId}`);
      else if (e.key === 'x' && rows[cursor]) {
        setSelected((s) => {
          const n = new Set(s);
          n.has(rows[cursor].shortId) ? n.delete(rows[cursor].shortId) : n.add(rows[cursor].shortId);
          return n;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, act, navigate]);

  function doMerge() {
    const ids = [...selected];
    if (ids.length < 2) return;
    const target = ids[0]; // merge the rest into the first selected
    for (const s of ids.slice(1)) merge.mutate({ source: s, target });
  }

  if (noProjects) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-5">
        <h1 className="mb-4 text-h1 font-semibold">Issues</h1>
        <NoProject />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-h1 font-semibold">Issues</h1>
      </div>

      {/* Filter bar (FR-UI-2/3) */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={[
            ['unresolved', 'Unresolved'],
            ['resolved', 'Resolved'],
            ['archived', 'Archived'],
            ['all', 'All'],
          ]}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter events…"
          className="h-8 min-w-[200px] flex-1 rounded-md border border-border bg-surface px-3 text-small text-text placeholder:text-text-faint"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-small text-text"
        >
          <option value="lastSeen">Last Seen</option>
          <option value="firstSeen">First Seen</option>
          <option value="events">Events</option>
          <option value="users">Users</option>
        </select>
      </div>

      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-small">
          <span className="text-text">{selected.size} selected</span>
          <Button size="sm" variant="secondary" disabled={selected.size < 2 || merge.isPending} onClick={doMerge}>
            Merge into first
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-caption text-text-muted hover:text-text">
            clear
          </button>
          <span className="ml-auto text-caption text-text-faint">j/k move · x select · e resolve · ↵ open</span>
        </div>
      )}

      {issues.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : issues.isError ? (
        <ErrorState message="Couldn't load issues." onRetry={() => issues.refetch()} />
      ) : (issues.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<CheckIcon size={28} />}
          title="No issues"
          hint="Waiting for events. Point @sentry/nextjs at your project DSN, or run the reference-incident seed."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
            <span className="w-4" />
            <span>Issue</span>
            <span className="w-16 text-right">Events</span>
            <span className="w-16 text-right">Users</span>
            <span className="w-16 text-right">Age</span>
          </div>
          {rows.map((it, idx) => (
            <div
              key={it.id}
              className={`group grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2 ${
                idx === cursor ? 'bg-surface-2 ring-1 ring-inset ring-accent/40' : 'bg-bg'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(it.shortId)}
                onChange={(e) => {
                  setSelected((s) => {
                    const n = new Set(s);
                    e.target.checked ? n.add(it.shortId) : n.delete(it.shortId);
                    return n;
                  });
                }}
                className="h-4 w-4 accent-[color:var(--accent)]"
              />
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <LevelPill level={it.level} />
                  <StatusChip status={it.status} regressed={it.isRegressed} />
                </div>
                <Link to={`/issues/${it.shortId}`} className="block truncate text-body font-semibold text-text hover:text-accent">
                  {it.title}
                </Link>
                <div className="flex items-center gap-2 truncate font-mono text-caption text-text-muted">
                  <span className="truncate">{it.culprit ?? '—'}</span>
                  <span className="text-text-faint">·</span>
                  <span className="text-text-faint">{it.shortId}</span>
                </div>
                <div className="mt-1 hidden gap-1 group-hover:flex">
                  {it.status === 'resolved' ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'unresolve' })}>
                      Unresolve
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'resolve' })}>
                      Resolve
                    </Button>
                  )}
                  {it.status === 'archived' ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'unarchive' })}>
                      Unarchive
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'archive' })}>
                      Archive
                    </Button>
                  )}
                  {it.status === 'muted' ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'unmute' })}>
                      Unmute
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'mute' })}>
                      Mute
                    </Button>
                  )}
                </div>
              </div>
              <span className="w-16 text-right font-mono text-small text-text">{compact(it.timesSeen)}</span>
              <span className="w-16 text-right font-mono text-small text-text-muted">{compact(it.usersAffected)}</span>
              <span className="w-16 text-right font-mono text-small text-text-muted">{timeAgo(it.lastSeen)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 text-small ${
            value === v ? 'bg-accent text-white' : 'text-text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
