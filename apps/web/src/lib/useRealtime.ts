import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, getToken } from './api';

/**
 * Realtime feed updates (GD-147) — subscribes to the API's SSE stream and
 * invalidates the relevant query when a new issue/replay lands, so feeds refresh
 * on change instead of polling on a timer. EventSource auto-reconnects; a long
 * fallback poll on the feed covers the case where SSE is blocked by a proxy.
 */
export function useRealtime(projectId: string | null): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    const token = getToken();
    if (!token || typeof EventSource === 'undefined') return;
    const url = `${API_BASE}/events/stream?token=${encodeURIComponent(token)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data) as { type?: string; projectId?: string };
        // Scope invalidation to the specific project to avoid cross-project
        // query churn. React Query's queryKey matching uses strict object
        // equality so we use a predicate to match on the projectId field
        // regardless of what other filter fields the key carries.
        const targetPid = m.projectId ?? projectId;
        if (m.type === 'issue') {
          qc.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'issues' && (!targetPid || (q.queryKey[1] as Record<string, unknown>)?.projectId === targetPid),
          });
        } else if (m.type === 'replay') {
          qc.invalidateQueries({
            predicate: (q) => q.queryKey[0] === 'replays' && (!targetPid || (q.queryKey[1] as Record<string, unknown>)?.projectId === targetPid),
          });
        }
      } catch {
        /* ignore */
      }
    };
    // onerror fires on transient drops; EventSource reconnects itself. Nothing to do.
    return () => es.close();
  }, [projectId, qc]);
}
