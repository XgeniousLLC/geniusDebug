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
        const m = JSON.parse(e.data) as { type?: string };
        if (m.type === 'issue') qc.invalidateQueries({ queryKey: ['issues'] });
        else if (m.type === 'replay') qc.invalidateQueries({ queryKey: ['replays'] });
      } catch {
        /* ignore */
      }
    };
    // onerror fires on transient drops; EventSource reconnects itself. Nothing to do.
    return () => es.close();
  }, [projectId, qc]);
}
