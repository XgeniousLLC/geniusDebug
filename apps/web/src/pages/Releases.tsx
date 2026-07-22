import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton, ErrorState } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useUi } from '../store/ui';

const PAGE_SIZE = 20;

interface Release {
  id: string;
  version: string;
  commitSha: string | null;
  createdAt: string;
  projectId: string;
  projectName: string | null;
  newIssues: number;
}

/**
 * Releases (GD-135): version/commit, project, and how many new issues each release
 * introduced. Crash-free rate / adoption need session tracking (not ingested yet),
 * so those are intentionally omitted rather than shown as fake numbers.
 */
export function Releases() {
  const currentProjectId = useUi((s) => s.currentProjectId);
  const [page, setPage] = React.useState(0);
  React.useEffect(() => setPage(0), [currentProjectId]);
  const q = useQuery({
    queryKey: ['releases', currentProjectId, page],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (currentProjectId) p.set('projectId', currentProjectId);
      return api<{ items: Release[]; total: number }>(`/releases?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-h1 font-semibold">Releases</h1>
        <span className="text-caption text-text-faint">crash-free % / adoption require session tracking (not enabled)</span>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load releases." />
      ) : total === 0 ? (
        <EmptyState title="No releases yet" hint="Releases are registered by the source-map uploader or stamped on the first event carrying a `release`." />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
            <span>Release</span>
            <span className="hidden text-right sm:block">Commit</span>
            <span className="text-right">New issues</span>
            <span className="text-right">Age</span>
          </div>
          {(q.data?.items ?? []).map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-body text-text">{r.version}</div>
                <div className="truncate text-caption text-text-faint">{r.projectName ?? r.projectId.slice(0, 8)}</div>
              </div>
              <span className="hidden text-right font-mono text-small text-text-muted sm:block">
                {r.commitSha ? r.commitSha.slice(0, 7) : '—'}
              </span>
              <span className="text-right">
                {r.newIssues > 0 ? (
                  <Link to={`/issues`} className="font-mono text-small text-accent hover:underline">{r.newIssues}</Link>
                ) : (
                  <span className="font-mono text-small text-text-faint">0</span>
                )}
              </span>
              <span className="text-right font-mono text-small text-text-muted">{timeAgo(r.createdAt)} ago</span>
            </div>
          ))}
        </Card>
      )}

      {total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-caption text-text-faint">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE + PAGE_SIZE)} of {total} releases
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
