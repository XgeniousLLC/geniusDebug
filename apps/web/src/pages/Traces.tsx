import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, IdChip, EmptyState, Skeleton, ErrorState } from '../components/ui';

/** Web-vitals header (LCP/FCP/INP/CLS/TTFB) from transaction measurements (GD-136/143). */
const VITALS: { key: string; label: string; unit: 'ms' | 'score'; good: number; poor: number }[] = [
  { key: 'lcp', label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
  { key: 'fcp', label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
  { key: 'inp', label: 'INP', unit: 'ms', good: 200, poor: 500 },
  { key: 'cls', label: 'CLS', unit: 'score', good: 0.1, poor: 0.25 },
  { key: 'ttfb', label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
];
function WebVitals({ measurements }: { measurements?: Record<string, { value: number }> | null }) {
  if (!measurements) return null;
  const present = VITALS.filter((v) => measurements[v.key] != null);
  if (present.length === 0) return null;
  const TONE: Record<string, string> = {
    good: 'border-status-resolved/40 text-status-resolved',
    meh: 'border-level-warning/40 text-level-warning',
    poor: 'border-level-error/40 text-level-error',
  };
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {present.map((v) => {
        const raw = measurements[v.key].value;
        const tone = raw <= v.good ? 'good' : raw <= v.poor ? 'meh' : 'poor';
        const val = v.unit === 'ms' ? `${Math.round(raw)}ms` : raw.toFixed(2);
        return (
          <div key={v.key} className={`flex items-center gap-2 rounded-md border px-2.5 py-1 ${TONE[tone]}`}>
            <span className="text-caption font-semibold">{v.label}</span>
            <span className="font-mono text-small text-text">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Span detail side panel (GD-143) — op, duration vs avg, timing, status, attributes. */
function SpanPanel({ span, avg, onClose }: { span: Span; avg: number; onClose: () => void }) {
  const dur = span.durationMs ?? 0;
  const delta = avg > 0 ? Math.round(((dur - avg) / avg) * 100) : 0;
  const faster = delta < 0;
  const err = span.status && span.status !== 'ok';
  return (
    <Card className="h-fit p-4 lg:sticky lg:top-4">
      <div className="mb-2 flex items-center justify-between">
        <span className={`font-mono text-small ${err ? 'text-level-error' : 'text-accent'}`}>{span.op ?? 'span'}</span>
        <button onClick={onClose} className="text-text-faint hover:text-text" aria-label="Close">✕</button>
      </div>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-h1 font-semibold tabular-nums">{dur.toFixed(2)}ms</span>
        {avg > 0 && (
          <span className={`rounded-full px-2 py-0.5 text-caption ${faster ? 'bg-status-resolved/15 text-status-resolved' : 'bg-level-warning/15 text-level-warning'}`}>
            {Math.abs(delta)}% {faster ? 'faster' : 'slower'} than avg {avg.toFixed(2)}ms
          </span>
        )}
      </div>
      {span.description && (
        <div className="mb-3 rounded-md border border-border bg-bg px-3 py-2 font-mono text-caption text-text-muted">{span.description}</div>
      )}
      <Attr k="Span ID" v={span.span_id} mono />
      {span.parentSpanId && <Attr k="Parent" v={span.parentSpanId} mono />}
      <Attr k="Status" v={span.status ?? 'ok'} />
      <Attr k="Start" v={new Date(span.startTs).toLocaleTimeString()} />
      <Attr k="End" v={new Date(span.endTs).toLocaleTimeString()} />
    </Card>
  );
}
function Attr({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border py-1.5 text-caption first:border-0">
      <span className="text-text-faint">{k}</span>
      <span className={`truncate text-text ${mono ? 'font-mono' : ''}`}>{v}</span>
    </div>
  );
}

/** Flatten spans into a parent→child ordered tree with depth for indentation (GD-143). */
function buildSpanTree(spans: Span[]): { span: Span; depth: number }[] {
  const byParent = new Map<string | null, Span[]>();
  const ids = new Set(spans.map((s) => s.span_id));
  for (const s of spans) {
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(s);
  }
  const sortByStart = (a: Span, b: Span) => new Date(a.startTs).getTime() - new Date(b.startTs).getTime();
  const out: { span: Span; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of (byParent.get(parent) ?? []).sort(sortByStart)) {
      out.push({ span: s, depth });
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

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
  trace: {
    traceId: string;
    rootTransaction: string | null;
    platform: string;
    startTs: string;
    endTs: string;
    measurements?: Record<string, { value: number; unit?: string }> | null;
  } | null;
  spans: Span[];
  errors: { id: string; issueId: string; message: string | null; level: string }[];
  issues: { id: string; shortId: string; title: string }[];
}

export function Traces() {
  const { traceId } = useParams();
  if (!traceId) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <h1 className="mb-4 text-h1 font-semibold">Traces</h1>
        <EmptyState title="Open a trace from an issue" hint="Trace IDs on the Issue Detail → Highlights panel link here (FR-TRC-4)." />
      </div>
    );
  }
  return <TraceWaterfall traceId={traceId} />;
}

function TraceWaterfall({ traceId }: { traceId: string }) {
  const q = useQuery({
    queryKey: ['trace', traceId],
    queryFn: () => api<TraceResponse>(`/traces/${traceId}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [sel, setSel] = React.useState<Span | null>(null);
  const [search, setSearch] = React.useState('');

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (q.isError) return <div className="p-6"><ErrorState message="Couldn't load trace." /></div>;

  const spans = q.data?.spans ?? [];
  const t0 = spans.length ? Math.min(...spans.map((s) => new Date(s.startTs).getTime())) : 0;
  const t1 = spans.length ? Math.max(...spans.map((s) => new Date(s.endTs).getTime())) : 1;
  const span = t1 - t0 || 1;
  const tree = buildSpanTree(spans);
  const s = search.trim().toLowerCase();
  const visible = s ? tree.filter((n) => `${n.span.op ?? ''} ${n.span.description ?? ''}`.toLowerCase().includes(s)) : tree;
  // Average duration per op → "% faster/slower than avg" in the detail panel.
  const avgByOp = new Map<string, number>();
  {
    const acc = new Map<string, { sum: number; n: number }>();
    for (const sp of spans) {
      const k = sp.op ?? 'span';
      const a = acc.get(k) ?? { sum: 0, n: 0 };
      a.sum += sp.durationMs ?? 0;
      a.n += 1;
      acc.set(k, a);
    }
    for (const [k, a] of acc) avgByOp.set(k, a.n ? a.sum / a.n : 0);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
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

      <WebVitals measurements={q.data?.trace?.measurements} />

      {spans.length === 0 ? (
        (q.data?.errors.length ?? 0) > 0 ? (
          <Card className="p-4">
            <h2 className="mb-1 text-h2 font-semibold">Error in this trace</h2>
            <p className="mb-3 text-small text-text-muted">
              No performance spans — this trace carried an error but no `transaction` item (FR-TRC-1). Send transactions
              (set `tracesSampleRate` &gt; 0 in the SDK) to see the full waterfall.
            </p>
            <div className="flex flex-col gap-1">
              {q.data!.errors.map((e) => (
                <div key={e.id} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-small">
                  <span className={`h-2 w-2 rounded-full ${e.level === 'error' || e.level === 'fatal' ? 'bg-level-error' : 'bg-level-warning'}`} />
                  <span className="truncate text-text">{e.message ?? '(no message)'}</span>
                  <span className="ml-auto font-mono text-caption text-text-faint">{e.id.slice(0, 8)}</span>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <EmptyState title="No spans recorded" hint="Transactions arrive as `transaction` envelope items (FR-TRC-1)." />
        )
      ) : (
        <div className={`grid gap-4 ${sel ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'}`}>
          <div className="min-w-0">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search in trace (op or description)…"
              className="mb-2 h-8 w-full rounded-md border border-border bg-surface px-3 text-small text-text placeholder:text-text-faint"
            />
            <Card className="overflow-hidden p-0">
              {visible.map(({ span: sp, depth }, i) => {
                const left = ((new Date(sp.startTs).getTime() - t0) / span) * 100;
                const width = Math.max(((sp.durationMs ?? 1) / span) * 100, 0.5);
                const err = sp.status && sp.status !== 'ok';
                const active = sel?.span_id === sp.span_id;
                return (
                  <button
                    key={`${sp.span_id}-${i}`}
                    onClick={() => setSel(active ? null : sp)}
                    className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-1.5 text-left last:border-0 hover:bg-surface-2 ${active ? 'bg-surface-2' : ''}`}
                  >
                    <div className="flex min-w-0 items-center font-mono text-mono" style={{ paddingLeft: depth * 14 }}>
                      {depth > 0 && <span className="mr-1 text-text-faint">└</span>}
                      <span className={err ? 'text-level-error' : 'text-accent'}>{sp.op ?? 'span'}</span>
                      <span className="ml-1.5 truncate text-text-muted">{sp.description ?? ''}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="relative hidden h-4 w-40 rounded bg-surface-2 sm:block">
                        <div
                          className={`absolute top-0 h-4 rounded ${err ? 'bg-level-error' : 'bg-accent'}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono text-caption tabular-nums text-text-muted">{(sp.durationMs ?? 0).toFixed(2)}ms</span>
                    </div>
                  </button>
                );
              })}
              {visible.length === 0 && <div className="px-3 py-3 text-small text-text-faint">No spans match “{search}”.</div>}
            </Card>
          </div>

          {sel && <SpanPanel span={sel} avg={avgByOp.get(sel.op ?? 'span') ?? 0} onClose={() => setSel(null)} />}
        </div>
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
