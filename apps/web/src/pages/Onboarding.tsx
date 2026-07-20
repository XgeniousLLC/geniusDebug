import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { IssueListResponse } from '@geniusdebug/shared';
import { api } from '../lib/api';
import { buildDsn } from '../lib/ingest';
import { Card, Button, Skeleton } from '../components/ui';
import { CheckIcon } from '../components/icons';

/** Post-signup onboarding (brief §6): DSN + install, live "waiting for first event". */
export function Onboarding() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ id: string; name: string }[]>('/projects') });
  const projectId = projects.data?.[0]?.id;
  const keys = useQuery({
    queryKey: ['keys', projectId],
    enabled: !!projectId,
    queryFn: () => api<{ publicKey: string }[]>(`/projects/${projectId}/keys`),
  });
  // Poll until the first event lands (flips to success).
  const issues = useQuery({
    queryKey: ['issues', 'onboard'],
    queryFn: () => api<IssueListResponse>('/issues?status=all&limit=1'),
    refetchInterval: 4000,
  });

  const dsn = keys.data?.[0]?.publicKey;
  const dsnUrl = dsn && projectId ? buildDsn(dsn, projectId) : '…';
  const gotEvent = (issues.data?.total ?? 0) > 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="mb-1 text-h1 font-semibold">Set up geniusDebug</h1>
      <p className="mb-6 text-small text-text-muted">Point Taskip's @sentry/nextjs at your project, then trigger an error.</p>

      <Card className="mb-4 p-4">
        <div className="mb-2 text-h2 font-semibold">1 · Your DSN</div>
        {keys.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">{dsnUrl}</pre>
        )}
      </Card>

      <Card className="mb-4 p-4">
        <div className="mb-2 text-h2 font-semibold">2 · Install</div>
        <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">{`Sentry.init({
  dsn: "${dsnUrl}",
  tunnelRoute: "/monitoring",
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});`}</pre>
        <p className="mt-2 text-caption text-text-muted">Full reference: <code>taskip-integration/</code> in the repo.</p>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-h2 font-semibold">
            {gotEvent ? <CheckIcon size={18} /> : <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />}
            3 · {gotEvent ? 'First event received' : 'Waiting for first event…'}
          </div>
          {gotEvent && (
            <Link to="/issues">
              <Button variant="primary" size="sm">View issues</Button>
            </Link>
          )}
        </div>
      </Card>
    </div>
  );
}
