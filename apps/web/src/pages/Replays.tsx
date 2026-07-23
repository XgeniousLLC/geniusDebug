import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Card, EmptyState, Skeleton, LevelPill } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useUi } from '../store/ui';
import { useRealtime } from '../lib/useRealtime';
import { toast } from '../store/toast';

const PAGE_SIZE = 20;

interface Replay {
  id: string;
  projectId: string;
  issueId: string | null;
  replayId: string | null;
  traceId: string | null;
  user: Record<string, unknown> | null;
  durationMs: number | null;
  size: number | null;
  segmentCount: number;
  createdAt: string;
  projectName: string | null;
  issueShortId: string | null;
  issueTitle: string | null;
  issueLevel: string | null;
  issueCulprit: string | null;
}
interface ProjectSummary { id: string; name: string }

const fmtDur = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const fmtBytes = (b: number | null) => {
  const n = b ?? 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
};
const userLabel = (u: Record<string, unknown> | null) => {
  if (!u) return null;
  return (u.email as string) || (u.username as string) || (u.id as string) || null;
};

export function Replays() {
  const currentProjectId = useUi((s) => s.currentProjectId);
  useRealtime(currentProjectId);
  const qc = useQueryClient();
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects') });
  const projectName = projects.data?.find((p) => p.id === currentProjectId)?.name;
  const q = useQuery({
    queryKey: ['replays', currentProjectId, page],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (currentProjectId) p.set('projectId', currentProjectId);
      return api<{ items: Replay[]; total: number }>(`/replays?${p.toString()}`);
    },
    placeholderData: (prev) => prev,
    refetchInterval: 30000, // fallback poll; realtime updates arrive via SSE (GD-147)
  });
  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = q.data?.items ?? [];

  React.useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [currentProjectId]);

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api<{ deleted: number }>('/replays/bulk/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: (r) => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['replays'] });
      toast.success(`Deleted ${r.deleted} replay${r.deleted === 1 ? '' : 's'}`);
    },
    onError: (e: unknown) => toast.error(`Couldn't delete: ${errMsg(e)}`),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((r) => r.id))));
  }
  function doDelete(ids: string[]) {
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} replay${ids.length === 1 ? '' : 's'}? This removes all recorded segments and cannot be undone.`)) return;
    bulkDelete.mutate(ids);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-h1 font-semibold">Replays</h1>
        {projectName && (
          <span className="rounded-full bg-surface px-2.5 py-1 text-caption text-text-muted">{projectName}</span>
        )}
      </div>
      <p className="mb-4 text-small text-text-muted">Session recordings captured on error. Each links to the issue it belongs to.</p>

      {selected.size > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-small">
          <span className="mr-1 text-text">{selected.size} selected</span>
          <button
            onClick={() => doDelete([...selected])}
            disabled={bulkDelete.isPending}
            className="rounded-md border border-level-error/40 px-2.5 py-1 text-caption font-medium text-level-error hover:bg-level-error/10 disabled:opacity-50"
          >
            Delete
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-caption text-text-muted hover:text-text">
            clear
          </button>
        </div>
      )}

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : total === 0 ? (
        <EmptyState
          title="No replays yet"
          hint="Replay runs in on-error/buffered mode (FR-RPL-1) — the SDK only sends on error. Masked inputs render as blocks for privacy (FR-RPL-4)."
        />
      ) : (
        <Card className="overflow-hidden">
          {/* header row (desktop) */}
          <div className="hidden grid-cols-[1.5rem_minmax(0,1fr)_9rem_5rem_5rem_6rem_2rem] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint md:grid">
            <input
              type="checkbox"
              checked={items.length > 0 && selected.size === items.length}
              onChange={toggleAll}
              className="h-3.5 w-3.5 accent-accent"
              aria-label="Select all replays"
            />
            <span>Related issue</span>
            <span>User</span>
            <span className="text-right">Duration</span>
            <span className="text-right">Segments</span>
            <span className="text-right">When</span>
            <span />
          </div>
          {items.map((r) => {
            const user = userLabel(r.user);
            return (
              <div
                key={r.id}
                className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2 md:grid md:grid-cols-[1.5rem_minmax(0,1fr)_9rem_5rem_5rem_6rem_2rem] md:items-center md:gap-4"
              >
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-accent md:mt-0"
                  aria-label="Select replay"
                />
                <Link to={`/replays/${r.id}`} className="block min-w-0 flex-1 md:contents">
                  {/* related issue */}
                  <div className="min-w-0">
                    {r.issueShortId ? (
                      <div className="flex items-center gap-2">
                        {r.issueLevel && <LevelPill level={r.issueLevel} />}
                        <span className="truncate text-small text-text">{r.issueTitle ?? r.issueShortId}</span>
                      </div>
                    ) : (
                      <span className="text-small text-text-faint">No linked issue</span>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-text-faint">
                      {r.issueShortId && <span className="font-mono text-accent">{r.issueShortId}</span>}
                      {r.issueCulprit && <span className="truncate font-mono">· {r.issueCulprit}</span>}
                      <span className="font-mono">· {fmtBytes(r.size)}</span>
                      {r.traceId && <span className="font-mono">· trace {r.traceId.slice(0, 8)}</span>}
                    </div>
                  </div>
                  {/* desktop columns */}
                  <span className="mt-1 block truncate text-caption text-text-muted md:mt-0 md:text-small">{user ?? 'anonymous'}</span>
                  <span className="hidden text-right font-mono text-small text-text-muted md:block">{fmtDur(r.durationMs)}</span>
                  <span className="hidden text-right font-mono text-small text-text-muted md:block">{r.segmentCount}</span>
                  <span className="hidden text-right text-caption text-text-faint md:block">{timeAgo(r.createdAt)} ago</span>
                  {/* mobile inline row */}
                  <div className="mt-1 flex items-center gap-3 text-caption text-text-faint md:hidden">
                    <span className="font-mono">{fmtDur(r.durationMs)}</span>
                    <span>· {r.segmentCount} seg</span>
                    <span>· {timeAgo(r.createdAt)} ago</span>
                  </div>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    doDelete([r.id]);
                  }}
                  title="Delete replay"
                  className="shrink-0 rounded-md p-1 text-text-faint hover:bg-level-error/10 hover:text-level-error"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </Card>
      )}

      {total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-caption text-text-faint">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE + PAGE_SIZE)} of {total} replays
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-border px-2.5 py-1 text-small text-text-muted hover:text-text disabled:opacity-40"
            >
              ‹ Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
              className="rounded-md border border-border px-2.5 py-1 text-small text-text-muted hover:text-text disabled:opacity-40"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
