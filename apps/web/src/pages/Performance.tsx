import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton, ErrorState } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useUi } from '../store/ui';

interface Sample {
  spanId: string;
  op: string | null;
  description: string | null;
  durationMs: number | null;
  status: string | null;
  traceId: string;
  transaction: string | null;
  startTs: string | null;
}
interface OpAgg {
  op: string | null;
  count: number;
  avgMs: number | null;
  p75Ms: number | null;
  maxMs: number | null;
}
interface PerfResponse {
  samples: Sample[];
  byOp: OpAgg[];
}

/**
 * Performance explorer (GD-136) — worst spans + per-op p75, from the traces/spans
 * tables. Web-vitals charts (LCP p75 over time) light up once browser pageload
 * transactions with `measurements` are ingested (GD-146).
 */
export function Performance() {
  const currentProjectId = useUi((s) => s.currentProjectId);
  const q = useQuery({
    queryKey: ['performance', currentProjectId],
    queryFn: () =>
      api<PerfResponse>(`/performance${currentProjectId ? `?projectId=${currentProjectId}` : ''}`),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-h1 font-semibold">Performance</h1>
        <span className="text-caption text-text-faint">worst spans by p75 duration</span>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load performance data." />
      ) : (q.data?.samples.length ?? 0) === 0 ? (
        <EmptyState title="No span data yet" hint="Send `transaction` envelopes (tracesSampleRate > 0) to populate the performance explorer." />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Per-op aggregates */}
          <div>
            <h2 className="mb-2 text-h2 font-semibold">By operation</h2>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
                <span>Operation</span>
                <span className="w-16 text-right">Count</span>
                <span className="w-16 text-right">Avg</span>
                <span className="w-16 text-right">p75</span>
                <span className="w-16 text-right">Max</span>
              </div>
              {q.data!.byOp.map((o, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-2 text-small last:border-0">
                  <span className="truncate font-mono text-accent">{o.op ?? 'span'}</span>
                  <span className="w-16 text-right font-mono text-text-muted">{o.count}</span>
                  <span className="w-16 text-right font-mono text-text-muted">{o.avgMs ?? 0}ms</span>
                  <span className="w-16 text-right font-mono text-text">{o.p75Ms ?? 0}ms</span>
                  <span className="w-16 text-right font-mono text-text-faint">{o.maxMs ?? 0}ms</span>
                </div>
              ))}
            </Card>
          </div>

          {/* Slowest span samples */}
          <div>
            <h2 className="mb-2 text-h2 font-semibold">Slowest spans</h2>
            <Card className="overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_auto_auto] gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
                <span className="w-32">Op</span>
                <span>Description · Transaction</span>
                <span className="hidden w-20 text-right sm:block">When</span>
                <span className="w-20 text-right">Duration</span>
              </div>
              {q.data!.samples.map((s) => (
                <Link
                  key={s.spanId}
                  to={`/traces/${s.traceId}`}
                  className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 border-b border-border px-4 py-2 text-small last:border-0 hover:bg-surface-2"
                >
                  <span className="w-32 truncate font-mono text-accent">{s.op ?? 'span'}</span>
                  <span className="min-w-0 truncate">
                    <span className="text-text">{s.description ?? '—'}</span>
                    {s.transaction && <span className="text-text-faint"> · {s.transaction}</span>}
                  </span>
                  <span className="hidden w-20 text-right font-mono text-caption text-text-faint sm:block">
                    {s.startTs ? `${timeAgo(s.startTs)} ago` : '—'}
                  </span>
                  <span className="w-20 text-right font-mono text-text">{(s.durationMs ?? 0).toLocaleString()}ms</span>
                </Link>
              ))}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
