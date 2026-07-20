import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton, ErrorState } from '../components/ui';
import { useUi } from '../store/ui';
import { TraceSheet } from './Traces';

interface OpAgg {
  op: string | null;
  count: number;
  totalMs: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  pctOfTotal: number;
}
interface SlowSpan {
  spanId: string;
  op: string | null;
  description: string | null;
  durationMs: number | null;
  status: string | null;
  traceId: string;
  transaction: string | null;
}
interface PerfResponse {
  range: string;
  totals: { p50: number; p75: number; p95: number; slowestMs: number; slowestLabel: string | null; samples: number; ops: number };
  overTime: { t: string; p75: number }[];
  overTimeDeltaPct: number;
  byOp: OpAgg[];
  hiddenOps: number;
  slowest: SlowSpan[];
  slowestTotal: number;
}
interface ProjectSummary { id: string; name: string }

type Range = '1h' | '24h' | '7d';
const RANGES: Range[] = ['1h', '24h', '7d'];
const RANGE_WORDS: Record<Range, string> = { '1h': 'last hour', '24h': 'last 24 hours', '7d': 'last 7 days' };
const RANGE_PRIOR: Record<Range, string> = { '1h': 'prior 1h', '24h': 'prior 24h', '7d': 'prior 7d' };

const fmtMs = (n: number | null | undefined) => {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${Math.round(v)}ms`;
};
// Severity band → text + bar color (Sentry-ish thresholds).
function band(ms: number): { text: string; bar: string } {
  if (ms >= 400) return { text: 'text-level-warning', bar: 'bg-level-warning' };
  if (ms >= 150) return { text: 'text-level-info', bar: 'bg-level-info' };
  return { text: 'text-status-resolved', bar: 'bg-status-resolved' };
}
const opLabel = (op: string | null) => op ?? 'span';

export function Performance() {
  const currentProjectId = useUi((s) => s.currentProjectId);
  const [range, setRange] = React.useState<Range>('24h');
  const [showAllSpans, setShowAllSpans] = React.useState(false);
  const [sheetTraceId, setSheetTraceId] = React.useState<string | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects') });
  const projectName = projects.data?.find((p) => p.id === currentProjectId)?.name;

  const q = useQuery({
    queryKey: ['performance', currentProjectId, range, showAllSpans],
    queryFn: () => {
      const p = new URLSearchParams({ range });
      if (currentProjectId) p.set('projectId', currentProjectId);
      if (showAllSpans) p.set('slowLimit', '1000');
      return api<PerfResponse>(`/performance?${p}`);
    },
  });

  const d = q.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      {/* header */}
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-h1 font-semibold">Performance</h1>
          <p className="mt-0.5 text-small text-text-muted">
            Where transaction time is spent — sampled from {d?.totals.samples ?? 0} spans across {d?.totals.ops ?? 0} operations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {projectName && <span className="rounded-full bg-surface px-2.5 py-1 text-caption text-text-muted">{projectName}</span>}
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md px-3 py-1 text-small ${range === r ? 'bg-accent text-white' : 'text-text-muted hover:text-text'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {q.isLoading ? (
        <Skeleton className="mt-4 h-96 w-full" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load performance data." />
      ) : !d || d.totals.samples === 0 ? (
        <EmptyState
          title="No span data yet"
          hint="Send `transaction` envelopes (set tracesSampleRate > 0 in your SDK) to populate the performance explorer."
        />
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {/* stat tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="P50 Latency" value={fmtMs(d.totals.p50)} sub="median span" tone={band(d.totals.p50).text} />
            <StatTile label="P75 Latency" value={fmtMs(d.totals.p75)} sub="75th percentile" tone={band(d.totals.p75).text} />
            <StatTile label="P95 Latency" value={fmtMs(d.totals.p95)} sub="95th percentile" tone={band(d.totals.p95).text} />
            <StatTile label="Slowest span" value={fmtMs(d.totals.slowestMs)} sub={d.totals.slowestLabel ?? '—'} tone={band(d.totals.slowestMs).text} />
          </div>

          {/* p75 over time */}
          <LatencyChart data={d.overTime} deltaPct={d.overTimeDeltaPct} range={range} />

          {/* where time is spent */}
          <WhereTimeSpent byOp={d.byOp} hiddenOps={d.hiddenOps} />

          {/* slowest spans */}
          <SlowestSpans
            slowest={d.slowest}
            total={d.slowestTotal}
            showingAll={showAllSpans}
            onToggleAll={() => setShowAllSpans((s) => !s)}
            onOpen={(id) => setSheetTraceId(id)}
          />
        </div>
      )}

      {sheetTraceId && <TraceSheet traceId={sheetTraceId} onClose={() => setSheetTraceId(null)} />}
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-caption uppercase tracking-wide text-text-faint">{label}</div>
      <div className={`mt-1 font-mono text-[26px] font-semibold leading-tight ${tone ?? 'text-text'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-caption text-text-muted">{sub}</div>}
    </Card>
  );
}

