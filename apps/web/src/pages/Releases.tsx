import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton, ErrorState } from '../components/ui';
import { timeAgo } from '../lib/format';

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
  const q = useQuery({ queryKey: ['releases'], queryFn: () => api<Release[]>('/releases') });

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
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No releases yet" hint="Releases are registered by the source-map uploader or stamped on the first event carrying a `release`." />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
            <span>Release</span>
            <span className="hidden text-right sm:block">Commit</span>
            <span className="text-right">New issues</span>
            <span className="text-right">Age</span>
          </div>
          {q.data!.map((r) => (
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
    </div>
  );
}
