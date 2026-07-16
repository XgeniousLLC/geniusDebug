import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Button, LevelPill, StatusChip, IdChip, Tag, Card, Skeleton, ErrorState } from '../components/ui';
import { StackTrace } from '../components/StackTrace';
import { CheckIcon, ArchiveIcon, BellOffIcon } from '../components/icons';

interface DetailResponse {
  issue: IssueDto;
  latestEvent: EventDto | null;
  events: EventDto[];
  activity: { id: string; action: string; userName: string | null; createdAt: string }[];
  counts: { bucket: string; count: number }[];
}

type Tab = 'stack' | 'breadcrumbs' | 'tags' | 'context' | 'events';

export function IssueDetail() {
  const { shortId = '' } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = React.useState<Tab>('stack');
  const [eventIdx, setEventIdx] = React.useState(0);
  const [editingHi, setEditingHi] = React.useState(false);
  const [pinned, setPinned] = React.useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem('gd_highlights');
      return new Set(s ? (JSON.parse(s) as string[]) : ['handled', 'level', 'transaction', 'url', 'trace']);
    } catch {
      return new Set(['handled', 'level', 'transaction', 'url', 'trace']);
    }
  });
  const togglePin = (k: string) =>
    setPinned((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      localStorage.setItem('gd_highlights', JSON.stringify([...n]));
      return n;
    });

  const q = useQuery({
    queryKey: ['issue', shortId],
    queryFn: () => api<DetailResponse>(`/issues/${shortId}`),
  });

  const act = useMutation({
    mutationFn: (action: string) =>
      api(`/issues/${shortId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue', shortId] }),
  });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ id: string; name: string }[]>('/members') });
  const assign = useMutation({
    mutationFn: (assigneeUserId: string) =>
      api(`/issues/${shortId}/actions`, { method: 'POST', body: JSON.stringify({ action: 'assign', assigneeUserId: assigneeUserId || undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['issue', shortId] }),
  });
  const suspect = useQuery({
    queryKey: ['suspect', shortId],
    queryFn: () => api<{ available: boolean; commits?: { sha: string; message: string; author: string; url: string }[] }>(`/github/issues/${shortId}/suspect-commits`),
  });
  const createIssue = useMutation({
    mutationFn: () => api<{ url: string }>(`/github/issues/${shortId}/create`, { method: 'POST' }),
    onSuccess: (r) => window.open(r.url, '_blank'),
  });

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState message="Issue not found." /></div>;

  const { issue, events, activity } = q.data;
  const event = events[eventIdx] ?? q.data.latestEvent;
  const frames: NormalizedFrame[] = event?.exception?.frames ?? [];
  const contexts = (event?.contexts ?? {}) as Record<string, { name?: string; version?: string; model?: string }>;

  return (
    <div className="mx-auto max-w-6xl px-6 py-5">
      {/* Breadcrumb */}
      <div className="mb-3 flex items-center gap-1.5 font-mono text-caption text-text-faint">
        <Link to="/issues" className="hover:text-accent">Issues</Link>
        <span>/</span>
        <span>Issue Details</span>
        <span>/</span>
        <span className="text-text-muted">{issue.shortId}</span>
      </div>

      {/* Header + action bar (FR-UI-5) */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <LevelPill level={issue.level} />
            <StatusChip status={issue.status} regressed={issue.isRegressed} />
          </div>
          <h1 className="text-h1 font-semibold text-text">{issue.title}</h1>
          <div className="mt-1 flex items-center gap-2 font-mono text-small text-text-muted">
            <span>{issue.culprit ?? '—'}</span>
            <span className="text-text-faint">·</span>
            <span className="text-text-faint">first seen {timeAgo(issue.firstSeen)} ago</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={issue.assigneeUserId ?? ''}
            onChange={(e) => assign.mutate(e.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-2 text-small text-text"
            title="Assign"
          >
            <option value="">Unassigned</option>
            {members.data?.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <Button variant="primary" onClick={() => act.mutate('resolve')}><CheckIcon size={15} /> Resolve</Button>
          <Button onClick={() => act.mutate('archive')}><ArchiveIcon size={15} /> Archive</Button>
          <Button onClick={() => act.mutate('mute')}><BellOffIcon size={15} /> Mute</Button>
        </div>
      </div>

      {/* Event navigation */}
      {events.length > 0 && (
        <div className="mb-4 flex items-center gap-2 text-small text-text-muted">
          <Button size="sm" variant="ghost" disabled={eventIdx >= events.length - 1} onClick={() => setEventIdx((i) => i + 1)}>
            ‹ Older
          </Button>
          <span>Event {events.length - eventIdx} of {events.length}</span>
          <Button size="sm" variant="ghost" disabled={eventIdx <= 0} onClick={() => setEventIdx((i) => i - 1)}>
            Newer ›
          </Button>
          {event && <IdChip label="event" value={event.id} />}
        </div>
      )}

      <div className="grid grid-cols-[1fr_300px] gap-5">
        {/* Left column */}
        <div className="min-w-0">
          {/* Highlights (FR-UI-5) */}
          <Card className="mb-4 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-h2 font-semibold">Highlights</h2>
              <button onClick={() => setEditingHi((e) => !e)} className="text-caption text-text-faint hover:text-accent">
                {editingHi ? 'Done' : 'Edit'}
              </button>
            </div>
            {editingHi && (
              <div className="mb-3 flex flex-wrap gap-3 rounded-md border border-border bg-bg px-3 py-2 text-caption">
                {(['handled', 'level', 'transaction', 'url', 'trace'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1.5 capitalize text-text-muted">
                    <input type="checkbox" checked={pinned.has(k)} onChange={() => togglePin(k)} /> {k}
                  </label>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-small">
              {pinned.has('handled') && <Highlight k="handled" v={event ? (event.handled ? 'true' : 'false') : '—'} />}
              {pinned.has('level') && <Highlight k="level" v={event?.level ?? issue.level} />}
              {pinned.has('transaction') && <Highlight k="transaction" v={event?.transaction ?? '—'} mono />}
              {pinned.has('url') && (
                <Highlight
                  k="url"
                  v={event?.url ? <a href={event.url} className="text-accent hover:underline" target="_blank" rel="noreferrer">{event.url}</a> : '—'}
                />
              )}
              {pinned.has('trace') && (
                <div className="col-span-2 flex items-center gap-2">
                  <span className="text-text-muted">Trace ID</span>
                  {event?.traceId ? (
                    <Link to={`/traces/${event.traceId}`}>
                      <IdChip value={event.traceId} />
                    </Link>
                  ) : (
                    <span className="text-text-faint">—</span>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Tabs */}
          <div className="mb-3 flex gap-4 border-b border-border">
            {(['stack', 'breadcrumbs', 'tags', 'context', 'events'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 pb-2 text-small capitalize ${
                  tab === t ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
                }`}
              >
                {t === 'stack' ? 'Stack trace' : t === 'events' ? 'All events' : t}
              </button>
            ))}
          </div>

          {tab === 'stack' && <StackTrace frames={frames} />}

          {tab === 'breadcrumbs' && (
            <div className="flex flex-col gap-1">
              {(event?.breadcrumbs ?? []).length === 0 && <span className="text-small text-text-muted">No breadcrumbs.</span>}
              {(event?.breadcrumbs ?? []).map((b, i) => (
                <div key={i} className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-mono">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-caption text-text-muted">{String(b.category ?? 'log')}</span>
                  <span className="truncate text-text">{String(b.message ?? '')}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'tags' && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(event?.tags ?? {}).length === 0 && <span className="text-small text-text-muted">No tags.</span>}
              {Object.entries(event?.tags ?? {}).map(([k, v]) => (
                <Tag key={k} k={k} v={String(v)} />
              ))}
            </div>
          )}

          {tab === 'context' && (
            <div className="grid grid-cols-3 gap-3">
              <ContextCard title="Browser" v={contexts.browser} />
              <ContextCard title="OS" v={contexts.os} />
              <ContextCard title="Device" v={contexts.device} />
              <Card className="col-span-3 p-3">
                <div className="mb-1 text-caption uppercase text-text-faint">User</div>
                <pre className="overflow-x-auto font-mono text-mono text-text">{JSON.stringify(event?.user ?? {}, null, 2)}</pre>
              </Card>
            </div>
          )}

          {tab === 'events' && (
            <div className="overflow-hidden rounded-md border border-border">
              {events.map((e, i) => (
                <button
                  key={e.id}
                  onClick={() => { setEventIdx(i); setTab('stack'); }}
                  className="flex w-full items-center justify-between border-b border-border bg-bg px-3 py-2 text-left last:border-0 hover:bg-surface-2"
                >
                  <span className="font-mono text-caption text-text-muted">{e.id.slice(0, 12)}…</span>
                  <span className="text-caption text-text-faint">{timeAgo(e.timestamp)} ago</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right rail */}
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Session Replay</div>
            {event?.traceId ? (
              <Link to={`/replays`} className="text-small text-accent hover:underline">See replays →</Link>
            ) : (
              <div className="text-small text-text-muted">No replay for this event.</div>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Trace</div>
            {event?.traceId ? (
              <Link to={`/traces/${event.traceId}`} className="text-small text-accent hover:underline">Open trace waterfall →</Link>
            ) : (
              <div className="text-small text-text-muted">No trace linked.</div>
            )}
          </Card>
          {suspect.data?.available && (suspect.data.commits?.length ?? 0) > 0 && (
            <Card className="p-4">
              <div className="mb-2 text-h2 font-semibold">Suspect commits</div>
              <div className="flex flex-col gap-1.5">
                {suspect.data.commits!.slice(0, 3).map((c) => (
                  <a key={c.sha} href={c.url} target="_blank" rel="noreferrer" className="block text-caption hover:text-accent">
                    <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>{' '}
                    <span className="text-text">{c.message.split('\n')[0]}</span>
                    <span className="text-text-faint"> · {c.author}</span>
                  </a>
                ))}
              </div>
            </Card>
          )}
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">GitHub</div>
            <button onClick={() => createIssue.mutate()} disabled={createIssue.isPending} className="text-small text-accent hover:underline disabled:opacity-50">
              {createIssue.isPending ? 'Creating…' : 'Create GitHub Issue →'}
            </button>
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Stats</div>
            <Row k="Times seen" v={String(issue.timesSeen)} />
            <Row k="Users affected" v={String(issue.usersAffected)} />
            <Row k="First seen" v={`${timeAgo(issue.firstSeen)} ago`} />
            <Row k="Last seen" v={`${timeAgo(issue.lastSeen)} ago`} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Activity</div>
            {activity.length === 0 && <div className="text-small text-text-muted">No activity yet.</div>}
            {activity.map((a) => (
              <div key={a.id} className="flex items-center justify-between py-1 text-caption">
                <span className="capitalize text-text">{a.action}{a.userName ? ` · ${a.userName}` : ''}</span>
                <span className="text-text-faint">{timeAgo(a.createdAt)} ago</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Highlight({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-text-muted">{k}</span>
      <span className={`truncate text-text ${mono ? 'font-mono text-mono' : ''}`}>{v}</span>
    </div>
  );
}
function ContextCard({ title, v }: { title: string; v?: { name?: string; version?: string; model?: string; family?: string } }) {
  return (
    <Card className="p-3">
      <div className="mb-1 text-caption uppercase text-text-faint">{title}</div>
      <div className="font-mono text-mono text-text">
        {v?.name ?? v?.model ?? v?.family ?? '—'} {v?.version ?? ''}
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
