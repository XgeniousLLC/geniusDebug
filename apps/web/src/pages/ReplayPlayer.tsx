import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, Skeleton, ErrorState, Button } from '../components/ui';
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

/**
 * Replay player shell (brief §10 / FR-RPL-5/6): DOM playback canvas, transport bar,
 * timeline with an error marker, meta, and visibly-masked inputs (FR-RPL-4). The
 * rrweb DOM stream is assembled from R2 segments in production; here the canvas is
 * a placeholder so the player UI + wiring verify without the blob.
 */
export function ReplayPlayer() {
  const { replayId = '' } = useParams();
  const [playing, setPlaying] = React.useState(false);
  const [t, setT] = React.useState(0);

  const q = useQuery({ queryKey: ['replay', replayId], queryFn: () => api<Replay | null>(`/replays/${replayId}`) });

  const duration = q.data?.durationMs ?? 8000;
  React.useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((v) => (v >= duration ? 0 : v + 200)), 200);
    return () => clearInterval(id);
  }, [playing, duration]);

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState message="Replay not found." /></div>;

  const r = q.data;
  const pct = Math.min(100, (t / duration) * 100);
  const errorMarkerPct = 85; // error occurred near the end of the buffered window

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
          {/* Playback canvas (masked) */}
          <Card className="relative aspect-video overflow-hidden bg-surface-2">
            <div className="absolute inset-0 flex flex-col gap-3 p-6">
              <div className="h-6 w-40 rounded bg-border" />
              <div className="flex gap-3">
                <div className="h-24 flex-1 rounded bg-border/70" />
                <div className="h-24 w-32 rounded bg-border/70" />
              </div>
              {/* Masked input — privacy visibly enforced (FR-RPL-4) */}
              <div className="flex items-center gap-2">
                <span className="text-caption text-text-faint">email</span>
                <div className="h-6 w-56 rounded bg-[repeating-linear-gradient(45deg,var(--border),var(--border)_6px,transparent_6px,transparent_12px)]" />
                <span className="rounded bg-surface px-1.5 py-0.5 text-caption text-text-faint">masked</span>
              </div>
            </div>
            <div className="absolute bottom-2 right-3 text-caption text-text-faint">DOM playback (rrweb) · placeholder</div>
          </Card>

          {/* Transport bar + timeline with error marker */}
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => setPlaying((p) => !p)}>
              {playing ? '❚❚ Pause' : '► Play'}
            </Button>
            <div className="relative h-2 flex-1 rounded-full bg-surface-2">
              <div className="absolute left-0 top-0 h-2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
              <div
                className="absolute top-[-3px] h-3.5 w-1 rounded bg-level-error"
                style={{ left: `${errorMarkerPct}%` }}
                title="error"
              />
            </div>
            <span className="font-mono text-caption text-text-muted">
              {(t / 1000).toFixed(1)}s / {(duration / 1000).toFixed(1)}s
            </span>
          </div>
        </div>

        {/* Meta (FR-RPL-6) */}
        <Card className="h-fit p-4">
          <div className="mb-2 text-h2 font-semibold">Meta</div>
          <Row k="User" v={String((r.user as { username?: string; id?: string })?.username ?? 'anonymous')} />
          <Row k="SDK" v="javascript-nextjs" />
          <Row k="Duration" v={`${((r.durationMs ?? 0) / 1000).toFixed(1)}s`} />
          <Row k="Segments" v={String(r.segmentCount)} />
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-small">
      <span className="text-text-muted">{k}</span>
      <span className="font-mono text-text">{v}</span>
    </div>
  );
}
