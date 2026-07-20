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
interface ProjectSummary {
  id: string;
  name: string;
}

/** Duration → severity band (Sentry-style thresholds). */
function band(ms: number): { label: string; text: string; bar: string } {
  if (ms >= 1000) return { label: 'poor', text: 'text-level-error', bar: 'bg-level-error' };
  if (ms >= 300) return { label: 'meh', text: 'text-level-warning', bar: 'bg-level-warning' };
  return { label: 'good', text: 'text-status-resolved', bar: 'bg-status-resolved' };
}

const fmtMs = (ms: number | null | undefined) => {
  const n = ms ?? 0;
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;
};

export function Performance() {
  const currentProjectId = useUi((s) => s.currentProjectId);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects') });
  const projectName = projects.data?.find((p) => p.id === currentProjectId)?.name;

  const q = useQuery({
    queryKey: ['performance', currentProjectId],
    queryFn: () =>
      api<PerfResponse>(`/performance${currentProjectId ? `?projectId=${currentProjectId}` : ''}`),
  });

  const samples = q.data?.samples ?? [];
  const byOp = q.data?.byOp ?? [];

  // Summary metrics.
  const slowest = samples[0]?.durationMs ?? 0;
  const worstOp = byOp[0];
  const maxP75 = Math.max(1, ...byOp.map((o) => o.p75Ms ?? 0)); // bar scale
  const maxSample = Math.max(1, ...samples.map((s) => s.durationMs ?? 0));

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-h1 font-semibold">Performance</h1>
        {projectName && (
          <span className="rounded-full bg-surface px-2.5 py-1 text-caption text-text-muted">
            {projectName}
          </span>
        )}
      </div>
      <p className="mb-4 text-small text-text-muted">
        Slowest spans and per-operation latency from your transaction traces.{' '}
        <span className="text-text-faint">p75 = 75% of spans were faster than this.</span>
      </p>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load performance data." />
      ) : samples.length === 0 ? (
        <EmptyState
          title="No span data yet"
          hint="Send `transaction` envelopes (set tracesSampleRate > 0 in your SDK) to populate the performance explorer."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Summary tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Spans sampled" value={samples.length.toString()} />
            <StatTile label="Operations" value={byOp.length.toString()} />
            <StatTile label="Slowest span" value={fmtMs(slowest)} tone={band(slowest).text} />
            <StatTile label="Worst op (p75)" value={fmtMs(worstOp?.p75Ms)} sub={worstOp?.op ?? '—'} tone={band(worstOp?.p75Ms ?? 0).text} />
          </div>

          {/* Per-op latency — visual bars */}
          <div>
            <h2 className="mb-1 text-h2 font-semibold">Latency by operation</h2>
            <p className="mb-2 text-caption text-text-faint">Bar = p75 duration, relative to the slowest op. Color grades good / meh / poor.</p>
            <Card className="overflow-hidden">
              <div className="hidden grid-cols-[minmax(0,1fr)_5rem_4rem_4rem] gap-4 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint sm:grid">
                <span>Operation · p75</span>
                <span className="text-right">Count</span>
                <span className="text-right">Avg</span>
                <span className="text-right">Max</span>
              </div>
              {byOp.map((o, i) => {
                const p75 = o.p75Ms ?? 0;
                const b = band(p75);
                return (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_5rem_4rem_4rem] items-center gap-4 border-b border-border px-4 py-2.5 last:border-0">
                    <div className="min-w-0">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-small text-accent">{o.op ?? 'span'}</span>
                        <span className={`shrink-0 font-mono text-small font-medium ${b.text}`}>{fmtMs(p75)}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div className={`h-full rounded-full ${b.bar}`} style={{ width: `${Math.max(3, (p75 / maxP75) * 100)}%` }} />
                      </div>
                    </div>
                    <span className="text-right font-mono text-small text-text-muted">{o.count}</span>
                    <span className="text-right font-mono text-small text-text-faint">{fmtMs(o.avgMs)}</span>
                    <span className="text-right font-mono text-small text-text-faint">{fmtMs(o.maxMs)}</span>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* Slowest span samples */}
          <div>
            <h2 className="mb-1 text-h2 font-semibold">Slowest spans</h2>
            <p className="mb-2 text-caption text-text-faint">Individual worst spans — click to open the full trace waterfall.</p>
            <Card className="overflow-hidden">
              {samples.map((s) => {
                const d = s.durationMs ?? 0;
                const b = band(d);
                return (
                  <Link
                    key={s.spanId}
                    to={`/traces/${s.traceId}`}
                    className="block border-b border-border px-4 py-2.5 last:border-0 hover:bg-surface-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-caption text-accent">{s.op ?? 'span'}</span>
                        <span className="truncate text-small text-text">{s.description ?? s.transaction ?? '—'}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="hidden font-mono text-caption text-text-faint sm:inline">{s.startTs ? `${timeAgo(s.startTs)} ago` : ''}</span>
                        <span className={`font-mono text-small font-medium ${b.text}`}>{fmtMs(d)}</span>
                      </div>
                    </div>
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className={`h-full rounded-full ${b.bar}`} style={{ width: `${Math.max(2, (d / maxSample) * 100)}%` }} />
                    </div>
                    {s.transaction && s.description && (
                      <div className="mt-1 truncate text-caption text-text-faint">{s.transaction}</div>
                    )}
                  </Link>
                );
              })}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-caption uppercase tracking-wide text-text-faint">{label}</div>
      <div className={`mt-1 font-mono text-h2 font-semibold ${tone ?? 'text-text'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-caption text-text-muted">{sub}</div>}
    </Card>
  );
}