function LatencyChart({ data, deltaPct, range }: { data: { t: string; p75: number }[]; deltaPct: number; range: Range }) {
  const max = Math.max(1, ...data.map((x) => x.p75));
  // Nice round axis max.
  const axisMax = niceMax(max);
  const up = deltaPct > 0;
  const n = data.length;
  const label = (i: number) => {
    const dt = new Date(data[i].t);
    if (range === '7d') return dt.toLocaleDateString(undefined, { weekday: 'short' });
    return `${String(dt.getHours()).padStart(2, '0')}:00`;
  };
  const ticks = range === '7d' ? [0, 2, 4, 6] : [0, 6, 12, 18];
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-h2 font-semibold">p75 latency over time</h2>
          <span className="text-caption text-text-faint">{RANGE_WORDS[range]}</span>
        </div>
        {deltaPct !== 0 && (
          <span className={`text-caption font-medium ${up ? 'text-level-warning' : 'text-status-resolved'}`}>
            {up ? '↗' : '↘'} {up ? '+' : ''}{deltaPct}% vs. {RANGE_PRIOR[range]}
          </span>
        )}
      </div>
      <div className="flex gap-3">
        {/* y axis */}
        <div className="flex w-10 flex-col justify-between py-1 text-right text-[10px] text-text-faint">
          <span>{fmtMs(axisMax)}</span>
          <span>{fmtMs(axisMax / 2)}</span>
          <span>0</span>
        </div>
        {/* bars */}
        <div className="min-w-0 flex-1">
          <div className="flex h-32 items-end gap-1 border-b border-border">
            {data.map((b, i) => {
              const h = (b.p75 / axisMax) * 100;
              const recent = i >= n - 3;
              return (
                <div key={i} className="flex h-full flex-1 items-end" title={`${label(i)} · ${fmtMs(b.p75)}`}>
                  <div
                    className={`w-full rounded-t ${recent ? 'bg-level-warning' : 'bg-accent'}`}
                    style={{ height: `${Math.max(b.p75 > 0 ? 4 : 0, h)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-text-faint">
            {ticks.map((i) => (
              <span key={i}>{label(i)}</span>
            ))}
            <span>now</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function WhereTimeSpent({ byOp, hiddenOps }: { byOp: OpAgg[]; hiddenOps: number }) {
  const maxTotal = Math.max(1, ...byOp.map((o) => o.totalMs));
  const rows = byOp.slice(0, 10);
  const hidden = hiddenOps;
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-h2 font-semibold">Where time is spent</h2>
        <span className="text-caption text-text-faint">Bar = total time (count × avg) — the biggest optimization wins are at the top</span>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_3rem_3rem_3rem_3rem_3rem] items-center gap-2 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint sm:gap-3">
          <span>Operation · total time</span>
          <span className="text-right">P50</span>
          <span className="text-right">P75</span>
          <span className="hidden text-right sm:block">P90</span>
          <span className="text-right">P95</span>
          <span className="text-right">Count</span>
        </div>
        {rows.map((o, i) => {
          const b = band(o.p75);
          const w = (o.totalMs / maxTotal) * 100;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_3rem_3rem_3rem_3rem_3rem] items-center gap-2 border-b border-border px-4 py-2.5 last:border-0 sm:gap-3">
              <div className="min-w-0">
                <div className={`mb-1 truncate font-mono text-small ${b.text}`}>{opLabel(o.op)}</div>
                <div className="relative h-4 w-full overflow-hidden rounded bg-surface-2">
                  <div className={`h-full rounded ${b.bar}`} style={{ width: `${Math.max(2, w)}%` }} />
                  <span className="absolute inset-y-0 right-2 flex items-center gap-2 font-mono text-[11px] text-text">
                    <span className="text-text-muted">{fmtMs(o.totalMs)}</span>
                    <span className="text-text-faint">{o.pctOfTotal}%</span>
                  </span>
                </div>
              </div>
              <span className="text-right font-mono text-small text-text-muted">{fmtMs(o.p50)}</span>
              <span className="text-right font-mono text-small text-text">{fmtMs(o.p75)}</span>
              <span className="hidden text-right font-mono text-small text-text-muted sm:block">{fmtMs(o.p90)}</span>
              <span className="text-right font-mono text-small text-text-muted">{fmtMs(o.p95)}</span>
              <span className="text-right font-mono text-small text-text-muted">{o.count}</span>
            </div>
          );
        })}
        {hidden > 0 && (
          <div className="px-4 py-2 text-caption text-text-faint">+ {hidden} operations under 1 ms total not shown</div>
        )}
      </Card>
    </div>
  );
}

function SlowestSpans({
  slowest,
  total,
  showingAll,
  onToggleAll,
  onOpen,
}: {
  slowest: SlowSpan[];
  total: number;
  showingAll: boolean;
  onToggleAll: () => void;
  onOpen: (traceId: string) => void;
}) {
  const max = Math.max(1, ...slowest.map((s) => s.durationMs ?? 0));
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-h2 font-semibold">Slowest spans</h2>
        <span className="text-caption text-text-faint">
          {showingAll ? `All ${slowest.length}` : `Top ${slowest.length}`} · click a span to open its full trace waterfall
        </span>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[minmax(180px,40%)_1fr] items-center gap-3 border-b border-border bg-surface px-4 py-2 text-caption uppercase tracking-wide text-text-faint">
          <span>Span</span>
          <span>Timeline (0 – {fmtMs(max)})</span>
        </div>
        <div className={showingAll ? 'max-h-[32rem] overflow-y-auto' : ''}>
        {slowest.map((s) => {
          const dms = s.durationMs ?? 0;
          const b = band(dms);
          const w = (dms / max) * 100;
          return (
            <button
              key={s.spanId}
              onClick={() => onOpen(s.traceId)}
              className="grid w-full grid-cols-[minmax(180px,40%)_1fr] items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-surface-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-caption text-accent">{opLabel(s.op)}</span>
                <span className="truncate font-mono text-small text-text-muted">{s.description ?? s.transaction ?? ''}</span>
              </div>
              <div className="relative h-5">
                <div className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full ${b.bar}`} style={{ left: 0, width: `${Math.max(2, w)}%` }} />
                <span className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-caption text-text-faint" style={{ left: `calc(${Math.min(w, 88)}% + 8px)` }}>
                  {fmtMs(dms)}
                </span>
              </div>
            </button>
          );
        })}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-caption text-text-faint">
          <span>Showing {slowest.length} of {total} slow spans</span>
          {total > 10 && (
            <button onClick={onToggleAll} className="text-accent hover:underline">
              {showingAll ? 'Show top 10' : `Show all ${total} →`}
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 10) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}
