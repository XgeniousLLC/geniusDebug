import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import 'rrweb/dist/style.css';
import { api } from '../lib/api';
import { Card, Skeleton, ErrorState } from '../components/ui';
import { PlayIcon, PauseIcon, FullscreenIcon } from '../components/icons';
import { timeAgo } from '../lib/format';

interface Replay {
  id: string;
  issueId: string | null;
  traceId: string | null;
  user: Record<string, unknown> | null;
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

  const q = useQuery({ queryKey: ['replay', replayId], queryFn: () => api<Replay | null>(`/replays/${replayId}`) });
  const rec = useQuery({
    queryKey: ['replay-rec', replayId],
    queryFn: () => api<Recording>(`/replays/${replayId}/recording`),
    enabled: !!q.data,
    retry: false,
  });

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState message="Replay not found." /></div>;

  const r = q.data;
  const events = rec.data?.events ?? [];
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
      <div className="mb-3 flex items-center gap-1.5 font-mono text-caption text-text-faint">
        <Link to="/replays" className="hover:text-accent">Replays</Link>
        <span>/</span>
        <span className="text-text-muted">{r.id.slice(0, 12)}…</span>
      </div>
      <h1 className="mb-4 text-h1 font-semibold">Session Replay</h1>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          {rec.isLoading ? (
            <Card className="aspect-video"><Skeleton className="h-full w-full" /></Card>
          ) : canPlay ? (
            <RrwebCanvas events={events} durationMs={r.durationMs} />
          ) : (
            <PlaceholderCanvas reason={rec.data?.reason} />
          )}

          {/* Console / Network / Errors breakdown (GD-145) */}
          {canPlay && <ActivityPanel events={events} />}
        </div>

        {/* Right rail: AI summary + meta */}
        <div className="flex flex-col gap-4">
          {canPlay && <AISummary events={events} />}
          <Card className="h-fit p-4">
          <div className="mb-2 text-h2 font-semibold">Meta</div>
          <Row k="User" v={String((r.user as { username?: string; id?: string })?.username ?? 'anonymous')} />
          <Row k="SDK" v="javascript-nextjs" />
          <Row k="Duration" v={`${((r.durationMs ?? 0) / 1000).toFixed(1)}s`} />
          <Row k="Segments" v={String(r.segmentCount)} />
          <Row k="Events" v={String(events.length)} />
          {clickStats.dead > 0 && <Row k="Dead clicks" v={String(clickStats.dead)} />}
          {clickStats.rage > 0 && <Row k="Rage clicks" v={String(clickStats.rage)} />}
          <Row k="Captured" v={`${timeAgo(r.createdAt)} ago`} />
          {r.traceId && (
            <Link to={`/traces/${r.traceId}`} className="mt-2 block text-caption text-accent hover:underline">
              Open trace →
            </Link>
          )}
          </Card>
        </div>
      </div>
    </div>
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

const ACT_TABS: { key: 'all' | ActKind; label: string }[] = [
  { key: 'all', label: 'Activity' },
  { key: 'console', label: 'Console' },
  { key: 'network', label: 'Network' },
  { key: 'error', label: 'Errors' },
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

/** Console/Network/Errors breakdown for a replay — Sentry-style tabs (GD-145). */
function ActivityPanel({ events }: { events: unknown[] }) {
  const acts = React.useMemo(() => extractActivity(events), [events]);
  const [tab, setTab] = React.useState<'all' | ActKind>('all');
  if (acts.length === 0) return null;
  const shown = tab === 'all' ? acts : acts.filter((a) => a.kind === tab);
  const count = (k: 'all' | ActKind) => (k === 'all' ? acts.length : acts.filter((a) => a.kind === k).length);
  const fmtT = (ms: number) => `${Math.floor(ms / 1000)}:${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`;
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="flex gap-4 border-b border-border px-4 pt-2">
        {ACT_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-small ${
              tab === t.key ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {t.label}
            <span className="rounded-full bg-surface-2 px-1.5 text-caption text-text-muted">{count(t.key)}</span>
          </button>
        ))}
      </div>
      <div className="max-h-80 overflow-y-auto">
        {shown.length === 0 && <div className="px-4 py-3 text-small text-text-faint">Nothing here.</div>}
        {shown.map((a, i) => (
          <div key={i} className="flex items-start gap-3 border-b border-border px-4 py-1.5 text-small last:border-0">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: ACT_COLOR[a.kind] }} />
            <span className="w-10 shrink-0 font-mono text-caption text-text-faint">{fmtT(a.t)}</span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-text-muted">{a.category}</span>
            <span className="min-w-0 truncate font-mono text-mono text-text">{a.message}</span>
          </div>
        ))}
      </div>
    </Card>
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
      const msg = String(p.message ?? (p.data ? JSON.stringify(p.data) : ''));
      out.push({ t, kind, category: cat || kind, message: msg, level });
    } else if (d.tag === 'performanceSpan') {
      const p = (d.payload ?? {}) as Record<string, unknown>;
      out.push({ t, kind: 'network', category: String(p.op ?? 'resource'), message: String(p.description ?? '') });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function RrwebCanvas({ events: rawEvents, durationMs }: { events: unknown[]; durationMs: number | null }) {
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
