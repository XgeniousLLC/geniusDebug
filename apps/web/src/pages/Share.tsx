import * as React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';
import { GeniusDebugWordmark } from '../brand/GeniusDebugIcon';
import { Card, LevelPill, StatusChip, IdChip, Skeleton, ErrorState } from '../components/ui';
import { StackTrace } from '../components/StackTrace';
import { timeAgo } from '../lib/format';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4002';

interface PublicIssue {
  issue: IssueDto;
  latestEvent: EventDto | null;
}

/**
 * Public, unauthenticated read-only issue view (GD-133). Reached via a share token
 * (`/share/:token`) — no login, no Shell. Only what the owner chose to expose.
 */
export function Share() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-issue', token],
    queryFn: async () => {
      const res = await fetch(`${BASE}/public/issues/${token}`);
      if (!res.ok) throw new Error('not found');
      return (await res.json()) as PublicIssue;
    },
    retry: false,
  });

  return (
    <div className="min-h-full bg-bg">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <GeniusDebugWordmark size={22} />
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-caption text-text-muted">Shared · read-only</span>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        {q.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : q.isError || !q.data ? (
          <ErrorState message="This shared link is invalid or has been disabled." />
        ) : (
          <>
            <div className="mb-1 flex items-center gap-2">
              <LevelPill level={q.data.issue.level} />
              <StatusChip status={q.data.issue.status} regressed={q.data.issue.isRegressed} />
            </div>
            <h1 className="text-h1 font-semibold text-text">{q.data.issue.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-small text-text-muted">
              <span>{q.data.issue.culprit ?? '—'}</span>
              <span className="text-text-faint">·</span>
              <span className="text-text-faint">{q.data.issue.shortId}</span>
              <span className="text-text-faint">·</span>
              <span className="text-text-faint">
                {q.data.issue.timesSeen} events · last seen {timeAgo(q.data.issue.lastSeen)} ago
              </span>
            </div>

            {q.data.latestEvent?.traceId && (
              <div className="mt-3">
                <IdChip label="trace" value={q.data.latestEvent.traceId} />
              </div>
            )}

            <Card className="mt-5 p-4">
              <h2 className="mb-3 text-h2 font-semibold">Stack trace</h2>
              <StackTrace frames={(q.data.latestEvent?.exception?.frames ?? []) as NormalizedFrame[]} />
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
