import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { IssueDto } from '@geniusdebug/shared';
import { api, errMsg } from '../lib/api';
import { useUi, RANGE_LABELS, type IssueRange } from '../store/ui';
import { toast, ACTION_PAST } from '../store/toast';
import { timeAgo, compact } from '../lib/format';
import { Button, LevelPill, Skeleton, EmptyState, ErrorState } from '../components/ui';
import { NoProject } from '../components/NoProject';
import { CheckIcon } from '../components/icons';

type StatusFilter = 'unresolved' | 'resolved' | 'archived' | 'all';
type Sort = 'lastSeen' | 'firstSeen' | 'events' | 'users';

const PAGE_SIZE = 25;
const LEVEL_HEX: Record<string, string> = {
  fatal: '#7B2CBF',
  error: '#E5484D',
  warning: '#F5A623',
  info: '#4C82F7',
  debug: '#8A8A98',
};
const AVATAR_PALETTE = ['#7B2CBF', '#4C82F7', '#E5484D', '#F5A623', '#12A594', '#D6409F'];

export function Issues() {
  const environment = useUi((s) => s.environment);
  const range = useUi((s) => s.range);
  const setRange = useUi((s) => s.setRange);
  const currentProjectId = useUi((s) => s.currentProjectId);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = React.useState<StatusFilter>('unresolved');
  const [category, setCategory] = React.useState(params.get('category') ?? 'all');
  const [sort, setSort] = React.useState<Sort>('lastSeen');
  const [query, setQuery] = React.useState(params.get('query') ?? '');
  const [cursor, setCursor] = React.useState(0); // keyboard nav selection (within page)
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [page, setPage] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const qc = useQueryClient();

  // Keep query in sync when the global search routes here with ?query=.
  React.useEffect(() => {
    const q = params.get('query');
    if (q !== null) setQuery(q);
  }, [params]);

  const key = ['issues', { environment, range, status, category, sort, query, projectId: currentProjectId }];
  const issues = useQuery({
    queryKey: key,
    queryFn: () => {
      const p = new URLSearchParams({ status, sort });
      if (category !== 'all') p.set('category', category);
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

  const allRows = issues.data ?? [];
  const total = allRows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const rows = allRows.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
  // Reset paging/cursor when the filter set changes.
  React.useEffect(() => setPage(0), [status, category, sort, query, range, environment, currentProjectId]);
  React.useEffect(() => setCursor(0), [clampedPage]);

  // Org-level empty state: no projects at all (cached — Shell already fetched it).
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ id: string }[]>('/projects') });
  const noProjects = !projects.isLoading && (projects.data?.length ?? 0) === 0;

  // Keyboard nav (brief §5): j/k move, e resolve, x select, enter open.
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

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.shortId));
  function toggleAll() {
    setSelected((s) => {
      const n = new Set(s);
      if (allChecked) rows.forEach((r) => n.delete(r.shortId));
      else rows.forEach((r) => n.add(r.shortId));
      return n;
    });
  }

  if (noProjects) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <h1 className="mb-4 text-h1 font-semibold">Issues</h1>
        <NoProject />
      </div>
    );
  }

  const sel = 'h-9 rounded-lg border border-border bg-surface px-3 text-small text-text';

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <h1 className="mb-4 text-h1 font-semibold">Issues</h1>

      {/* Filter bar (FR-UI-2/3) */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* search box with is:<status> token + Save */}
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 sm:min-w-[280px]">
          <SearchIcon />
          <span className="shrink-0 font-mono text-small text-accent">is:{status}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter events…"
            className="h-full min-w-0 flex-1 bg-transparent text-small text-text outline-none placeholder:text-text-faint"
          />
          <button
            onClick={() => {
              const p = new URLSearchParams();
              if (query) p.set('query', query);
              navigate(`/issues${p.toString() ? `?${p}` : ''}`);
              toast.success('Search saved to URL — copy the link to share');
            }}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-caption text-text-muted hover:text-text"
          >
            Save
          </button>
        </div>

        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={sel} title="Status">
          <option value="unresolved">Unresolved</option>
          <option value="resolved">Resolved</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>

        <select value={range} onChange={(e) => setRange(e.target.value as IssueRange)} className={sel} title="Time range">
          {(Object.keys(RANGE_LABELS) as IssueRange[]).map((r) => (
            <option key={r} value={r}>
              {RANGE_LABELS[r]}
            </option>
          ))}
        </select>

        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={sel} title="Sort">
          <option value="lastSeen">Sort: Last Seen</option>
          <option value="firstSeen">Sort: First Seen</option>
          <option value="events">Sort: Events</option>
          <option value="users">Sort: Users</option>
        </select>

        {/* hamburger → category menu */}
        <div className="relative">
          <button onClick={() => setMenuOpen((o) => !o)} className={`${sel} grid w-9 place-items-center px-0`} title="More filters" aria-label="More filters">
            <HamburgerIcon />
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-border bg-surface p-1 shadow-lg">
              <div className="px-2 py-1 text-caption uppercase tracking-wide text-text-faint">Category</div>
              {[
                ['all', 'All categories'],
                ['error', 'Errors'],
                ['warning', 'Warnings'],
                ['performance', 'Performance'],
                ['network', 'Network'],
                ['ui', 'UI'],
                ['security', 'Security'],
                ['other', 'Other'],
              ].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => {
                    setCategory(v);
                    setMenuOpen(false);
                  }}
                  className={`block w-full rounded px-2 py-1 text-left text-small ${category === v ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface-2 hover:text-text'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-small">
          <span className="text-text">{selected.size} selected</span>
          <Button size="sm" variant="secondary" disabled={selected.size < 2 || merge.isPending} onClick={doMerge}>
            Merge into first
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-caption text-text-muted hover:text-text">
            clear
          </button>
        </div>
      )}

      {issues.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : issues.isError ? (
        <ErrorState message="Couldn't load issues." onRetry={() => issues.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<CheckIcon size={28} />}
          title="No issues"
          hint="Waiting for events. Point @sentry/nextjs at your project DSN, or run the reference-incident seed."
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border">
            {/* header */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_7rem_4rem_4rem_3rem] items-center gap-3 border-b border-border bg-surface px-4 py-2.5 text-caption uppercase tracking-wide text-text-faint sm:grid-cols-[auto_minmax(0,1fr)_9rem_5rem_5rem_4rem]">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} className="h-4 w-4 rounded accent-[color:var(--accent)]" aria-label="Select all" />
              <span>Issue</span>
              <span className="hidden sm:block">Graph</span>
              <span className="block text-right sm:hidden" />
              <span className="text-right">Events</span>
              <span className="hidden text-right sm:block">Users</span>
              <span className="text-right">Assignee</span>
            </div>

            {rows.map((it, idx) => {
              const hex = LEVEL_HEX[it.level] ?? LEVEL_HEX.debug;
              const isNew = !it.isRegressed && Date.now() - new Date(it.firstSeen).getTime() < 24 * 3600 * 1000;
              return (
                <div
                  key={it.id}
                  className={`group relative grid grid-cols-[auto_minmax(0,1fr)_7rem_4rem_4rem_3rem] items-center gap-3 border-b border-border py-3 pl-4 pr-4 last:border-0 hover:bg-surface-2 sm:grid-cols-[auto_minmax(0,1fr)_9rem_5rem_5rem_4rem] ${
                    idx === cursor ? 'bg-surface-2' : 'bg-bg'
                  }`}
                >
                  {/* left accent bar on the cursor row */}
                  {idx === cursor && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}

                  <input
                    type="checkbox"
                    checked={selected.has(it.shortId)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        e.target.checked ? n.add(it.shortId) : n.delete(it.shortId);
                        return n;
                      })
                    }
                    className="h-4 w-4 rounded accent-[color:var(--accent)]"
                  />

                  {/* issue cell */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <LevelPill level={it.level} />
                      <Link to={`/issues/${it.shortId}`} className="truncate text-body font-semibold text-text hover:text-accent">
                        {it.title}
                      </Link>
                      {isNew && <Badge tone="info">NEW</Badge>}
                      {it.isRegressed && <Badge tone="warning">REGRESSED</Badge>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-caption text-text-muted">
                      {it.culprit && <span className="truncate">{it.culprit}</span>}
                      <span className="text-text-faint">{it.shortId}</span>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hex }} aria-hidden />
                      <span className="shrink-0 text-text-faint">{timeAgo(it.lastSeen)}</span>
                    </div>
                  </div>

                  {/* sparkline */}
                  <div className="hidden sm:block">
                    <Sparkline data={it.spark ?? []} color={hex} />
                  </div>

                  <span className="text-right font-mono text-small font-medium text-text">{compact(it.timesSeen)}</span>
                  <span className="hidden text-right font-mono text-small font-medium text-text sm:block">{compact(it.usersAffected)}</span>
                  <span className="flex justify-end">
                    <Avatar name={it.assigneeName} />
                  </span>

                  {/* hover triage toolbar */}
                  <div className="absolute right-2 top-1.5 z-10 hidden items-center gap-1 rounded-lg border border-border bg-surface px-1 py-0.5 shadow-sm group-hover:flex">
                    {it.status === 'resolved' ? (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'unresolve' })}>Unresolve</ActBtn>
                    ) : (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'resolve' })}>Resolve</ActBtn>
                    )}
                    {it.status === 'archived' ? (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'unarchive' })}>Unarchive</ActBtn>
                    ) : (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'archive' })}>Archive</ActBtn>
                    )}
                    {it.status === 'muted' ? (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'unmute' })}>Unmute</ActBtn>
                    ) : (
                      <ActBtn onClick={() => act.mutate({ shortId: it.shortId, action: 'mute' })}>Mute</ActBtn>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* footer */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-caption text-text-faint">
            <span>
              Showing {clampedPage * PAGE_SIZE + 1}–{Math.min(total, clampedPage * PAGE_SIZE + PAGE_SIZE)} of {total} issues · press{' '}
              <Kbd>j</Kbd> <Kbd>k</Kbd> to navigate, <Kbd>e</Kbd> resolve, <Kbd>x</Kbd> select
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={clampedPage === 0}
                className="rounded-md border border-border px-2.5 py-1 text-small text-text-muted hover:text-text disabled:opacity-40"
              >
                ‹ Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={clampedPage >= pageCount - 1}
                className="rounded-md border border-border px-2.5 py-1 text-small text-text-muted hover:text-text disabled:opacity-40"
              >
                Next ›
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120;
  const h = 32;
  if (!data || data.length < 2) return <div className="h-8 w-full" aria-hidden />;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - 3 - ((v - min) / range) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Avatar({ name }: { name?: string | null }) {
  if (!name) return <span className="inline-block h-7 w-7 rounded-full border border-dashed border-border" aria-label="unassigned" />;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const bg = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full text-caption font-semibold text-white" style={{ background: bg }} title={name}>
      {initials}
    </span>
  );
}

function Badge({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  const cls = tone === 'info' ? 'border-level-info/50 text-level-info' : 'border-regressed/50 text-regressed';
  return <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>;
}

function ActBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded px-2 py-1 text-caption text-text-muted hover:bg-surface-2 hover:text-text">
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-surface px-1 font-mono text-[10px] text-text-muted">{children}</kbd>;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-text-faint" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-text-muted" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
