import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, IdChip, EmptyState, Skeleton, ErrorState } from '../components/ui';

interface Span {
  span_id: string;
  parentSpanId: string | null;
  op: string | null;
  description: string | null;
  startTs: string;
  endTs: string;
  durationMs: number | null;
  status: string | null;
}
interface TraceResponse {
  trace: { traceId: string; rootTransaction: string | null; platform: string; startTs: string; endTs: string } | null;
  spans: Span[];
  errors: { id: string; issueId: string; message: string | null; level: string }[];
  issues: { id: string; shortId: string; title: string }[];
}

export function Traces() {
  const { traceId } = useParams();
  if (!traceId) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-5">
        <h1 className="mb-4 text-h1 font-semibold">Traces</h1>
        <EmptyState title="Open a trace from an issue" hint="Trace IDs on the Issue Detail → Highlights panel link here (FR-TRC-4)." />
      </div>
    );
  }
  return <TraceWaterfall traceId={traceId} />;
}

function TraceWaterfall({ traceId }: { traceId: string }) {
  const q = useQuery({ queryKey: ['trace', traceId], queryFn: () => api<TraceResponse>(`/traces/${traceId}`) });

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (q.isError) return <div className="p-6"><ErrorState message="Couldn't load trace." /></div>;

  const spans = q.data?.spans ?? [];
  const t0 = spans.length ? Math.min(...spans.map((s) => new Date(s.startTs).getTime())) : 0;
  const t1 = spans.length ? Math.max(...spans.map((s) => new Date(s.endTs).getTime())) : 1;
  const span = t1 - t0 || 1;

  return (
    <div className="mx-auto max-w-6xl px-6 py-5">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-caption text-text-faint">
        <Link to="/traces" className="hover:text-accent">Traces</Link>
        <span>/</span>
        <span className="text-text-muted">{traceId.slice(0, 12)}…</span>
      </div>
      <h1 className="mb-1 text-h1 font-semibold">Trace</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-small text-text-muted">
        <span>Frontend</span><span className="text-text-faint">·</span>
        <span>{q.data?.trace?.platform ?? 'javascript'}</span><span className="text-text-faint">·</span>
        <IdChip label="trace" value={traceId} />
        <span className="text-text-faint">·</span>
        <span>{q.data?.issues.length ?? 0} issue(s) in trace</span>
      </div>

      {spans.length === 0 ? (
        <EmptyState title="No spans recorded" hint="Transactions arrive as `transaction` envelope items (FR-TRC-1)." />
      ) : (
        <Card className="p-2">
          {spans.map((s) => {
            const left = ((new Date(s.startTs).getTime() - t0) / span) * 100;
            const width = Math.max(((s.durationMs ?? 1) / span) * 100, 1);
            const err = s.status && s.status !== 'ok';
            return (
              <div key={s.span_id} className="grid grid-cols-[240px_1fr] items-center gap-3 border-b border-border py-1.5 last:border-0">
                <div className="min-w-0 font-mono text-mono">
                  <span className="text-accent">{s.op ?? 'span'}</span>{' '}
                  <span className="truncate text-text-muted">{s.description ?? ''}</span>
                </div>
                <div className="relative h-5 rounded bg-surface-2">
                  <div
                    className={`absolute top-0 h-5 rounded ${err ? 'bg-level-error' : 'bg-accent'}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${s.durationMs ?? 0}ms`}
                  />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {(q.data?.issues.length ?? 0) > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-h2 font-semibold">Issues in this trace</h2>
          <div className="flex flex-col gap-1">
            {q.data!.issues.map((i) => (
              <Link key={i.id} to={`/issues/${i.shortId}`} className="rounded-md border border-border bg-surface px-3 py-2 text-small hover:bg-surface-2">
                <span className="font-mono text-text-faint">{i.shortId}</span> <span className="text-text">{i.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
