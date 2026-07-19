import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton } from '../components/ui';
import { timeAgo } from '../lib/format';

interface Replay {
  id: string;
  durationMs: number | null;
  segmentCount: number;
  createdAt: string;
}

export function Replays() {
  const q = useQuery({ queryKey: ['replays'], queryFn: () => api<Replay[]>('/replays') });
  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <h1 className="mb-4 text-h1 font-semibold">Replays</h1>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No replays yet"
          hint="Replay runs in on-error/buffered mode (FR-RPL-1) — the SDK only sends on error. Masked inputs render as blocks for privacy (FR-RPL-4)."
        />
      ) : (
        <Card className="overflow-hidden">
          {q.data!.map((r) => (
            <Link
              key={r.id}
              to={`/replays/${r.id}`}
              className="flex items-center justify-between border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2"
            >
              <span className="font-mono text-small text-accent">{r.id.slice(0, 12)}…</span>
              <span className="text-small text-text-muted">{r.segmentCount} segments</span>
              <span className="text-small text-text-muted">{((r.durationMs ?? 0) / 1000).toFixed(1)}s</span>
              <span className="text-small text-text-faint">{timeAgo(r.createdAt)} ago</span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
