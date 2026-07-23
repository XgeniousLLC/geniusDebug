import * as React from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import 'rrweb/dist/style.css';
import { api, errMsg } from '../lib/api';
import { Card, Skeleton, ErrorState } from '../components/ui';
import { PlayIcon, PauseIcon, FullscreenIcon, ActivityIcon, TerminalIcon, GlobeIcon, AlertTriangleIcon } from '../components/icons';
import { timeAgo } from '../lib/format';
import { toast } from '../store/toast';

// Warm the rrweb chunk as soon as this module evaluates (app load), not on
// first mount — avoids the brief white flash while `import('rrweb')` resolves
// the first time a user opens a replay (GD-170).
void import('rrweb');

interface Replay {
  id: string;
  issueId: string | null;
  traceId: string | null;
  user: Record<string, unknown> | null;
  contexts: { browser?: { name?: string; version?: string }; os?: { name?: string; version?: string }; device?: { family?: string; model?: string; brand?: string } } | null;
  url: string | null;
  startedAt: string | null;
  durationMs: number | null;
  segmentCount: number;
  createdAt: string;
}
interface Recording {
  events: unknown[];
  reason?: string;
}

/**
 * Replay player (brief §10 / FR-RPL-5/6): real rrweb DOM playback assembled from
 * the R2 recording blob. Falls back to a masked placeholder when no blob is
 * available (inline-only replay, or R2 unconfigured) so the page never breaks.
 */
