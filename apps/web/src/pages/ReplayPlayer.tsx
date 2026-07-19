import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import 'rrweb-player/dist/style.css';
import { api } from '../lib/api';
import { Card, Skeleton, ErrorState } from '../components/ui';
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-5">
      <div className="mb-3 flex items-center gap-1.5 font-mono text-caption text-text-faint">
        <Link to="/replays" className="hover:text-accent">Replays</Link>
        <span>/</span>
        <span className="text-text-muted">{r.id.slice(0, 12)}…</span>
      </div>
      <h1 className="mb-4 text-h1 font-semibold">Session Replay</h1>

      <div className="grid grid-cols-[1fr_260px] gap-5">
        <div>
          {rec.isLoading ? (
            <Card className="aspect-video"><Skeleton className="h-full w-full" /></Card>
          ) : canPlay ? (
            <RrwebCanvas events={events} />
          ) : (
            <PlaceholderCanvas reason={rec.data?.reason} />
          )}
        </div>

        {/* Meta (FR-RPL-6) */}
        <Card className="h-fit p-4">
          <div className="mb-2 text-h2 font-semibold">Meta</div>
          <Row k="User" v={String((r.user as { username?: string; id?: string })?.username ?? 'anonymous')} />
          <Row k="SDK" v="javascript-nextjs" />
          <Row k="Duration" v={`${((r.durationMs ?? 0) / 1000).toFixed(1)}s`} />
          <Row k="Segments" v={String(r.segmentCount)} />
          <Row k="Events" v={String(events.length)} />
          <Row k="Captured" v={`${timeAgo(r.createdAt)} ago`} />
          {r.traceId && (
            <Link to={`/traces/${r.traceId}`} className="mt-2 block text-caption text-accent hover:underline">
              Open trace →
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Mounts rrweb-player into a div; imported lazily so it stays out of the main bundle. */
function RrwebCanvas({ events }: { events: unknown[] }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    // rrweb-player is a compiled Svelte component; instance exposes $destroy().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let player: any = null;
    let cancelled = false;
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    (async () => {
      try {
        const { default: RrwebPlayer } = await import('rrweb-player');
        if (cancelled || !ref.current) return;
        const width = Math.max(320, ref.current.clientWidth || 760);
        player = new RrwebPlayer({
          target: ref.current,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { events: events as any[], width, height: Math.round((width * 9) / 16), autoPlay: false, showController: true },
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      try {
        player?.$destroy?.();
      } catch {
        /* ignore */
      }
      if (el) el.innerHTML = '';
    };
  }, [events]);

  if (failed) return <PlaceholderCanvas reason="player failed to render this recording" />;
  return <Card className="overflow-hidden p-0"><div ref={ref} className="w-full" /></Card>;
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
      <div className="absolute bottom-2 right-3 text-caption text-text-faint">
        {reason ? `No DOM playback — ${reason}` : 'DOM playback (rrweb) · placeholder'}
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
