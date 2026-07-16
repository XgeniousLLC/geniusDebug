import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, EmptyState, Skeleton } from '../components/ui';
import { timeAgo } from '../lib/format';

interface Rule {
  id: string;
  name: string;
  conditions: Record<string, boolean>;
  recipients: string[];
  channel: string;
  throttleWindow: number;
  isActive: boolean;
}
interface Notif {
  id: string;
  dedupeKey: string;
  status: string;
  sentAt: string;
}

export function Alerts() {
  const rules = useQuery({ queryKey: ['alerts'], queryFn: () => api<Rule[]>('/alerts') });
  const history = useQuery({ queryKey: ['alert-history'], queryFn: () => api<Notif[]>('/alerts/history') });

  return (
    <div className="mx-auto max-w-6xl px-6 py-5">
      <h1 className="mb-4 text-h1 font-semibold">Alerts</h1>

      <h2 className="mb-2 text-h2 font-semibold">Rules</h2>
      {rules.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (rules.data?.length ?? 0) === 0 ? (
        <EmptyState title="No rules" hint="Create a rule to be emailed on new & regressed issues." />
      ) : (
        <Card className="mb-6 overflow-hidden">
          {rules.data!.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-border px-4 py-3 last:border-0">
              <div>
                <div className="text-body text-text">{r.name}</div>
                <div className="text-caption text-text-muted">
                  {Object.entries(r.conditions).filter(([, v]) => v).map(([k]) => k).join(', ')} ·{' '}
                  throttle {Math.round(r.throttleWindow / 60)}m · {r.recipients.join(', ')}
                </div>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-caption ${r.isActive ? 'border-status-resolved/40 text-status-resolved' : 'border-status-muted/40 text-status-muted'}`}>
                {r.isActive ? 'Active' : 'Off'} · {r.channel}
              </span>
            </div>
          ))}
        </Card>
      )}

      <h2 className="mb-2 text-h2 font-semibold">Notification history</h2>
      {history.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (history.data?.length ?? 0) === 0 ? (
        <EmptyState title="No notifications sent" hint="Dedupe + throttle keeps this quiet — one email per issue per window (FR-ALR-4)." />
      ) : (
        <Card className="overflow-hidden">
          {history.data!.map((n) => (
            <div key={n.id} className="flex items-center justify-between border-b border-border px-4 py-2 last:border-0">
              <span className="font-mono text-caption text-text-muted">{n.dedupeKey}</span>
              <span className="text-caption text-status-resolved">{n.status}</span>
              <span className="text-caption text-text-faint">{timeAgo(n.sentAt)} ago</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
