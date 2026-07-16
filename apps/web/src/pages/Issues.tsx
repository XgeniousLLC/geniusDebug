import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { IssueDto } from '@geniusdebug/shared';
import { api } from '../lib/api';
import { useUi } from '../store/ui';
import { timeAgo, compact } from '../lib/format';
import { Button, LevelPill, StatusChip, Skeleton, EmptyState, ErrorState } from '../components/ui';
import { CheckIcon } from '../components/icons';

type StatusFilter = 'unresolved' | 'resolved' | 'archived' | 'all';
type Sort = 'lastSeen' | 'firstSeen' | 'events' | 'users';

export function Issues() {
  const environment = useUi((s) => s.environment);
  const [status, setStatus] = React.useState<StatusFilter>('unresolved');
  const [sort, setSort] = React.useState<Sort>('lastSeen');
  const [query, setQuery] = React.useState('');
  const qc = useQueryClient();

  const key = ['issues', { environment, status, sort, query }];
  const issues = useQuery({
    queryKey: key,
    queryFn: () => {
      const p = new URLSearchParams({ status, sort });
      if (environment !== 'all') p.set('environment', environment);
      if (query) p.set('query', query);
      return api<IssueDto[]>(`/issues?${p.toString()}`);
    },
    refetchInterval: 5000, // subtle real-time feel (brief §14)
  });

  const act = useMutation({
    mutationFn: (v: { shortId: string; action: string }) =>
      api(`/issues/${v.shortId}/actions`, { method: 'POST', body: JSON.stringify({ action: v.action }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issues'] }),
  });

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
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
            <span>Issue</span>
            <span className="w-16 text-right">Events</span>
            <span className="w-16 text-right">Users</span>
            <span className="w-16 text-right">Age</span>
          </div>
          {issues.data!.map((it) => (
            <div
              key={it.id}
              className="group grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border bg-bg px-4 py-3 last:border-0 hover:bg-surface-2"
            >
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
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'resolve' })}>
                    Resolve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'archive' })}>
                    Archive
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ shortId: it.shortId, action: 'mute' })}>
                    Mute
                  </Button>
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
