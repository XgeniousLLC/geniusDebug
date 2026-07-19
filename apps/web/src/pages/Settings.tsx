import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useUi } from '../store/ui';
import { Button, Card, IdChip, Skeleton } from '../components/ui';
import { NoProject } from '../components/NoProject';
import { GithubConnect } from '../components/GithubConnect';

interface Project {
  id: string;
  name: string;
  slug: string;
  platform: string;
  ingestEnabled: boolean;
}

const TABS = ['general', 'integrations', 'members', 'github', 'system'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  general: 'General',
  integrations: 'Integrations',
  members: 'Members',
  github: 'GitHub',
  system: 'System',
};

// Admin-only surfaces (API 403s for members). Members see only General.
const ADMIN_TABS: Tab[] = ['integrations', 'system', 'members', 'github'];

export function Settings() {
  const qc = useQueryClient();
  const { user, currentProjectId } = useUi();
  const isAdmin = user?.role === 'admin';
  const visibleTabs = TABS.filter((t) => isAdmin || !ADMIN_TABS.includes(t));
  const [params, setParams] = useSearchParams();
  const requested = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'general') as Tab;
  // Members can't land on an admin-only tab (e.g. via a shared URL).
  const tab = visibleTabs.includes(requested) ? requested : 'general';
  const setTab = (t: Tab) => {
    params.set('tab', t);
    setParams(params, { replace: true });
  };

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const list = projects.data ?? [];
  const project = list.find((p) => p.id === currentProjectId) ?? list[0];
  const keys = useQuery({
    queryKey: ['keys', project?.id],
    enabled: !!project?.id,
    queryFn: () => api<{ publicKey: string; isActive: boolean; rateLimit: number }[]>(`/projects/${project!.id}/keys`),
  });
  const usage = useQuery({
    queryKey: ['usage', project?.id],
    enabled: !!project?.id,
    queryFn: () => api<{ perDay: { day: string; count: number }[]; replayBytes: number; replayCount: number; totalEvents: number }>(`/projects/${project!.id}/usage`),
  });
  const invalKeys = () => qc.invalidateQueries({ queryKey: ['keys', project?.id] });
  const regen = useMutation({ mutationFn: () => api(`/projects/${project!.id}/keys/regenerate`, { method: 'POST' }), onSuccess: invalKeys });
  const revoke = useMutation({ mutationFn: (k: string) => api(`/keys/${k}/revoke`, { method: 'POST' }), onSuccess: invalKeys });

  if (projects.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  const dsn = keys.data?.[0];
  const host = window.location.hostname + ':4001';
  const dsnUrl = dsn && project ? `https://${dsn.publicKey}@${host}/${project.id}` : '…';

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <h1 className="mb-4 text-h1 font-semibold">Settings</h1>

      <div className="mb-5 flex gap-1 border-b border-border">
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-small ${
              tab === t ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'general' && !project && <NoProject />}

      {tab === 'general' && project && (
        <>
          <Section title="General">
            <Row k="Project" v={project?.name ?? '—'} />
            <Row k="Slug" v={project?.slug ?? '—'} />
            <Row k="Platform" v={project?.platform ?? '—'} />
          </Section>

          <Section title="Client Keys (DSN)" hint="Public, write-only — safe to embed. Cannot read data (NFR-SEC-1).">
            {keys.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <div className="flex flex-col gap-2">
                {keys.data?.map((k) => (
                  <div key={k.publicKey} className="flex items-center gap-3">
                    <IdChip label="key" value={k.publicKey} />
                    <span className="text-caption text-text-muted">{k.rateLimit}/min</span>
                    <span className={`text-caption ${k.isActive ? 'text-status-resolved' : 'text-status-muted'}`}>
                      {k.isActive ? 'active' : 'revoked'}
                    </span>
                    {k.isActive && (
                      <button onClick={() => revoke.mutate(k.publicKey)} className="text-caption text-level-error hover:underline">revoke</button>
                    )}
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="secondary" disabled={regen.isPending} onClick={() => regen.mutate()}>
                    {regen.isPending ? 'Regenerating…' : 'Regenerate key'}
                  </Button>
                </div>
                <div className="mt-2">
                  <div className="mb-1 text-caption uppercase text-text-faint">Sentry.init DSN</div>
                  <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-mono text-text">
{`Sentry.init({
  dsn: "${dsnUrl}",
  tunnelRoute: "/monitoring",
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
});`}
                  </pre>
                </div>
              </div>
            )}
          </Section>

          <Section title="Remote config / Kill switch" hint="Throttle or disable geniusDebug in Taskip without a redeploy (FR-SDK-8, NFR-PERF-4).">
            {project ? <KillSwitch projectId={project.id} enabled={project.ingestEnabled} /> : null}
          </Section>

          <Section title="Retention & Usage" hint="Purge ages out old data to control cost (FR-RET-1/3).">
            <Row k="Events retention" v="30 days" />
            <Row k="Replays retention" v="14 days" />
            <Row k="Total events" v={usage.data ? String(usage.data.totalEvents) : '…'} />
            <Row k="Events (7d)" v={usage.data ? String(usage.data.perDay.reduce((a, d) => a + d.count, 0)) : '…'} />
            <Row k="Replay storage" v={usage.data ? `${(usage.data.replayBytes / 1024).toFixed(1)} KB · ${usage.data.replayCount}` : '…'} />
          </Section>
        </>
      )}

      {tab === 'integrations' && <Integrations isAdmin={isAdmin} />}

      {tab === 'members' && (
        <Section title="Members" hint="Invite teammates; admin-only controls are gated (FR-ADM-6, NFR-SEC-6).">
          <Members />
        </Section>
      )}

      {tab === 'github' && (
        <Section title="GitHub Integration" hint="Create a GitHub App (personal or org), install it, and link a repo so frames deep-link to source (FR-GH-1/3).">
          {project ? <GithubConnect projectId={project.id} /> : <NoProject hint="Create a project first, then connect its GitHub repo for source deep-links." />}
        </Section>
      )}

      {tab === 'system' && (
        <Section title="System metrics" hint="Queue depth, processing latency, dropped-event counters (NFR-MNT-2, FR-ING-6).">
          <SystemMetrics />
        </Section>
      )}
    </div>
  );
}

/* ------------------------------ Integrations ------------------------------ */

interface IntegrationStatus {
  kind: 'r2' | 'ses';
  connected: boolean;
  source: 'env' | 'dashboard' | 'none';
  config: Record<string, string>;
  updatedAt: string | null;
}

interface Provider {
  id: string; // sub-tab id
  tab: string; // sub-tab label
  kind?: 'r2' | 'ses'; // undefined = informational-only provider
  title: string;
  hint: string;
  fields?: Field[];
}

const PROVIDERS: Provider[] = [
  {
    id: 'r2',
    tab: 'Cloudflare R2',
    kind: 'r2',
    title: 'Cloudflare R2 (blob storage)',
    hint: 'Stores replay recordings & source maps (FR-RPL-2/FR-MAP-3). S3-compatible. Secret keys are encrypted at rest.',
    fields: [
      { key: 'accountId', label: 'Account ID', placeholder: 'optional', secret: false },
      { key: 'endpoint', label: 'Endpoint (S3 API URL)', placeholder: 'https://<acct>.r2.cloudflarestorage.com', secret: false },
      { key: 'bucket', label: 'Bucket', placeholder: 'geniusdebug', secret: false },
      { key: 'accessKeyId', label: 'Access Key ID', placeholder: '', secret: true },
      { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '', secret: true },
    ],
  },
  {
    id: 'ses',
    tab: 'AWS SES',
    kind: 'ses',
    title: 'AWS SES (email)',
    hint: 'Sends alert notifications (FR-ALR-6). Secret keys are encrypted at rest.',
    fields: [
      { key: 'region', label: 'Region', placeholder: 'us-east-1', secret: false },
      { key: 'from', label: 'From address', placeholder: 'alerts@yourdomain.com', secret: false },
      { key: 'accessKeyId', label: 'Access Key ID', placeholder: '', secret: true },
      { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '', secret: true },
    ],
  },
  {
    id: 'others',
    tab: 'Others',
    title: 'More integrations',
    hint: 'GitHub source links live in the GitHub tab. More providers (S3, Slack, GCS) can be added here.',
  },
];

function Integrations({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams();
  const active = PROVIDERS.find((p) => p.id === params.get('provider')) ?? PROVIDERS[0];
  const setActive = (id: string) => {
    params.set('provider', id);
    setParams(params, { replace: true });
  };

  const status = useQuery({ queryKey: ['integrations'], queryFn: () => api<IntegrationStatus[]>('/integrations') });
  const byKind = (k?: string) => status.data?.find((s) => s.kind === k);

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      {/* Provider sub-tabs (vertical rail) */}
      <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col">
        {PROVIDERS.map((p) => {
          const connected = p.kind ? byKind(p.kind)?.connected : false;
          return (
            <button
              key={p.id}
              onClick={() => setActive(p.id)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-small ${
                active.id === p.id ? 'bg-accent/10 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {p.kind && (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-status-resolved' : 'bg-status-muted'}`} />
              )}
              {p.tab}
            </button>
          );
        })}
      </nav>

      {/* Selected provider panel */}
      <div className="min-w-0 flex-1">
        {status.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Section title={active.title} hint={active.hint}>
            {active.kind && active.fields ? (
              <IntegrationForm kind={active.kind} isAdmin={isAdmin} status={byKind(active.kind)} fields={active.fields} />
            ) : (
              <div className="text-small text-text-muted">No configurable settings here yet.</div>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}

interface Field {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

function IntegrationForm({
  kind,
  isAdmin,
  status,
  fields,
}: {
  kind: 'r2' | 'ses';
  isAdmin: boolean;
  status?: IntegrationStatus;
  fields: Field[];
}) {
  const qc = useQueryClient();
  const [vals, setVals] = React.useState<Record<string, string>>({});
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  // Prefill non-secret fields from saved config; secrets stay blank (write-only).
  React.useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of fields) if (!f.secret) next[f.key] = status?.config?.[f.key] ?? '';
    setVals(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.updatedAt]);

  const set = (k: string, v: string) => setVals((s) => ({ ...s, [k]: v }));
  const invalidate = () => qc.invalidateQueries({ queryKey: ['integrations'] });

  const save = useMutation({
    mutationFn: () => api(`/integrations/${kind}`, { method: 'PUT', body: JSON.stringify(vals) }),
    onSuccess: () => {
      setMsg({ ok: true, text: 'Saved.' });
      // Clear secret inputs after save (they're write-only).
      setVals((s) => {
        const n = { ...s };
        for (const f of fields) if (f.secret) n[f.key] = '';
        return n;
      });
      invalidate();
    },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'save failed' }),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; detail?: string; error?: string }>(`/integrations/${kind}/test`, { method: 'POST' }),
    onSuccess: (r) => setMsg({ ok: r.ok, text: r.ok ? `Connected — ${r.detail ?? 'ok'}` : `Failed — ${r.error ?? 'error'}` }),
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'test failed' }),
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/integrations/${kind}`, { method: 'DELETE' }),
    onSuccess: () => {
      setMsg({ ok: true, text: 'Disconnected.' });
      invalidate();
    },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'disconnect failed' }),
  });

  const inp = 'h-9 w-full rounded-md border border-border bg-bg px-2.5 text-small text-text';

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-small">
        {status?.connected ? (
          <span className="rounded bg-status-resolved/15 px-2 py-0.5 text-caption text-status-resolved">● connected</span>
        ) : (
          <span className="rounded bg-status-muted/15 px-2 py-0.5 text-caption text-text-muted">○ not connected</span>
        )}
        {status?.source === 'env' && (
          <span className="text-caption text-text-faint">configured via env — dashboard values are ignored while env is set</span>
        )}
      </div>

      {!isAdmin ? (
        <div className="text-caption text-text-faint">Only admins can edit integrations.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-caption text-text-faint">
                  {f.label}
                  {f.secret && status?.connected ? ' (leave blank to keep)' : ''}
                </span>
                <input
                  className={inp}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={vals[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </label>
            ))}
          </div>

          {msg && <div className={`mt-3 text-caption ${msg.ok ? 'text-status-resolved' : 'text-level-error'}`}>{msg.text}</div>}

          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => { setMsg(null); save.mutate(); }}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" disabled={test.isPending || !status?.connected} onClick={() => { setMsg(null); test.mutate(); }}>
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            {status?.connected && status.source !== 'env' && (
              <Button size="sm" variant="danger" disabled={disconnect.isPending} onClick={() => { setMsg(null); disconnect.mutate(); }}>
                Disconnect
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SystemMetrics() {
  const m = useQuery({
    queryKey: ['metrics'],
    queryFn: () => api<{ queue: Record<string, number>; latencyMs: { p50: number; p95: number; samples: number }; dropsToday: Record<string, number> }>('/metrics'),
    refetchInterval: 5000,
  });
  if (m.isLoading || !m.data) return <Skeleton className="h-16 w-full" />;
  const drops = Object.entries(m.data.dropsToday);
  return (
    <div className="grid grid-cols-2 gap-x-6 text-small">
      <Row k="Queue waiting" v={String(m.data.queue.waiting)} />
      <Row k="Queue active" v={String(m.data.queue.active)} />
      <Row k="Dead-letter" v={String(m.data.queue.deadLetter)} />
      <Row k="Latency p50 / p95" v={`${m.data.latencyMs.p50} / ${m.data.latencyMs.p95} ms`} />
      <div className="col-span-2 mt-1 flex flex-wrap gap-2">
        {drops.length === 0 ? (
          <span className="text-caption text-text-faint">No drops today.</span>
        ) : (
          drops.map(([reason, n]) => (
            <span key={reason} className="rounded-md border border-border bg-bg px-2 py-0.5 font-mono text-caption text-text-muted">
              {reason}: {n}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function KillSwitch({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api(`/projects/${projectId}/ingest`, { method: 'POST', body: JSON.stringify({ enabled: next }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
  return (
    <div className="flex items-center justify-between text-small">
      <span className={enabled ? 'text-status-resolved' : 'text-level-error'}>
        Ingest {enabled ? 'enabled — accepting events' : 'disabled — dropping cheaply (202)'}
      </span>
      <Button
        size="sm"
        variant={enabled ? 'danger' : 'primary'}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!enabled)}
      >
        {enabled ? 'Disable ingest' : 'Enable ingest'}
      </Button>
    </div>
  );
}

interface Member {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
}
function Members() {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/members') });
  const allProjects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ id: string; name: string }[]>('/projects') });
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [openAccess, setOpenAccess] = React.useState<string | null>(null);

  const [inviteLink, setInviteLink] = React.useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; id: string; emailSent?: boolean; inviteLink?: string }>('/members', {
        method: 'POST',
        body: JSON.stringify({ name, email, role: 'member' }),
      }),
    onSuccess: (r) => {
      setName('');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['members'] });
      setOpenAccess(r.id); // prompt admin to grant project access right away
      // SES unset → no email went out; surface the link so the admin can share it.
      setInviteLink(r.emailSent ? null : r.inviteLink ?? null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/members/${id}/remove`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const role = useMutation({
    mutationFn: (v: { id: string; role: string }) => api(`/members/${v.id}/role`, { method: 'POST', body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });

  const inp = 'h-8 rounded-md border border-border bg-bg px-2 text-small text-text';
  return (
    <div>
      <div className="mb-3 overflow-hidden rounded-md border border-border">
        {members.data?.map((m) => (
          <div key={m.id} className="border-b border-border last:border-0">
            <div className="flex items-center justify-between px-3 py-2 text-small">
              <div>
                <span className="text-text">{m.name}</span>
                <span className="ml-2 font-mono text-caption text-text-muted">{m.email}</span>
              </div>
              <div className="flex items-center gap-2">
                {m.role === 'member' && (
                  <button
                    onClick={() => setOpenAccess((o) => (o === m.id ? null : m.id))}
                    className="text-caption text-accent hover:underline"
                  >
                    {openAccess === m.id ? 'Hide access' : 'Project access'}
                  </button>
                )}
                <select
                  value={m.role}
                  onChange={(e) => role.mutate({ id: m.id, role: e.target.value })}
                  className="h-7 rounded-md border border-border bg-bg px-1.5 text-caption text-text"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button onClick={() => remove.mutate(m.id)} className="text-caption text-level-error hover:underline">
                  remove
                </button>
              </div>
            </div>
            {m.role === 'member' && openAccess === m.id && (
              <MemberProjects userId={m.id} projects={allProjects.data ?? []} />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">name</span>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">email</span>
          <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <Button size="sm" variant="primary" disabled={invite.isPending || !name || !email} onClick={() => invite.mutate()}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {inviteLink && (
        <div className="mt-2 rounded-md border border-border bg-surface-2 p-2 text-caption">
          <span className="text-text-faint">Email not configured — share this invite link (valid 7 days):</span>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-text">{inviteLink}</code>
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(inviteLink)}>
              Copy
            </Button>
          </div>
        </div>
      )}
      <p className="mt-2 text-caption text-text-faint">Members see only the projects granted here. Admins have access to every project.</p>
    </div>
  );
}

/** Admin control: which projects a member can access (NFR-SEC-6). */
function MemberProjects({ userId, projects }: { userId: string; projects: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const granted = useQuery({
    queryKey: ['member-projects', userId],
    queryFn: () => api<{ projectIds: string[] }>(`/members/${userId}/projects`),
  });
  const [sel, setSel] = React.useState<Set<string> | null>(null);
  React.useEffect(() => {
    if (granted.data) setSel(new Set(granted.data.projectIds));
  }, [granted.data]);

  const save = useMutation({
    mutationFn: (ids: string[]) => api(`/members/${userId}/projects`, { method: 'POST', body: JSON.stringify({ projectIds: ids }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['member-projects', userId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  if (granted.isLoading || !sel) return <div className="px-3 py-2"><Skeleton className="h-8 w-full" /></div>;

  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  return (
    <div className="border-t border-border bg-bg/40 px-3 py-3">
      <div className="mb-2 text-caption uppercase text-text-faint">Project access</div>
      {projects.length === 0 ? (
        <div className="text-caption text-text-muted">No projects.</div>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-small text-text">
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} className="accent-accent" />
              {p.name}
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate([...sel])}>
          {save.isPending ? 'Saving…' : 'Save access'}
        </Button>
        {save.isSuccess && <span className="text-caption text-status-resolved">Saved.</span>}
      </div>
    </div>
  );
}


function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2">
        <h2 className="text-h2 font-semibold">{title}</h2>
        {hint && <div className="text-caption text-text-muted">{hint}</div>}
      </div>
      {children}
    </Card>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-1.5 text-small last:border-0">
      <span className="text-text-muted">{k}</span>
      <span className="font-mono text-text">{v}</span>
    </div>
  );
}
