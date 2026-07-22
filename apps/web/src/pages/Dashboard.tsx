import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { timeAgo, compact } from '../lib/format';
import { Card, Skeleton, LevelPill, IdChip, StatusChip } from '../components/ui';
import { NoProject } from '../components/NoProject';
import { useUi } from '../store/ui';

interface DashboardData {
  totals: { projects: number; members: number; unresolvedIssues: number; events7d: number; eventsTotal: number; activeUsers7d: number };
  topIssues: { shortId: string; title: string; culprit: string | null; level: string; status: string; timesSeen: number; usersAffected: number; lastSeen: string; projectName: string }[];
  projects: { id: string; name: string; platform: string; ingestEnabled: boolean; events7d: number; unresolvedIssues: number }[];
  members: { name: string; email: string; role: string }[];
  performance: { p50: number; p95: number; samples: number };
  activityByHour: { hour: number; events: number }[];
  peakHour: number | null;
}

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function Dashboard() {
  const navigate = useNavigate();
  const currentProjectId = useUi((s) => s.currentProjectId);
  const q = useQuery({
    queryKey: ['dashboard', currentProjectId],
    queryFn: () =>
      api<DashboardData>(`/dashboard${currentProjectId ? `?projectId=${currentProjectId}` : ''}`),
    refetchInterval: 15000,
  });

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <h1 className="mb-4 text-h1 font-semibold">Dashboard</h1>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const d = q.data;
  if (!d) return null;
  if (d.totals.projects === 0) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <h1 className="mb-4 text-h1 font-semibold">Dashboard</h1>
        <NoProject />
      </div>
    );
  }

  const maxHour = Math.max(1, ...d.activityByHour.map((h) => h.events));

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <h1 className="mb-4 text-h1 font-semibold">Dashboard</h1>

      {/* Stat tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Projects" value={d.totals.projects} onClick={() => navigate('/projects')} />
        <Stat label="Unresolved" value={d.totals.unresolvedIssues} accent onClick={() => navigate('/issues')} />
        <Stat label="Events (7d)" value={compact(d.totals.events7d)} />
        <Stat label="Active users (7d)" value={compact(d.totals.activeUsers7d)} />
        <Stat label="Members" value={d.totals.members} onClick={() => navigate('/settings?tab=members')} />
        <Stat label="Peak hour" value={d.peakHour === null ? '—' : hourLabel(d.peakHour)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Most frequent issues */}
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-h2 font-semibold">Most frequent issues</h2>
            <Link to="/issues" className="text-caption text-accent hover:underline">All issues →</Link>
          </div>
          {d.topIssues.length === 0 ? (
            <div className="py-8 text-center text-small text-text-muted">No issues yet.</div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {d.topIssues.map((i) => (
                <Link key={i.shortId} to={`/issues/${i.shortId}`} className="flex items-center gap-3 py-2.5 hover:bg-surface-2">
                  <LevelPill level={i.level} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-small text-text">{i.title}</div>
                      {i.status !== 'unresolved' && <StatusChip status={i.status} />}
                    </div>
                    <div className="truncate font-mono text-caption text-text-muted">
                      {i.culprit ?? '—'} · {i.projectName}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-small font-semibold text-text">{compact(i.timesSeen)}</div>
                    <div className="text-caption text-text-faint">{timeAgo(i.lastSeen)}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* Activity by hour */}
        <Card className="p-4">
          <h2 className="mb-1 text-h2 font-semibold">Activity by hour</h2>
          <p className="mb-3 text-caption text-text-muted">
            Events per hour of day (last 7d).{d.peakHour !== null && <> Peak at <span className="text-text">{hourLabel(d.peakHour)}</span>.</>}
          </p>
          <div className="flex h-32 items-end gap-[2px]">
            {d.activityByHour.map((h) => (
              <div key={h.hour} className="group relative flex-1" title={`${hourLabel(h.hour)} — ${h.events} events`}>
                <div
                  className={`w-full rounded-sm ${h.hour === d.peakHour ? 'bg-accent' : 'bg-accent/30'}`}
                  style={{ height: `${Math.max(2, (h.events / maxHour) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-caption text-text-faint">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </Card>

        {/* Projects rollup */}
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-h2 font-semibold">Projects</h2>
            <Link to="/projects" className="text-caption text-accent hover:underline">Manage →</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-small">
              <thead>
                <tr className="border-b border-border text-caption uppercase tracking-wide text-text-faint">
                  <th className="py-1.5 text-left font-normal">Project</th>
                  <th className="py-1.5 text-left font-normal">Platform</th>
                  <th className="py-1.5 text-right font-normal">Unresolved</th>
                  <th className="py-1.5 text-right font-normal">Events (7d)</th>
                </tr>
              </thead>
              <tbody>
                {d.projects.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="py-2 text-text">
                      {p.name}
                      {!p.ingestEnabled && <span className="ml-2 text-caption text-level-error">paused</span>}
                    </td>
                    <td className="py-2 font-mono text-caption text-text-muted">{p.platform}</td>
                    <td className="py-2 text-right text-text">{p.unresolvedIssues}</td>
                    <td className="py-2 text-right text-text">{compact(p.events7d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Performance + Members */}
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <h2 className="mb-3 text-h2 font-semibold">Performance</h2>
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Latency p50" value={`${d.performance.p50} ms`} />
              <Metric label="Latency p95" value={`${d.performance.p95} ms`} />
              <Metric label="Events total" value={compact(d.totals.eventsTotal)} />
              <Metric label="Samples" value={String(d.performance.samples)} />
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-h2 font-semibold">Members</h2>
              <Link to="/settings?tab=members" className="text-caption text-accent hover:underline">Manage →</Link>
            </div>
            <div className="flex flex-col gap-2">
              {d.members.map((m) => (
                <div key={m.email} className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-caption font-semibold text-white">
                    {(m.name ?? '?').slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-small text-text">{m.name}</div>
                    <div className="truncate text-caption text-text-faint">{m.email}</div>
                  </div>
                  <IdChip label="" value={m.role} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent, onClick }: { label: string; value: string | number; accent?: boolean; onClick?: () => void }) {
  const cls = `rounded-md border border-border bg-surface p-3 ${onClick ? 'cursor-pointer hover:bg-surface-2' : ''}`;
  return (
    <div className={cls} onClick={onClick}>
      <div className="text-caption uppercase tracking-wide text-text-faint">{label}</div>
      <div className={`mt-1 text-h1 font-semibold ${accent ? 'text-accent' : 'text-text'}`}>{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-body text-text">{value}</div>
    </div>
  );
}