export function ReplayPlayer() {
  const { replayId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const seekRef = React.useRef<((ms: number) => void) | undefined>(undefined);
  const [currentMs, setCurrentMs] = React.useState(0);

  const del = useMutation({
    mutationFn: () => api(`/replays/${replayId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['replays'] });
      toast.success('Replay deleted');
      navigate('/replays');
    },
    onError: (e: unknown) => toast.error(`Couldn't delete: ${errMsg(e)}`),
  });
  function doDelete() {
    if (!window.confirm('Permanently delete this replay session? This removes all recorded segments and cannot be undone.')) return;
    del.mutate();
  }

  const q = useQuery({ queryKey: ['replay', replayId], queryFn: () => api<Replay | null>(`/replays/${replayId}`) });
  const rec = useQuery({
    queryKey: ['replay-rec', replayId],
    queryFn: () => api<Recording>(`/replays/${replayId}/recording`),
    enabled: !!q.data,
    retry: false,
  });
  const events = rec.data?.events ?? [];
  // First navigation breadcrumb captured in the recording is the most reliable
  // "page URL" — request.url on the replay_event only reflects the URL at the
  // moment that segment fired, not necessarily the session's start page. Hook
  // must run unconditionally (before the loading/error early-returns below) —
  // calling it after them broke rules-of-hooks (hook count changed once q.data
  // resolved) and crashed the whole page blank.
  const firstNav = React.useMemo(() => extractActivity(events).find((a) => a.kind === 'navigation'), [events]);

  if (q.isLoading) return <ReplayPlayerSkeleton />;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState message="Replay not found." /></div>;

  const r = q.data;
  const canPlay = events.length >= 2; // rrweb needs a full snapshot + ≥1 increment
  // Dead-click / rage-click counts from Sentry's slow/multi-click breadcrumbs (GD-145).
  const clickStats = extractActivity(events).reduce(
    (acc, a) => {
      if (/slowclick|deadclick/i.test(a.category)) acc.dead++;
      if (/multiclick|rageclick/i.test(a.category)) acc.rage++;
      return acc;
    },
    { dead: 0, rage: 0 },
  );
  const pageUrl = r.url ?? firstNav?.message ?? null;
  const browser = r.contexts?.browser;
  const os = r.contexts?.os;
  const device = r.contexts?.device;

  return (
    <div className="w-full px-4 py-5 sm:px-6">
      <div className="mb-3 flex items-center gap-1.5 font-mono text-caption text-text-faint">
        <Link to="/replays" className="hover:text-accent">Replays</Link>
        <span>/</span>
        <span className="text-text-muted">{r.id.slice(0, 12)}…</span>
      </div>
      <h1 className="mb-3 text-h1 font-semibold">Session Replay</h1>

      {/* Top metadata bar — stays visible during playback (GD-170). */}
      <Card className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-small">
        {pageUrl && (
          <span className="max-w-md truncate font-mono text-caption text-text" title={pageUrl}>{pageUrl}</span>
        )}
        <MetaChip label="User" value={String((r.user as { username?: string; id?: string })?.username ?? 'anonymous')} />
        {browser?.name && <MetaChip label="Browser" value={`${browser.name}${browser.version ? ` ${browser.version}` : ''}`} />}
        {os?.name && <MetaChip label="OS" value={`${os.name}${os.version ? ` ${os.version}` : ''}`} />}
        {(device?.family || device?.model) && <MetaChip label="Device" value={device.family ?? device.model ?? ''} />}
        <MetaChip label="Started" value={`${timeAgo(r.startedAt ?? r.createdAt)} ago`} />
        <MetaChip label="Duration" value={`${((r.durationMs ?? 0) / 1000).toFixed(1)}s`} />
        {r.traceId && (
          <Link to={`/traces/${r.traceId}`} className="text-caption text-accent hover:underline">
            Open trace →
          </Link>
        )}
        <button
          onClick={doDelete}
          disabled={del.isPending}
          className="ml-auto rounded-md border border-level-error/40 px-2.5 py-1 text-caption font-medium text-level-error hover:bg-level-error/10 disabled:opacity-50"
        >
          Delete replay
        </button>
      </Card>

      {/* Left 75% — stable player only. Right 25% — synced chronological activity (GD-170). */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(300px,1fr)] lg:items-start">
        <div className="min-w-0">
          {rec.isLoading ? (
            <Card className="aspect-video"><Skeleton className="h-full w-full" /></Card>
          ) : canPlay ? (
            <RrwebCanvas events={events} durationMs={r.durationMs} seekRef={seekRef} onTime={setCurrentMs} />
          ) : (
            <PlaceholderCanvas reason={rec.data?.reason} />
          )}
        </div>

        {/* Right rail: AI summary + meta + synced activity timeline */}
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-180px)]">
          {canPlay && <AISummary events={events} />}
          <Card className="h-fit p-4">
            <div className="mb-2 text-h2 font-semibold">Meta</div>
            <Row k="Segments" v={String(r.segmentCount)} />
            <Row k="Events" v={String(events.length)} />
            {clickStats.dead > 0 && <Row k="Dead clicks" v={String(clickStats.dead)} />}
            {clickStats.rage > 0 && <Row k="Rage clicks" v={String(clickStats.rage)} />}
            <Row k="Captured" v={`${timeAgo(r.createdAt)} ago`} />
          </Card>
          {/* Console / Network / Errors breakdown, click-to-seek + synced highlight (GD-145/156/170) */}
          {canPlay && (
            <ActivityPanel
              events={events}
              onSeek={(ms) => seekRef.current?.(ms)}
              activeT={currentMs}
              className="mt-0 lg:min-h-0 lg:flex-1"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shaped skeleton matching the real layout regions (breadcrumb/title/meta bar/
 * video+transport/right-rail cards) instead of one flat block — keeps the page
 * from jumping around once data lands. */
function ReplayPlayerSkeleton() {
  return (
    <div className="w-full px-4 py-5 sm:px-6">
      <Skeleton className="mb-3 h-4 w-32" />
      <Skeleton className="mb-3 h-7 w-48" />

      <Card className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto h-7 w-24" />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(300px,1fr)] lg:items-start">
        <div className="min-w-0">
          <Card className="aspect-video"><Skeleton className="h-full w-full" /></Card>
          <div className="mt-3 flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-2 flex-1 rounded-full" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="h-fit p-4">
            <Skeleton className="mb-2 h-5 w-32" />
            <Skeleton className="h-16 w-full" />
          </Card>
          <Card className="h-fit p-4">
            <Skeleton className="mb-3 h-5 w-16" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="mb-2 flex items-center justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </Card>
          <Card className="h-fit p-4">
            <div className="mb-3 flex gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-6 rounded-md" />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 text-caption text-text-muted">
      <span className="text-text-faint">{label}</span>
      <span className="font-mono text-text">{value}</span>
    </span>
  );
}

/**
 * Embeddable replay: fetches the recording for a replayId and renders the player
 * (or a masked placeholder). Reused by the Issue Detail "Replays in this issue"
 * section so the same rrweb player powers both places (GD-132).
 */
export function ReplayViewer({ replayId, durationMs }: { replayId: string; durationMs: number | null }) {
  const rec = useQuery({
    queryKey: ['replay-rec', replayId],
    queryFn: () => api<Recording>(`/replays/${replayId}/recording`),
    retry: false,
  });
  if (rec.isLoading) return <Card className="aspect-video"><Skeleton className="h-full w-full" /></Card>;
  const events = rec.data?.events ?? [];
  return events.length >= 2 ? (
    <RrwebCanvas events={events} durationMs={durationMs} />
  ) : (
    <PlaceholderCanvas reason={rec.data?.reason} />
  );
}

interface Marker {
  pct: number; // 0..1 position on the timeline
  color: string; // css color
  label: string;
}

// Icon-only tabs (label kept for the title/aria tooltip) — the right rail is
// narrow (75/25 split, GD-170) and text labels clipped ("Errors" → "E").
const ACT_TABS: { key: 'all' | ActKind; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'all', label: 'Activity', icon: ActivityIcon },
  { key: 'console', label: 'Console', icon: TerminalIcon },
  { key: 'network', label: 'Network', icon: GlobeIcon },
  { key: 'error', label: 'Errors', icon: AlertTriangleIcon },
];
const ACT_COLOR: Record<ActKind, string> = {
  console: '#7c6cff',
  network: '#22c55e',
  navigation: '#0ea5e9',
  click: '#f59e0b',
  error: 'var(--level-error, #ef4444)',
  other: '#9ca3af',
};

/** AI session summary (GD-145) — DeepSeek narrative + steps from the activity log. */
function AISummary({ events }: { events: unknown[] }) {
  const lines = React.useMemo(() => {
    const acts = extractActivity(events);
    return acts.map((a) => `[${Math.round(a.t / 1000)}s] ${a.kind}/${a.category}: ${a.message}`.slice(0, 200));
  }, [events]);
  const gen = useMutation({
    mutationFn: () =>
      api<{ summary: string | null; steps: { time: string; text: string }[]; reason?: string }>('/replays/summary', {
        method: 'POST',
        body: JSON.stringify({ lines }),
      }),
  });
  if (lines.length === 0) return null;
  const d = gen.data;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-h2 font-semibold">AI Summary</div>
        <button
          onClick={() => gen.mutate()}
          disabled={gen.isPending}
          className="rounded-md border border-border px-2 py-0.5 text-caption text-text-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {gen.isPending ? 'Summarizing…' : d ? 'Regenerate' : 'Summarize'}
        </button>
      </div>
      {!d && !gen.isPending && (
        <p className="text-small text-text-muted">Generate a narrative of this session from its activity log.</p>
      )}
      {d?.summary && <p className="mb-3 text-small text-text">{d.summary}</p>}
      {d?.reason && !d.summary && <p className="text-small text-level-warning">{d.reason}</p>}
      {(d?.steps?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1.5">
          {d!.steps.map((s, i) => (
            <div key={i} className="flex items-baseline gap-2 text-small">
              <span className="shrink-0 font-mono text-caption text-accent">{s.time}</span>
              <span className="text-text-muted">{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const fmtActT = (ms: number) => `${Math.floor(ms / 1000)}:${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
function statusColor(code?: number): string {
  if (code == null) return 'text-text-muted';
  if (code >= 500) return 'text-level-error';
  if (code >= 400) return 'text-level-warning';
  if (code >= 300) return 'text-level-info';
  return 'text-status-resolved';
}
const fmtDur = (ms?: number) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

/** Console/Network/Errors breakdown — Sentry-style tabs, click-to-seek (GD-145/156). */
function ActivityPanel({
  events,
  onSeek,
  activeT,
  className = 'mt-4',
}: {
  events: unknown[];
  onSeek?: (ms: number) => void;
  activeT?: number;
  className?: string;
}) {
  const acts = React.useMemo(() => extractActivity(events), [events]);
  const [tab, setTab] = React.useState<'all' | ActKind>('all');
  if (acts.length === 0) return null;
  const shown = tab === 'all' ? acts : acts.filter((a) => a.kind === tab);
  const count = (k: 'all' | ActKind) => (k === 'all' ? acts.length : acts.filter((a) => a.kind === k).length);
  // The most recent activity at-or-before the current playhead — highlighted
  // in sync with playback (GD-170: "related events should automatically highlight").
  let activeIdx = -1;
  if (activeT != null) {
    for (let i = 0; i < shown.length; i++) {
      if (shown[i].t <= activeT) activeIdx = i;
      else break;
    }
  }
  return (
    <Card className={`${className} flex min-h-0 flex-1 flex-col overflow-hidden p-0`}>
      <div className="flex gap-1 border-b border-border px-2 pt-2">
        {ACT_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={t.label}
            aria-label={t.label}
            className={`-mb-px flex shrink-0 items-center gap-1 rounded-t-md px-2 pb-2 text-small ${
              tab === t.key ? 'border-b-2 border-accent text-text' : 'border-b-2 border-transparent text-text-muted hover:text-text'
            }`}
          >
            <t.icon size={15} />
            <span className="rounded-full bg-surface-2 px-1.5 text-caption text-text-muted">{count(t.key)}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <div className="px-4 py-3 text-small text-text-faint">Nothing here.</div>}
        {tab === 'network' ? (
          <NetworkWaterfall items={shown} onSeek={onSeek} />
        ) : (
          shown.map((a, i) => (
            <button
              key={i}
              onClick={() => onSeek?.(a.t)}
              title="Jump to this moment in the replay"
              className={`flex w-full items-start gap-3 border-b border-border px-4 py-1.5 text-left text-small last:border-0 hover:bg-surface-2 ${
                i === activeIdx ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : ''
              }`}
            >
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: ACT_COLOR[a.kind] }} />
              <span className="w-10 shrink-0 font-mono text-caption text-accent">{fmtActT(a.t)}</span>
              {a.method && <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-text-muted">{a.method}</span>}
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-text-muted">{a.category}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-mono text-text">{a.message}</span>
              {a.statusCode != null && <span className={`shrink-0 font-mono text-caption ${statusColor(a.statusCode)}`}>{a.statusCode}</span>}
              {a.durationMs != null && <span className="shrink-0 font-mono text-caption text-text-faint">{fmtDur(a.durationMs)}</span>}
            </button>
          ))
        )}
      </div>
    </Card>
  );
}

/** Network requests as a timing waterfall (GD-156) — bar positioned/scaled by time. */
function NetworkWaterfall({ items, onSeek }: { items: Activity[]; onSeek?: (ms: number) => void }) {
  if (items.length === 0) return <div className="px-4 py-3 text-small text-text-faint">No network activity.</div>;
  const minT = Math.min(...items.map((a) => a.t));
  const maxEnd = Math.max(...items.map((a) => a.t + (a.durationMs ?? 0)));
  const span = Math.max(1, maxEnd - minT);
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_1fr] items-center gap-3 border-b border-border bg-surface px-4 py-1.5 text-caption uppercase tracking-wide text-text-faint">
        <span>Request</span>
        <span>Timeline ({fmtDur(span)})</span>
      </div>
      {items.map((a, i) => {
        const left = ((a.t - minT) / span) * 100;
        const width = Math.max(1.5, ((a.durationMs ?? 0) / span) * 100);
        return (
          <button
            key={i}
            onClick={() => onSeek?.(a.t)}
            title="Jump to this request in the replay"
            className="grid w-full grid-cols-[minmax(0,1fr)_1fr] items-center gap-3 border-b border-border px-4 py-2 text-left text-small last:border-0 hover:bg-surface-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              {a.method && <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-text-muted">{a.method}</span>}
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-accent">{a.category}</span>
              <span className="min-w-0 truncate font-mono text-mono text-text-muted">{a.message}</span>
            </div>
            <div className="relative h-5">
              <div className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-status-resolved" style={{ left: `${left}%`, width: `${width}%` }} />
              <span className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-caption text-text-faint" style={{ left: `calc(${Math.min(left + width, 82)}% + 6px)` }}>
                {a.statusCode != null && <span className={statusColor(a.statusCode)}>{a.statusCode} </span>}
                {fmtDur(a.durationMs)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Classify an rrweb custom/breadcrumb event into a colored timeline marker. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markerFor(e: any): { color: string; label: string } | null {
  if (e?.type !== 5) return null; // only custom/breadcrumb events get a dot
  const payload = e.data?.payload ?? {};
  const level = String(payload.level ?? '').toLowerCase();
  const cat = String(payload.category ?? e.data?.tag ?? '').toLowerCase();
  if (level === 'error' || level === 'fatal' || /error|exception/.test(cat))
    return { color: 'var(--level-error, #ef4444)', label: cat || 'error' };
  if (level === 'warning' || /warn/.test(cat)) return { color: '#f59e0b', label: cat || 'warning' };
  if (/click|ui\.|navigation|route/.test(cat)) return { color: '#22c55e', label: cat || 'interaction' };
  return { color: 'var(--accent, #7c6cff)', label: cat || 'event' };
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Renders the recording with rrweb's low-level `Replayer` (imported lazily).
 * We deliberately do NOT use `rrweb-player` (the Svelte wrapper): under Vite's
 * dep pre-bundling it renders only its outer shell — no iframe, no error — so
 * playback was blank. `Replayer` builds the iframe directly and is reliable. We
 * add our own transport: play/pause, a draggable scrubber with event markers,
 * time readout and fullscreen (GD-129/130).
 */
/**
 * Sentry replay events arrive with MIXED timestamp units — some in milliseconds
 * (~1.78e12) and some in seconds (~1.78e9). rrweb needs them all in ms and sorted,
 * otherwise it computes a ~1.78-trillion-ms timeline and schedules the real events
 * outside the played window → only the FullSnapshot renders, no increments cast
 * (looked like a frozen still, GD-141). Normalise seconds→ms and sort.
 */
function normalizeEvents(events: unknown[]): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (events as any[])
    .map((e) =>
      e && typeof e.timestamp === 'number' && e.timestamp < 1e12
        ? { ...e, timestamp: Math.round(e.timestamp * 1000) }
        : e,
    )
    .sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
}

type ActKind = 'console' | 'network' | 'navigation' | 'click' | 'error' | 'other';
interface Activity {
  t: number; // ms offset from replay start
  kind: ActKind;
  category: string;
  message: string;
  level?: string;
  durationMs?: number; // network spans
  statusCode?: number; // network requests
  method?: string; // network requests
}

/** Extract Console / Network / Navigation / Clicks / Errors from the replay's breadcrumb events (GD-145). */
function extractActivity(rawEvents: unknown[]): Activity[] {
  const evs = normalizeEvents(rawEvents) as { type?: number; timestamp?: number; data?: Record<string, unknown> }[];
  if (evs.length === 0) return [];
  const baseline = evs.find((e) => e.type === 4 || e.type === 2)?.timestamp ?? evs[0].timestamp ?? 0;
  const out: Activity[] = [];
  for (const e of evs) {
    if (e.type !== 5) continue; // custom/breadcrumb events
    const d = e.data ?? {};
    const t = Math.max(0, (e.timestamp ?? 0) - baseline);
    if (d.tag === 'breadcrumb') {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      const cat = String(p.category ?? '');
      const level = p.level as string | undefined;
      let kind: ActKind = 'other';
      if (/console/.test(cat)) kind = 'console';
      else if (/fetch|xhr|http|request/.test(cat)) kind = 'network';
      else if (/navigation|route|pageload/.test(cat)) kind = 'navigation';
      else if (level === 'error' || level === 'fatal' || /error|exception/.test(cat)) kind = 'error';
      else if (/click|ui\.|input|press/.test(cat)) kind = 'click';
      const data = (p.data ?? {}) as Record<string, unknown>;
      const method = typeof data.method === 'string' ? data.method : undefined;
      const statusCode = typeof data.status_code === 'number' ? data.status_code : undefined;
      const url = typeof data.url === 'string' ? data.url : undefined;
      const msg = String(p.message ?? url ?? (p.data ? JSON.stringify(p.data) : ''));
      out.push({ t, kind, category: cat || kind, message: msg, level, method, statusCode });
    } else if (d.tag === 'performanceSpan') {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      const startS = Number(p.startTimestamp);
      const endS = Number(p.endTimestamp);
      const durationMs = Number.isFinite(startS) && Number.isFinite(endS) ? Math.max(0, (endS - startS) * 1000) : undefined;
      const op = String(p.op ?? 'resource');
      const data = (p.data ?? {}) as Record<string, unknown>;
      const statusCode = typeof data['http.response.status_code'] === 'number' ? (data['http.response.status_code'] as number) : undefined;
      // Only true resource/http spans belong on the Network waterfall.
      const kind: ActKind = /resource|http|fetch|xhr/.test(op) ? 'network' : 'other';
      out.push({ t, kind, category: op, message: String(p.description ?? ''), durationMs, statusCode });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function RrwebCanvas({
  events: rawEvents,
  durationMs,
  seekRef,
  onTime,
}: {
  events: unknown[];
  durationMs: number | null;
  seekRef?: React.MutableRefObject<((ms: number) => void) | undefined>;
  onTime?: (ms: number) => void;
}) {
  const events = React.useMemo(() => normalizeEvents(rawEvents), [rawEvents]);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const barRef = React.useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replayer = React.useRef<any>(null);
  const rafRef = React.useRef<number>(0);
  const [failed, setFailed] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState(1);
  const [cur, setCur] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [isFs, setIsFs] = React.useState(false);

  // Timeline markers (memoized) from the event stream.
  // Playback window: baseline = the FullSnapshot/Meta timestamp (rrweb's start),
  // duration = span to the last event. Robust against outlier timestamps (a stray
  // seconds-scale event would otherwise blow up min/max) and matches rrweb's own
  // getCurrentTime()/finish timing better than the DB durationMs (GD-131).
  const { baseline, duration } = React.useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evs = events as any[];
    const ts = evs.map((e) => e.timestamp).filter((n) => typeof n === 'number');
    if (!ts.length) return { baseline: 0, duration: durationMs ?? 0 };
    const metaTs = evs.find((e) => e?.type === 4 || e?.type === 2)?.timestamp ?? Math.min(...ts);
    const end = Math.max(...ts.filter((t) => t >= metaTs), metaTs);
    return { baseline: metaTs, duration: Math.max(end - metaTs, durationMs ?? 0) };
  }, [events, durationMs]);

  const markers = React.useMemo<Marker[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evs = events as any[];
    if (evs.length < 2 || duration <= 0) return [];
    const out: Marker[] = [];
    for (const e of evs) {
      const m = markerFor(e);
      if (!m) continue;
      const pct = (e.timestamp - baseline) / duration;
      if (pct < -0.02 || pct > 1.02) continue; // drop off-window outliers
      out.push({ pct: Math.min(1, Math.max(0, pct)), ...m });
    }
    return out;
  }, [events, baseline, duration]);

  const lastFitH = React.useRef(0);
  const fit = React.useCallback(() => {
    const root = stageRef.current;
    if (!root) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (events as any[]).find((e) => e?.type === 4)?.data ?? {};
    const recW = meta.width || 1024;
    const recH = meta.height || 600;
    const wrap = root.querySelector('.replayer-wrapper') as HTMLElement | null;
    if (!wrap) return;
    const iframe = wrap.querySelector('iframe') as HTMLIFrameElement | null;
    // Show the WHOLE recorded page (not just the viewport) so below-the-fold
    // interactions — long forms, scrolled content — are visible without relying
    // on rrweb to replay scroll, which it doesn't always do (GD-133). Size the
    // iframe/wrapper to the full document height, then scale to fit our width.
    const contentH = Math.max(iframe?.contentDocument?.documentElement?.scrollHeight ?? 0, recH);
    // Skip re-applying transform/height for negligible height churn. The
    // replayed page's scrollHeight settles over several ticks as fonts/images
    // load and rrweb replays mutation events, and each re-scale was visibly
    // jumping/blinking the whole player (GD-170) — worse, writing root.style
    // re-triggers the ResizeObserver watching that same element, which could
    // re-fire fit() again. A dead-band breaks that loop.
    if (Math.abs(contentH - lastFitH.current) < 4) return;
    lastFitH.current = contentH;
    if (iframe) iframe.style.height = `${contentH}px`;
    wrap.style.height = `${contentH}px`;
    // Fit within the container width AND a max stage height so the whole page is
    // visible but the transport controls stay in view (GD-133).
    const MAX_H = 560;
    const scale = Math.min(1, (root.clientWidth || recW) / recW, MAX_H / contentH);
    wrap.style.transform = `scale(${scale})`;
    wrap.style.transformOrigin = 'top left';
    root.style.height = `${Math.round(contentH * scale)}px`;
    // Centre horizontally when height-capped leaves side gutters.
    root.style.width = '100%';
  }, [events]);

  const stopTick = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };
  const startTick = React.useCallback(() => {
    stopTick();
    const loop = () => {
      const r = replayer.current;
      if (!r) return;
      const raw = typeof r.getCurrentTime === 'function' ? r.getCurrentTime() : 0;
      // Our computed duration is authoritative (rrweb's timeline can trail past the
      // last real event). Stop cleanly at the end — no loop (GD-131).
      if (duration > 0 && raw >= duration - 4) {
        setCur(duration);
        try {
          r.pause?.();
        } catch {
          /* ignore */
        }
        setPlaying(false);
        stopTick();
        return;
      }
      const t = duration > 0 ? Math.min(raw, duration) : raw;
      setCur((prev) => (Math.abs(prev - t) > 8 ? t : prev));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [duration]);

  React.useEffect(() => {
    let cancelled = false;
    let fitIv = 0;
    const el = stageRef.current;
    if (!el) return;
    el.innerHTML = '';
    (async () => {
      try {
        const { Replayer } = await import('rrweb');
        if (cancelled || !stageRef.current) return;
        const r = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
          root: stageRef.current,
          skipInactive: false,
          showWarning: false,
          mouseTail: { strokeStyle: 'var(--accent, #7c6cff)' }, // show cursor path
        });
        replayer.current = r;
        setTotal(duration);
        r.on?.('finish', () => {
          // Stop at the end — do NOT loop. Pin the playhead to the end; the user
          // replays from the start by clicking Play (GD-131).
          stopTick();
          setPlaying(false);
          setCur(duration);
        });
        // Render the first frame but stay paused — no autoplay (GD-131).
        try {
          r.pause(0);
        } catch {
          r.play(0);
          r.pause();
        }
        setPlaying(false);
        fit();
        // Re-fit as the replayed DOM mutates (page grows/shrinks during playback).
        fitIv = window.setInterval(fit, 500);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (fitIv) clearInterval(fitIv);
      stopTick();
      try {
        replayer.current?.pause?.();
        replayer.current?.destroy?.();
      } catch {
        /* ignore */
      }
      replayer.current = null;
      if (el) el.innerHTML = '';
    };
  }, [events, fit, startTick]);

  // Re-fit on container resize + fullscreen changes.
  React.useEffect(() => {
    const ro = new ResizeObserver(() => fit());
    if (stageRef.current) ro.observe(stageRef.current);
    const onFs = () => {
      setIsFs(!!document.fullscreenElement);
      setTimeout(fit, 50);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [fit]);

  const toggle = () => {
    const r = replayer.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
      stopTick();
    } else {
      const at = cur >= total - 20 ? 0 : cur; // restart if at the end
      r.play(at);
      setPlaying(true);
      startTick();
    }
  };

  const seekTo = (clientX: number) => {
    const bar = barRef.current;
    const r = replayer.current;
    if (!bar || !r || total <= 0) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const at = ratio * total;
    r.play(at);
    setCur(at);
    setPlaying(true);
    startTick();
  };

  // Seek to an absolute ms offset — used by the Activity panel's click-to-seek (GD-156).
  const seekMs = React.useCallback(
    (ms: number) => {
      const r = replayer.current;
      if (!r || total <= 0) return;
      const at = Math.min(total, Math.max(0, ms));
      r.play(at);
      setCur(at);
      setPlaying(true);
      startTick();
    },
    [total, startTick],
  );
  React.useEffect(() => {
    if (!seekRef) return;
    seekRef.current = seekMs;
    return () => {
      seekRef.current = undefined;
    };
  }, [seekRef, seekMs]);

  // Report playhead position so a sidebar activity list can highlight the
  // event in sync with playback (GD-170).
  React.useEffect(() => {
    onTime?.(cur);
  }, [cur, onTime]);

  const onBarPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toggleFs = () => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else shell.requestFullscreen?.();
  };

  if (failed) return <PlaceholderCanvas reason="player failed to render this recording" />;

  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
  return (
    <div ref={shellRef} className="overflow-hidden rounded-xl border border-border bg-surface">
      <div ref={stageRef} className="w-full overflow-hidden bg-white" />

      {/* Transport */}
      <div className="flex items-center gap-3 border-t border-border bg-surface px-3 py-2.5">
        <button
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90"
        >
          {playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
        </button>

        <span className="w-9 shrink-0 text-right font-mono text-caption tabular-nums text-text-muted">{fmt(cur)}</span>

        {/* Scrubber + event markers */}
        <div
          ref={barRef}
          onPointerDown={onBarPointerDown}
          className="group relative h-6 flex-1 cursor-pointer select-none"
        >
          <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-2" />
          <div
            className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent"
            style={{ width: `${pct}%` }}
          />
          {markers.map((m, i) => (
            <span
              key={i}
              title={m.label}
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 shadow"
              style={{ left: `${m.pct * 100}%`, background: m.color }}
            />
          ))}
          {/* Playhead */}
          <span
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white shadow"
            style={{ left: `${pct}%` }}
          />
        </div>

        <span className="w-9 shrink-0 font-mono text-caption tabular-nums text-text-faint">{fmt(total)}</span>

        {/* Playback speed (GD-145) — cycles 1×→2×→4×→8×→0.5×. */}
        <button
          onClick={() => {
            const opts = [1, 2, 4, 8, 0.5];
            const next = opts[(opts.indexOf(speed) + 1) % opts.length];
            setSpeed(next);
            try {
              replayer.current?.setConfig?.({ speed: next });
            } catch {
              /* ignore */
            }
          }}
          className="shrink-0 rounded-md px-1.5 font-mono text-caption text-text-muted hover:text-text"
          title="Playback speed"
        >
          {speed}×
        </button>
        <button
          onClick={() => { replayer.current?.play?.(0); setCur(0); setPlaying(true); startTick(); }}
          className="shrink-0 rounded-md px-1.5 text-caption text-text-muted hover:text-text"
          title="Restart"
        >
          Restart
        </button>
        <button
          onClick={toggleFs}
          aria-label="Fullscreen"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
          title={isFs ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <FullscreenIcon size={15} />
        </button>
      </div>

      {/* Marker legend */}
      {markers.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-caption text-text-faint">
          <span className="flex items-center gap-1.5"><Dot color="var(--level-error, #ef4444)" /> error</span>
          <span className="flex items-center gap-1.5"><Dot color="#f59e0b" /> warning</span>
          <span className="flex items-center gap-1.5"><Dot color="#22c55e" /> interaction</span>
          <span className="flex items-center gap-1.5"><Dot color="var(--accent, #7c6cff)" /> event</span>
          <span className="ml-auto">rrweb · password masked</span>
        </div>
      )}
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 rounded-full" style={{ background: color }} />;
}

/** Masked placeholder when no playable blob (FR-RPL-4 privacy look preserved). */
function PlaceholderCanvas({ reason }: { reason?: string }) {
  return (
    <Card className="relative aspect-video overflow-hidden bg-surface-2">
      <div className="absolute inset-0 flex flex-col gap-3 p-6">
        <div className="h-6 w-40 rounded bg-border" />
        <div className="flex gap-3">
          <div className="h-24 flex-1 rounded bg-border/70" />
          <div className="h-24 w-32 rounded bg-border/70" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-caption text-text-faint">email</span>
          <div className="h-6 w-56 rounded bg-[repeating-linear-gradient(45deg,var(--border),var(--border)_6px,transparent_6px,transparent_12px)]" />
          <span className="rounded bg-surface px-1.5 py-0.5 text-caption text-text-faint">masked</span>
        </div>
      </div>
      <div className="absolute bottom-2 left-3 right-3 text-caption text-text-faint">
        {reason ? (
          <div className="flex flex-col gap-1">
            <span>No DOM playback — {reason}</span>
            {(reason.includes('R2') || reason.includes('blob')) && (
              <span className="text-text-muted">Ensure R2 is connected in Settings → Integrations and that <code className="rounded bg-surface px-1">APP_ENCRYPTION_KEY</code> is set on all services.</span>
            )}
          </div>
        ) : 'DOM playback (rrweb) · placeholder'}
      </div>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-small">
      <span className="text-text-muted">{k}</span>
      <span className="font-mono text-text">{v}</span>
    </div>
  );
}
