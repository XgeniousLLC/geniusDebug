import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Card, EmptyState, Skeleton } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useUi } from '../store/ui';

interface Rule {
  id: string;
  name: string;
  conditions: { new?: boolean; regression?: boolean; frequency?: { count: number; windowMin: number } };
  recipients: string[];
  channel: string;
  throttleWindow: number;
  isActive: boolean;
  mutedUntil: string | null;
}
interface Notif { id: string; dedupeKey: string; status: string; sentAt: string }
interface ProjectSummary { id: string; name: string }

export function Alerts() {
  const qc = useQueryClient();
  const currentProjectId = useUi((s) => s.currentProjectId);
  const qs = currentProjectId ? `?projectId=${currentProjectId}` : '';
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/projects') });
  const projectName = projects.data?.find((p) => p.id === currentProjectId)?.name;
  const rules = useQuery({ queryKey: ['alerts', currentProjectId], queryFn: () => api<Rule[]>(`/alerts${qs}`) });
  const history = useQuery({ queryKey: ['alert-history', currentProjectId], queryFn: () => api<Notif[]>(`/alerts/history${qs}`) });

  const inval = () => qc.invalidateQueries({ queryKey: ['alerts'] });
  const patch = useMutation({ mutationFn: (v: { id: string; body: object }) => api(`/alerts/${v.id}`, { method: 'PATCH', body: JSON.stringify(v.body) }), onSuccess: inval });
  const snooze = useMutation({ mutationFn: (v: { id: string; minutes: number }) => api(`/alerts/${v.id}/snooze`, { method: 'POST', body: JSON.stringify({ minutes: v.minutes }) }), onSuccess: inval });
  const del = useMutation({ mutationFn: (id: string) => api(`/alerts/${id}`, { method: 'DELETE' }), onSuccess: inval });

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-h1 font-semibold">Alerts</h1>
        {projectName && (
          <span className="rounded-full bg-surface px-2.5 py-1 text-caption text-text-muted">
            {projectName}
          </span>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-h2 font-semibold">Rules</h2>
      </div>

      {rules.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (rules.data?.length ?? 0) === 0 ? (
        <EmptyState title="No rules" hint="Create one below to be emailed on new, regressed, or spiking issues." />
      ) : (
        <Card className="mb-4 overflow-hidden">
          {rules.data!.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-border px-4 py-3 last:border-0">
              <div className="min-w-0">
                <div className="text-body text-text">{r.name}</div>
                <div className="text-caption text-text-muted">
                  {[r.conditions.new && 'new', r.conditions.regression && 'regression', r.conditions.frequency && `>${r.conditions.frequency.count}/${r.conditions.frequency.windowMin}m`]
                    .filter(Boolean)
                    .join(', ')}{' '}
                  · throttle {Math.round(r.throttleWindow / 60)}m · {r.recipients.join(', ') || 'no recipients'}
                  {r.mutedUntil && new Date(r.mutedUntil) > new Date() ? ` · snoozed ${timeAgo(r.mutedUntil)}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => patch.mutate({ id: r.id, body: { isActive: !r.isActive } })} className={`rounded-full border px-2 py-0.5 text-caption ${r.isActive ? 'border-status-resolved/40 text-status-resolved' : 'border-status-muted/40 text-status-muted'}`}>
                  {r.isActive ? 'Active' : 'Off'}
                </button>
                <button onClick={() => snooze.mutate({ id: r.id, minutes: 60 })} className="text-caption text-text-muted hover:text-accent">snooze 1h</button>
                <button onClick={() => del.mutate(r.id)} className="text-caption text-level-error hover:underline">delete</button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <RuleEditor onCreated={inval} projectId={currentProjectId} />

      <h2 className="mb-2 mt-6 text-h2 font-semibold">Notification history</h2>
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

function RuleEditor({ onCreated, projectId }: { onCreated: () => void; projectId: string | null }) {
  const [name, setName] = React.useState('');
  const [onNew, setOnNew] = React.useState(true);
  const [onReg, setOnReg] = React.useState(true);
  const [freqOn, setFreqOn] = React.useState(false);
  const [count, setCount] = React.useState(10);
  const [windowMin, setWindowMin] = React.useState(5);
  const [recipients, setRecipients] = React.useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/alerts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          ...(projectId ? { projectId } : {}),
          conditions: { new: onNew, regression: onReg, ...(freqOn ? { frequency: { count, windowMin } } : {}) },
          recipients: recipients.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      }),
    onSuccess: () => {
      setName('');
      setRecipients('');
      onCreated();
    },
  });

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';
  return (
    <Card className="p-4">
      <div className="mb-2 text-h2 font-semibold">New rule</div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-faint">name</span>
            <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Critical alerts" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-faint">recipients (comma-sep)</span>
            <input className={`${inp} w-full sm:w-auto sm:min-w-[220px]`} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="dev@x.com, oncall@x.com" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-small">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={onNew} onChange={(e) => setOnNew(e.target.checked)} /> New issue</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={onReg} onChange={(e) => setOnReg(e.target.checked)} /> Regression</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={freqOn} onChange={(e) => setFreqOn(e.target.checked)} /> Frequency</label>
          {freqOn && (
            <span className="flex items-center gap-1 text-text-muted">
              &gt; <input type="number" className={`${inp} w-16`} value={count} onChange={(e) => setCount(Number(e.target.value))} /> times in
              <input type="number" className={`${inp} w-14`} value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))} /> min
            </span>
          )}
        </div>
        <div>
          <Button variant="primary" size="sm" disabled={!name || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create rule'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
