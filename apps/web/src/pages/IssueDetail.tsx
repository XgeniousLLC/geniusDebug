import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';
import { api, errMsg } from '../lib/api';
import { useUi } from '../store/ui';
import { toast, ACTION_PAST } from '../store/toast';
import { timeAgo } from '../lib/format';
import { Button, LevelPill, StatusChip, IdChip, Tag, Card, Skeleton, ErrorState } from '../components/ui';
import { StackTrace } from '../components/StackTrace';
import { CheckIcon, ArchiveIcon, BellOffIcon, PlayIcon } from '../components/icons';
import { ReplayViewer } from './ReplayPlayer';
import { buildAgentMarkdown } from '../lib/agentMarkdown';

interface DetailResponse {
  issue: IssueDto;
  latestEvent: EventDto | null;
  events: EventDto[];
  activity: { id: string; action: string; userName: string | null; createdAt: string }[];
  counts: { bucket: string; count: number }[];
  shareToken?: string | null;
}

interface FixSuggestion {
  id: string;
  model: string;
  rootCause: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string | null;
  evidence: { path?: string; line?: number; why?: string }[] | null;
  patches: { path: string; unifiedDiff: string }[] | null;
  testSuggestion: string | null;
  needMoreContext: string[] | null;
  createdAt: string;
}
interface SuggestResponse {
  suggestion: FixSuggestion | null;
  prEnabled: boolean;
  prUrl: string | null;
}
interface IssueReplay {
  id: string;
  replayId: string | null;
  durationMs: number | null;
  segments: number;
  user: { username?: string; id?: string } | null;
  traceId: string | null;
  createdAt: string;
}
interface SimilarIssue {
  issue: IssueDto;
  score: number;
}

type Tab = 'stack' | 'breadcrumbs' | 'tags' | 'context' | 'events' | 'replay';

