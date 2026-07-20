import * as React from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton, ErrorState } from '../components/ui';
import { timeAgo } from '../lib/format';

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

/** Span detail drawer (GD-143/152) — op, description, Duration/Status/Start (Image #6). */
function SpanPanel({ span, avg, t0, onClose }: { span: Span; avg: number; t0: number; onClose: () => void }) {
  const dur = span.durationMs ?? 0;
  const delta = avg > 0 ? Math.round(((dur - avg) / avg) * 100) : 0;
  const faster = delta < 0;
  const err = span.status && span.status !== 'ok';
  const startOffset = Math.round(new Date(span.startTs).getTime() - t0);
  return (
    <>
      {/* click-catcher (transparent) so clicking the waterfall closes the drawer */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-border bg-surface p-5 shadow-2xl">
        <div className="mb-1 flex items-center justify-between">
          <span className={`font-mono text-small ${err ? 'text-level-error' : 'text-text-muted'}`}>{span.op ?? 'span'}</span>
          <button onClick={onClose} className="text-text-faint hover:text-text" aria-label="Close">✕</button>
        </div>
        <div className="mb-4 break-words font-mono text-h2 font-semibold text-text">{span.description ?? span.op ?? 'span'}</div>

        <div className="overflow-hidden rounded-lg border border-border">
          <Attr k="Duration" v={`${Math.round(dur)} ms`} mono />
          <Attr k="Status" v={span.status ?? 'ok'} tone={err ? 'text-level-error' : 'text-status-resolved'} mono />
          <Attr k="Start" v={`+${startOffset} ms`} mono />
        </div>

        {avg > 0 && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-caption ${faster ? 'bg-status-resolved/10 text-status-resolved' : 'bg-level-warning/10 text-level-warning'}`}>
            {Math.abs(delta)}% {faster ? 'faster' : 'slower'} than the {span.op ?? 'span'} average ({Math.round(avg)} ms)
          </div>
        )}
      </aside>
    </>
  );
}
function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-text-faint">{k}:</span>
      <span className={`text-text ${mono ? 'font-mono' : ''}`}>{v}</span>
    </span>
  );
}
function Attr({ k, v, mono, tone }: { k: string; v: string; mono?: boolean; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 text-small last:border-0">
      <span className="text-text-muted">{k}</span>
      <span className={`truncate ${tone ?? 'text-text'} ${mono ? 'font-mono' : ''}`}>{v}</span>
    </div>
  );
}

/** Trace waterfall in a right-side sheet (opened from Performance — no navigation). */
export function TraceSheet({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-4xl overflow-y-auto border-l border-border bg-bg p-4 shadow-2xl sm:p-6">
        <div className="mb-2 flex justify-end">
          <button onClick={onClose} className="rounded-md border border-border bg-surface px-2.5 py-1 text-small text-text-muted hover:text-text" aria-label="Close">
            ✕ Close
          </button>
        </div>
        <TraceWaterfall traceId={traceId} embedded />
      </aside>
    </>
  );
}

/** Flatten spans into a parent→child ordered tree with depth for indentation (GD-143). */
function buildSpanTree(spans: Span[]): { span: Span; depth: number }[] {
  const byParent = new Map<string | null, Span[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const s of spans) {
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(s);
  }
  const sortByStart = (a: Span, b: Span) => new Date(a.startTs).getTime() - new Date(b.startTs).getTime();
  const out: { span: Span; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of (byParent.get(parent) ?? []).sort(sortByStart)) {
      out.push({ span: s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

interface Span {
  id: string;
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
  meta?: {
    platform: string;
    browser: string | null;
    os: string | null;
    environment: string | null;
    errorCount: number;
    leadMessage: string | null;
    leadTimestamp: string | null;
    transaction: string | null;
  };
}

const PLATFORM_LABEL: Record<string, string> = {
  javascript: 'Frontend (JavaScript)',
  'javascript-nextjs': 'Frontend (Next.js)',
  node: 'Backend (Node.js)',
  php: 'Backend (PHP)',
  python: 'Backend (Python)',
};

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

export function TraceWaterfall({ traceId, embedded }: { traceId: string; embedded?: boolean }) {
  const navigate = useNavigate();
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

  const meta = q.data?.meta;
  const totalMs = spans.length ? span : 0;
  const platformLabel = meta ? (PLATFORM_LABEL[meta.platform] ?? meta.platform) : null;

  return (
    <div className={embedded ? 'px-1' : 'mx-auto max-w-6xl px-4 py-5 sm:px-6'}>
      {!embedded && (
        <button onClick={() => navigate(-1)} className="mb-2 text-caption text-text-muted hover:text-accent">
          ← Back
        </button>
      )}
      {/* header */}
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <h1 className="flex items-baseline gap-2 text-h1 font-semibold">
          Trace <span className="font-mono text-body font-normal text-text-faint">{traceId.slice(0, 12)}</span>
        </h1>
      </div>
      {meta?.leadMessage && <p className="mb-2 truncate text-body text-level-error">{meta.leadMessage}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border pb-4 text-small text-text-muted">
        {platformLabel && <Meta k="Platform" v={platformLabel} />}
        {meta?.browser && <Meta k="Browser" v={meta.browser} />}
        {meta?.os && <Meta k="OS" v={meta.os} />}
        {meta?.environment && <Meta k="Env" v={meta.environment} mono />}
        {meta?.leadTimestamp && <Meta k="Age" v={timeAgo(meta.leadTimestamp)} />}
        {(meta?.errorCount ?? 0) > 0 && (
          <span className="text-level-error">
            {meta!.errorCount} error{meta!.errorCount > 1 ? 's' : ''} in trace
          </span>
        )}
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
        <>
        <div className="grid grid-cols-1 gap-4">
          <div className="min-w-0">
            {/* search + total duration */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search spans…"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-small text-text placeholder:text-text-faint sm:max-w-xs"
              />
              <span className="text-small text-text-muted">
                Total duration: <span className="font-mono text-text">{Math.round(totalMs).toLocaleString()} ms</span>
              </span>
            </div>

            <Card className="overflow-hidden p-0">
              {/* column header */}
              <div className="grid grid-cols-[minmax(180px,34%)_1fr] items-center gap-3 border-b border-border bg-surface px-4 py-2.5 text-caption uppercase tracking-wide text-text-faint">
                <span>Span</span>
                <span>Timeline (0 – {Math.round(totalMs).toLocaleString()} ms)</span>
              </div>
              {visible.map(({ span: sp, depth }, i) => {
                const left = ((new Date(sp.startTs).getTime() - t0) / span) * 100;
                const width = Math.max(((sp.durationMs ?? 1) / span) * 100, 0.6);
                const err = !!(sp.status && sp.status !== 'ok');
                const active = sel?.id === sp.id;
                return (
                  <button
                    key={`${sp.id}-${i}`}
                    onClick={() => setSel(active ? null : sp)}
                    className={`grid w-full grid-cols-[minmax(180px,34%)_1fr] items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-surface-2 ${
                      active ? 'bg-surface-2' : err ? 'bg-level-error/5' : ''
                    }`}
                  >
                    {/* span label */}
                    <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 18 }}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${err ? 'bg-level-error' : 'bg-accent'}`} aria-hidden />
                      <span className={`shrink-0 font-mono text-mono ${err ? 'text-level-error' : 'text-accent'}`}>{sp.op ?? 'span'}</span>
                      {sp.description && <span className="truncate font-mono text-mono text-text-muted">{sp.description}</span>}
                    </div>
                    {/* timeline: bar track + reserved label column (no overlap) */}
                    <div className="flex items-center gap-3">
                      <div className="relative h-5 min-w-0 flex-1">
                        <div
                          className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full ${err ? 'bg-level-error' : 'bg-accent'}`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        />
                        {err && (
                          <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-level-error" style={{ left: `${Math.min(left + width, 99)}%` }} aria-hidden />
                        )}
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono text-caption tabular-nums text-text-faint">
                        {Math.round(sp.durationMs ?? 0).toLocaleString()} ms
                      </span>
                    </div>
                  </button>
                );
              })}
              {visible.length === 0 && <div className="px-4 py-3 text-small text-text-faint">No spans match “{search}”.</div>}
            </Card>
          </div>

        </div>
        {sel && <SpanPanel span={sel} avg={avgByOp.get(sel.op ?? 'span') ?? 0} t0={t0} onClose={() => setSel(null)} />}
        </>
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