export function IssueDetail() {
  const { shortId = '' } = useParams();
  const qc = useQueryClient();
  const isAdmin = useUi((s) => s.user?.role === 'admin');
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
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['issue', shortId] });
      toast.success(`${shortId} ${ACTION_PAST[action] ?? action}`);
    },
    onError: (e: unknown, action) => toast.error(`Couldn't ${action} ${shortId}: ${errMsg(e)}`),
  });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ id: string; name: string }[]>('/members') });
  const assign = useMutation({
    mutationFn: (assigneeUserId: string) =>
      api(`/issues/${shortId}/actions`, { method: 'POST', body: JSON.stringify({ action: 'assign', assigneeUserId: assigneeUserId || undefined }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issue', shortId] });
      toast.success('Assignee updated');
    },
    onError: (e: unknown) => toast.error(`Couldn't update assignee: ${errMsg(e)}`),
  });
  const suspect = useQuery({
    queryKey: ['suspect', shortId],
    queryFn: () => api<{ available: boolean; commits?: { sha: string; message: string; author: string; url: string }[] }>(`/github/issues/${shortId}/suspect-commits`),
  });
  const createIssue = useMutation({
    mutationFn: () => api<{ url: string }>(`/github/issues/${shortId}/create`, { method: 'POST' }),
    onSuccess: (r) => {
      window.open(r.url, '_blank');
      toast.success('GitHub issue created');
    },
    onError: (e: unknown) => toast.error(`Couldn't create GitHub issue: ${errMsg(e)}`),
  });

  // Replays + similar issues for this issue (GD-132).
  const issueReplays = useQuery({
    queryKey: ['issue-replays', shortId],
    queryFn: () => api<IssueReplay[]>(`/issues/${shortId}/replays`),
  });
  const similar = useQuery({
    queryKey: ['issue-similar', shortId],
    queryFn: () => api<SimilarIssue[]>(`/issues/${shortId}/similar`),
  });
  const [selectedReplay, setSelectedReplay] = React.useState<string | null>(null);
  const [shareOpen, setShareOpen] = React.useState(false);

  // AI fix suggestion (DeepSeek, FR-AIF) — diagnosis is inert; PR is human-gated.
  const suggestion = useQuery({
    queryKey: ['suggest', shortId],
    queryFn: () => api<SuggestResponse>(`/issues/${shortId}/suggest`),
  });
  const genSuggest = useMutation({
    mutationFn: (refresh: boolean) =>
      api<{ suggestion: FixSuggestion | null; reason?: string }>(`/issues/${shortId}/suggest`, {
        method: 'POST',
        body: JSON.stringify({ refresh }),
      }),
    onSuccess: (r) => {
      if (r.suggestion) {
        qc.setQueryData(['suggest', shortId], (prev: SuggestResponse | undefined) => ({
          suggestion: r.suggestion,
          prEnabled: prev?.prEnabled ?? false,
          prUrl: null,
        }));
        toast.success('Fix suggestion ready');
      } else {
        toast.error(r.reason ?? 'No suggestion produced');
      }
    },
    onError: (e: unknown) => toast.error(`Suggest failed: ${errMsg(e)}`),
  });
  const openPr = useMutation({
    mutationFn: (suggestionId: string) =>
      api<{ url: string }>(`/issues/${shortId}/suggest/pr`, { method: 'POST', body: JSON.stringify({ suggestionId }) }),
    onSuccess: (r) => {
      window.open(r.url, '_blank');
      qc.setQueryData(['suggest', shortId], (prev: SuggestResponse | undefined) => (prev ? { ...prev, prUrl: r.url } : prev));
      toast.success('Draft PR opened');
    },
    onError: (e: unknown) => toast.error(`Couldn't open PR: ${errMsg(e)}`),
  });
  const togglePr = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ prEnabled: boolean }>(`/issues/${shortId}/suggest/pr-enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    onSuccess: (r) => {
      qc.setQueryData(['suggest', shortId], (prev: SuggestResponse | undefined) => (prev ? { ...prev, prEnabled: r.prEnabled } : prev));
      toast.success(r.prEnabled ? 'Draft PRs enabled for this repo' : 'Draft PRs disabled');
    },
    onError: (e: unknown) => toast.error(`Couldn't update: ${errMsg(e)}`),
  });

  if (q.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) return <div className="p-6"><ErrorState message="Issue not found." /></div>;

  const { issue, events, activity } = q.data;
  const event = events[eventIdx] ?? q.data.latestEvent;
  const frames: NormalizedFrame[] = event?.exception?.frames ?? [];
  const contexts = (event?.contexts ?? {}) as Record<string, { name?: string; version?: string; model?: string }>;

  return (
    <div className="w-full px-4 py-5 sm:px-6">
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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            title="Copy the full error as Markdown for an AI coding agent"
            onClick={() => {
              const md = buildAgentMarkdown(issue, event);
              navigator.clipboard.writeText(md).then(() => toast.success('Copied AI-agent Markdown'));
              // also offer a .md download
              const blob = new Blob([md], { type: 'text/markdown' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${issue.shortId}.md`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            Copy for AI
          </Button>
          <Button onClick={() => setShareOpen(true)} title="Share issue">Share</Button>
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
          {issue.status === 'resolved' ? (
            <Button onClick={() => act.mutate('unresolve')}><CheckIcon size={15} /> Unresolve</Button>
          ) : issue.status === 'archived' ? (
            <Button onClick={() => act.mutate('unarchive')}><ArchiveIcon size={15} /> Unarchive</Button>
          ) : issue.status === 'muted' ? (
            <Button onClick={() => act.mutate('unmute')}><BellOffIcon size={15} /> Unmute</Button>
          ) : (
            <Button variant="primary" onClick={() => act.mutate('resolve')}><CheckIcon size={15} /> Resolve</Button>
          )}
          {issue.status !== 'archived' && (
            <Button onClick={() => act.mutate('archive')}><ArchiveIcon size={15} /> Archive</Button>
          )}
          {issue.status !== 'muted' && (
            <Button onClick={() => act.mutate('mute')}><BellOffIcon size={15} /> Mute</Button>
          )}
        </div>
      </div>

      {shareOpen && (
        <ShareModal
          shortId={issue.shortId}
          eventId={event?.id ?? null}
          initialToken={q.data.shareToken ?? null}
          onClose={() => setShareOpen(false)}
        />
      )}

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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left column */}
        <div className="min-w-0">
          {/* Events over time (FR-UI-2 / GD-132) */}
          {(q.data.counts?.length ?? 0) > 0 && (
            <Card className="mb-4 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-h2 font-semibold">Events</h2>
                <span className="text-caption text-text-faint">{issue.timesSeen} total · first seen {timeAgo(issue.firstSeen)} ago</span>
              </div>
              <EventsChart counts={q.data.counts} />
            </Card>
          )}

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
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-small sm:grid-cols-2">
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
          <div className="mb-3 flex flex-wrap gap-4 border-b border-border">
            {(['stack', 'breadcrumbs', 'tags', 'context', 'events', 'replay'] as Tab[]).map((t) => {
              const replayCount = issueReplays.data?.length ?? 0;
              if (t === 'replay' && replayCount === 0) return null;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-small capitalize ${
                    tab === t ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
                  }`}
                >
                  {t === 'stack' ? 'Stack trace' : t === 'events' ? 'All events' : t}
                  {/* Occurrence stack count — only when the error is repeating (GD-140). */}
                  {t === 'events' && events.length > 1 && (
                    <span className="rounded-full bg-surface-2 px-1.5 text-caption text-text-muted">{events.length}</span>
                  )}
                  {t === 'replay' && (
                    <span className="rounded-full bg-accent/15 px-1.5 text-caption text-accent">{replayCount}</span>
                  )}
                </button>
              );
            })}
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

          {tab === 'tags' &&
            (() => {
              // Derive Sentry-style tags from event fields + contexts, then merge stored tags (GD-144).
              const c = (event?.contexts ?? {}) as Record<string, { name?: string; version?: string; family?: string; model?: string }>;
              const derived: Record<string, string> = {};
              const put = (k: string, v: unknown) => {
                if (v !== undefined && v !== null && v !== '') derived[k] = String(v);
              };
              put('level', event?.level ?? issue.level);
              put('handled', event ? (event.handled ? 'yes' : 'no') : undefined);
              put('environment', event?.environment);
              put('release', event?.release);
              put('transaction', event?.transaction);
              put('url', event?.url);
              if (c.browser?.name) put('browser', `${c.browser.name}${c.browser.version ? ` ${c.browser.version}` : ''}`);
              put('browser.name', c.browser?.name);
              if (c.os?.name) put('os', `${c.os.name}${c.os.version ? ` ${c.os.version}` : ''}`);
              put('os.name', c.os?.name);
              if (c.device?.family || c.device?.model) put('device', c.device?.family ?? c.device?.model);
              const merged = { ...derived, ...(event?.tags ?? {}) };
              const entries = Object.entries(merged);
              return (
                <div className="flex flex-wrap gap-2">
                  {entries.length === 0 && <span className="text-small text-text-muted">No tags.</span>}
                  {entries.map(([k, v]) => (
                    <Tag key={k} k={k} v={String(v)} />
                  ))}
                </div>
              );
            })()}

          {tab === 'context' && (
            <div className="flex flex-col gap-4">
              {event?.request && Object.keys(event.request).length > 0 && (
                <div>
                  <h2 className="mb-2 text-h2 font-semibold">HTTP Request</h2>
                  <div className="grid grid-cols-1">
                    <HttpRequestCard request={event.request} />
                  </div>
                </div>
              )}

              <div>
                <h2 className="mb-2 text-h2 font-semibold">Contexts</h2>
                {(() => {
                  const all = (event?.contexts ?? {}) as Record<string, Record<string, unknown>>;
                  const cards = Object.entries(all).filter(([, v]) => v && typeof v === 'object');
                  const trace = event?.traceId
                    ? { trace_id: event.traceId, span_id: event.spanId ?? undefined, status: (all.trace?.status as string) ?? undefined }
                    : null;
                  const user = (event?.user ?? {}) as Record<string, unknown>;
                  return (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {Object.keys(user).length > 0 && <ContextCard title="User" obj={user} />}
                      {cards.map(([k, v]) => (
                        <ContextCard key={k} title={k} obj={v} />
                      ))}
                      {trace && !all.trace && <ContextCard title="Trace" obj={trace as Record<string, unknown>} />}
                      {cards.length === 0 && Object.keys(user).length === 0 && !trace && (
                        <span className="text-small text-text-muted">No context captured for this event.</span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {tab === 'events' && (
            <>
              {events.length > 1 && (
                <div className="mb-2 text-caption text-text-faint">
                  {events.length} occurrences of this error — each trigger is logged as its own event.
                </div>
              )}
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
            </>
          )}

          {/* Replay tab (GD-138) — embedded player + session stack. */}
          {tab === 'replay' &&
            (issueReplays.data?.length ?? 0) > 0 &&
            (() => {
              const list = issueReplays.data!;
              const activeKey = selectedReplay ?? list[0].id;
              const active = list.find((r) => r.id === activeKey) ?? list[0];
              return (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-h2 font-semibold">Session replays</h2>
                    <span className="text-caption text-text-faint">
                      {list.length} session{list.length > 1 ? 's' : ''} · newest first
                    </span>
                  </div>
                  <ReplayViewer replayId={active.id} durationMs={active.durationMs} />
                  {list.length > 1 && (
                    <div className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border">
                      {list.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => setSelectedReplay(r.id)}
                          className={`flex w-full items-center gap-3 px-3 py-2 text-left text-small hover:bg-surface-2 ${
                            r.id === active.id ? 'bg-surface-2' : ''
                          }`}
                        >
                          <PlayIcon size={12} className="shrink-0 text-accent" />
                          <span className="font-mono text-caption text-text-muted">{(r.replayId ?? r.id).slice(0, 12)}…</span>
                          <span className="text-caption text-text-faint">{r.segments} seg</span>
                          <span className="ml-auto text-caption text-text-faint">
                            {((r.durationMs ?? 0) / 1000).toFixed(1)}s · {timeAgo(r.createdAt)} ago
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
        </div>

        {/* Right rail */}
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Session Replay</div>
            {(issueReplays.data?.length ?? 0) > 0 ? (
              <div className="text-small text-text-muted">
                {issueReplays.data!.length} replay{issueReplays.data!.length > 1 ? 's' : ''} — watch under{' '}
                <span className="text-accent">Replays in this issue</span>.
              </div>
            ) : (
              <div className="text-small text-text-muted">No replay captured for this issue.</div>
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
          <SuggestCard
            data={suggestion.data?.suggestion ?? null}
            loading={suggestion.isLoading}
            pending={genSuggest.isPending}
            onGenerate={(refresh) => genSuggest.mutate(refresh)}
            isAdmin={isAdmin}
            prEnabled={suggestion.data?.prEnabled ?? false}
            prUrl={suggestion.data?.prUrl ?? null}
            prPending={openPr.isPending}
            onOpenPr={(id) => {
              if (window.confirm('Open a DRAFT pull request applying this patch to a new branch? It will NOT be merged.')) openPr.mutate(id);
            }}
            onTogglePr={(en) => togglePr.mutate(en)}
            togglePending={togglePr.isPending}
          />
          <Card className="p-4">
            <div className="mb-2 text-h2 font-semibold">Stats</div>
            <Row k="Times seen" v={String(issue.timesSeen)} />
            <Row k="Users affected" v={String(issue.usersAffected)} />
            <Row k="First seen" v={`${timeAgo(issue.firstSeen)} ago`} />
            <Row k="Last seen" v={`${timeAgo(issue.lastSeen)} ago`} />
          </Card>
          {(similar.data?.length ?? 0) > 0 && (
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-h2 font-semibold">Similar Issues</div>
                <span className="text-caption text-text-faint">by stack trace</span>
              </div>
              <div className="flex flex-col gap-2">
                {similar.data!.map((s) => (
                  <Link
                    key={s.issue.shortId}
                    to={`/issues/${s.issue.shortId}`}
                    className="flex items-center gap-2 text-caption hover:text-accent"
                    title={`${Math.round(s.score * 100)}% similar`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: simColor(s.score) }} />
                    <span className="min-w-0 truncate text-text">{s.issue.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-text-faint">{s.issue.timesSeen}</span>
                  </Link>
                ))}
              </div>
            </Card>
          )}
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
/** Renders every field of a context object (browser/os/device/culture/react/…) — GD-144. */
function ContextCard({ title, obj }: { title: string; obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([k]) => k !== 'type');
  return (
    <Card className="p-3">
      <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-faint">{title}</div>
      <div className="flex flex-col gap-1">
        {entries.length === 0 && <span className="text-caption text-text-faint">—</span>}
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 text-small">
            <span className="shrink-0 text-text-muted">{k}</span>
            <span className="truncate text-right font-mono text-mono text-text">
              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** HTTP Request card (method + url + headers), cookies/auth scrubbed — GD-144. */
function HttpRequestCard({ request }: { request: Record<string, unknown> }) {
  const method = (request.method as string) ?? 'GET';
  const url = (request.url as string) ?? '';
  const headers = (request.headers as Record<string, string>) ?? {};
  const shown = Object.entries(headers).filter(([k]) => !/cookie|authorization/i.test(k));
  return (
    <Card className="col-span-full p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-caption font-semibold text-accent">{method}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="truncate font-mono text-small text-text hover:text-accent">{url}</a>
        )}
      </div>
      {shown.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-1.5 text-caption font-semibold uppercase tracking-wide text-text-faint">Headers</div>
          {shown.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[140px_1fr] gap-3 border-b border-border px-3 py-1.5 text-small last:border-0">
              <span className="text-text-muted">{k}</span>
              <span className="break-all font-mono text-mono text-text">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
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

/** Share Issue dialog (GD-133) — copy link / markdown + public-link toggle. */
function ShareModal({
  shortId,
  eventId,
  initialToken,
  onClose,
}: {
  shortId: string;
  eventId: string | null;
  initialToken: string | null;
  onClose: () => void;
}) {
  const [includeEvent, setIncludeEvent] = React.useState(!!eventId);
  const [token, setToken] = React.useState<string | null>(initialToken);
  const [copied, setCopied] = React.useState('');
  const origin = window.location.origin;

  const privateUrl =
    includeEvent && eventId
      ? `${origin}/issues/${shortId}?event=${eventId}`
      : `${origin}/issues/${shortId}`;
  const publicUrl = token ? `${origin}/share/${token}` : null;

  const share = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ shareToken: string | null }>(`/issues/${shortId}/share`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (r) => {
      setToken(r.shareToken);
      toast.success(r.shareToken ? 'Public link created' : 'Public link disabled');
    },
    onError: (e: unknown) => toast.error(`Couldn't update share: ${errMsg(e)}`),
  });

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      toast.success('Copied');
      setTimeout(() => setCopied(''), 1500);
    });
  };
  const markdown = `[${shortId}](${publicUrl ?? privateUrl})`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24" onClick={onClose}>
      <Card className="w-full max-w-xl p-0" >
        <div className="flex items-center justify-between border-b border-border px-5 py-3" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-h2 font-semibold">Share Issue</h2>
          <button onClick={onClose} className="text-text-faint hover:text-text" aria-label="Close">✕</button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4" onClick={(e) => e.stopPropagation()}>
          <div>
            <input
              readOnly
              value={publicUrl ?? privateUrl}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-caption text-text"
              onFocus={(e) => e.currentTarget.select()}
            />
            {eventId && (
              <label className="mt-2 flex items-center gap-2 text-small text-text-muted">
                <input type="checkbox" checked={includeEvent} onChange={(e) => setIncludeEvent(e.target.checked)} />
                Include Event ID in link
              </label>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => copy(markdown, 'md')}>{copied === 'md' ? 'Copied' : 'Copy as Markdown'}</Button>
            <Button variant="primary" onClick={() => copy(publicUrl ?? privateUrl, 'link')}>
              {copied === 'link' ? 'Copied' : 'Copy Link'}
            </Button>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-4">
            <div>
              <div className="text-small font-medium text-text">Create a public link</div>
              <div className="text-caption text-text-faint">Read-only view for anyone outside your org.</div>
            </div>
            <button
              onClick={() => share.mutate(!token)}
              disabled={share.isPending}
              className={`relative h-6 w-11 rounded-full transition ${token ? 'bg-accent' : 'bg-surface-2'} disabled:opacity-50`}
              aria-label="Toggle public link"
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${token ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Green (most) → red (least) similarity dot, matching the Sentry gradient (GD-132). */
function simColor(score: number): string {
  if (score >= 0.6) return '#22c55e';
  if (score >= 0.45) return '#84cc16';
  if (score >= 0.3) return '#f59e0b';
  if (score >= 0.2) return '#f97316';
  return '#ef4444';
}

/** Compact event-volume bar chart from issue count buckets (GD-132). */
function EventsChart({ counts }: { counts: { bucket: string; count: number }[] }) {
  const max = Math.max(1, ...counts.map((c) => c.count));
  return (
    <div className="flex h-20 items-end justify-start gap-1" title="Events over time">
      {counts.map((c, i) => (
        <div
          key={i}
          className="w-full max-w-[36px] flex-1 rounded-sm bg-accent transition hover:bg-accent-strong"
          style={{ height: `${Math.max(3, (c.count / max) * 100)}%` }}
          title={`${new Date(c.bucket).toLocaleString()} · ${c.count}`}
        />
      ))}
    </div>
  );
}

const CONF_TONE: Record<string, string> = {
  high: 'bg-level-info/15 text-level-info',
  medium: 'bg-level-warning/15 text-level-warning',
  low: 'bg-surface-2 text-text-muted',
};

/** AI "Suggested fix" card (DeepSeek, FR-AIF) — inert diagnosis, never writes. */
function SuggestCard({
  data,
  loading,
  pending,
  onGenerate,
  isAdmin,
  prEnabled,
  prUrl,
  prPending,
  onOpenPr,
  onTogglePr,
  togglePending,
}: {
  data: FixSuggestion | null;
  loading: boolean;
  pending: boolean;
  onGenerate: (refresh: boolean) => void;
  isAdmin: boolean;
  prEnabled: boolean;
  prUrl: string | null;
  prPending: boolean;
  onOpenPr: (suggestionId: string) => void;
  onTogglePr: (enabled: boolean) => void;
  togglePending: boolean;
}) {
  const hasPatch = (data?.patches?.length ?? 0) > 0;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-h2 font-semibold">Suggested fix</div>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-caption text-text-faint">AI · Unverified</span>
      </div>

      {loading ? (
        <Skeleton className="h-16 w-full" />
      ) : !data ? (
        <div className="text-small text-text-muted">
          <p className="mb-2">Get an AI diagnosis of the probable root cause and a fix, grounded in this issue's stack trace.</p>
          <Button size="sm" variant="secondary" onClick={() => onGenerate(false)} disabled={pending}>
            {pending ? 'Analyzing…' : 'Suggest a fix'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 text-small">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-caption font-medium ${CONF_TONE[data.confidence] ?? CONF_TONE.low}`}>
              {data.confidence} confidence
            </span>
            <span className="font-mono text-caption text-text-faint">{data.model}</span>
          </div>

          <div>
            <div className="mb-0.5 text-caption uppercase tracking-wide text-text-faint">Root cause</div>
            <p className="text-text">{data.rootCause}</p>
          </div>

          {data.explanation && <p className="text-text-muted">{data.explanation}</p>}

          {(data.evidence?.length ?? 0) > 0 && (
            <div>
              <div className="mb-0.5 text-caption uppercase tracking-wide text-text-faint">Evidence</div>
              <ul className="flex flex-col gap-0.5">
                {data.evidence!.map((e, i) => (
                  <li key={i} className="text-text-muted">
                    <span className="font-mono text-text-faint">
                      {e.path}
                      {e.line ? `:${e.line}` : ''}
                    </span>{' '}
                    {e.why}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(data.patches?.length ?? 0) > 0 &&
            data.patches!.map((p, i) => (
              <div key={i}>
                <div className="mb-0.5 font-mono text-caption text-text-faint">{p.path}</div>
                <pre className="overflow-x-auto rounded bg-surface-2 p-2 font-mono text-caption leading-relaxed">
                  {p.unifiedDiff.split('\n').map((ln, j) => (
                    <div
                      key={j}
                      className={ln.startsWith('+') ? 'text-level-info' : ln.startsWith('-') ? 'text-level-error' : 'text-text-muted'}
                    >
                      {ln || ' '}
                    </div>
                  ))}
                </pre>
              </div>
            ))}

          {data.testSuggestion && (
            <div>
              <div className="mb-0.5 text-caption uppercase tracking-wide text-text-faint">Test</div>
              <p className="text-text-muted">{data.testSuggestion}</p>
            </div>
          )}

          {(data.needMoreContext?.length ?? 0) > 0 && (
            <div className="rounded border border-border bg-surface-2 p-2 text-text-muted">
              <div className="mb-0.5 text-caption uppercase tracking-wide text-text-faint">Needs more context</div>
              <ul className="list-inside list-disc">
                {data.needMoreContext!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Draft-PR controls (P4) — explicit human action, admin-gated, draft-only. */}
          {hasPatch && (
            <div className="mt-1 border-t border-border pt-2.5">
              {prUrl ? (
                <a href={prUrl} target="_blank" rel="noreferrer" className="text-small text-accent hover:underline">
                  View draft PR →
                </a>
              ) : !isAdmin ? (
                <span className="text-caption text-text-faint">An admin can open a draft PR from this patch.</span>
              ) : prEnabled ? (
                <div className="flex flex-col gap-1">
                  <Button size="sm" variant="secondary" onClick={() => data && onOpenPr(data.id)} disabled={prPending}>
                    {prPending ? 'Opening…' : 'Open draft PR →'}
                  </Button>
                  <span className="text-caption text-text-faint">Applies the patch to a new branch as a draft. Never auto-merged.</span>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-text-faint">Draft PRs are off for this repo.</span>
                  <button
                    onClick={() => onTogglePr(true)}
                    disabled={togglePending}
                    className="self-start text-caption text-accent hover:underline disabled:opacity-50"
                  >
                    {togglePending ? 'Enabling…' : 'Enable draft PRs for this repo'}
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => onGenerate(true)}
            disabled={pending}
            className="self-start text-caption text-accent hover:underline disabled:opacity-50"
          >
            {pending ? 'Analyzing…' : 'Regenerate'}
          </button>
        </div>
      )}
    </Card>
  );
}
