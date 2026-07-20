import * as React from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GeniusDebugWordmark } from '../brand/GeniusDebugIcon';
import { useUi, RANGE_LABELS, type IssueRange } from '../store/ui';
import { Toaster } from './Toaster';
import { api } from '../lib/api';
import {
  DashboardIcon,
  IssuesIcon,
  ReplaysIcon,
  AlertsIcon,
  ProjectsIcon,
  ReleasesIcon,
  TracesIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  SignOutIcon,
  SearchIcon,
  MenuIcon,
  CloseIcon,
} from './icons';

// Traces intentionally omitted — reached from an issue's detail (it's issue-scoped),
// not a standalone feed. Route still exists for those deep-links.
const NAV = [
  { to: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/issues', label: 'Issues', Icon: IssuesIcon },
  { to: '/replays', label: 'Replays', Icon: ReplaysIcon },
  { to: '/releases', label: 'Releases', Icon: ReleasesIcon },
  { to: '/performance', label: 'Performance', Icon: TracesIcon },
  { to: '/alerts', label: 'Alerts', Icon: AlertsIcon },
  { to: '/projects', label: 'Projects', Icon: ProjectsIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
];

/** Global search (brief §3): ⌘K to focus; routes trace IDs / short IDs / free text. */
function GlobalSearch() {
  const navigate = useNavigate();
  const ref = React.useRef<HTMLInputElement>(null);
  const [q, setQ] = React.useState('');

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const s = q.trim();
    if (!s) return;
    if (/^[0-9a-f]{32}$/i.test(s)) navigate(`/traces/${s}`);
    else if (/^[A-Z][A-Z0-9-]+-[A-Z0-9]+$/i.test(s)) navigate(`/issues/${s.toUpperCase()}`);
    else navigate(`/issues?query=${encodeURIComponent(s)}`);
    setQ('');
    ref.current?.blur();
  }

  return (
    <form onSubmit={submit} className="relative w-full min-w-0 max-w-md">
      <SearchIcon size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search issues, trace IDs…  (⌘K)"
        className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-small text-text placeholder:text-text-faint"
      />
    </form>
  );
}

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  platform: string;
  ingestEnabled: boolean;
}

/** Sidebar project switcher — changes the global currentProjectId (multi-project). */
function ProjectSwitcher({ projects }: { projects: ProjectSummary[] }) {
  const navigate = useNavigate();
  const { currentProjectId, setCurrentProject, user } = useUi();
  const isAdmin = user?.role === 'admin';
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const current = projects.find((p) => p.id === currentProjectId) ?? projects[0];

  // Keep the store in sync when the persisted id is missing/stale.
  React.useEffect(() => {
    if (current && current.id !== currentProjectId) setCurrentProject(current.id);
  }, [current, currentProjectId, setCurrentProject]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-small text-text-muted hover:bg-surface-2"
      >
        <span className={`h-2 w-2 rounded-full ${current ? 'bg-accent' : 'bg-status-muted'}`} />
        <span className={`truncate ${current ? 'text-text' : 'text-text-muted'}`}>{current?.name ?? 'No project'}</span>
        <span className="ml-auto text-text-faint">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border border-border bg-surface shadow-lg">
          <div className="max-h-64 overflow-y-auto py-1">
            {projects.length === 0 && (
              <div className="px-2.5 py-1.5 text-caption text-text-faint">No projects yet</div>
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setCurrentProject(p.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small text-text-muted hover:bg-surface-2"
              >
                <span className="truncate text-text">{p.name}</span>
                {!p.ingestEnabled && <span className="text-caption text-level-error">paused</span>}
                {p.id === current?.id && <span className="ml-auto text-accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="border-t border-border py-1">
            {isAdmin && (
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/projects?new=project');
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small text-accent hover:bg-surface-2"
              >
                + New project
              </button>
            )}
            <button
              onClick={() => {
                setOpen(false);
                navigate('/projects');
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small text-text-muted hover:bg-surface-2"
            >
              Manage projects
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut, theme, toggleTheme, environment, setEnvironment, range, setRange, currentProjectId } = useUi();
  // The time range now lives in the Issues filter bar itself — don't duplicate it
  // in the top bar (FR-UI-2).
  const pathname = useLocation().pathname;
  const showRange = false;
  const navigate = useNavigate();

  // Mobile: sidebar becomes an off-canvas drawer (GD-124). Close on route change.
  const [navOpen, setNavOpen] = React.useState(false);
  React.useEffect(() => setNavOpen(false), [pathname]);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectSummary[]>('/projects'),
  });
  const list = projects.data ?? [];
  const projectId = list.find((p) => p.id === currentProjectId)?.id ?? list[0]?.id;
  const envs = useQuery({
    queryKey: ['envs', projectId],
    enabled: !!projectId,
    queryFn: () => api<{ name: string }[]>(`/projects/${projectId}/environments`),
  });

  return (
    <div className="flex h-full">
      {/* Mobile drawer backdrop */}
      {navOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}
      {/* Left sidebar (brief §3) — off-canvas drawer < md, static ≥ md */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[220px] shrink-0 flex-col border-r border-border bg-surface transition-transform md:static md:z-auto md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="relative flex flex-col px-4 pt-3 pb-2">
          <button
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
            className="absolute right-3 top-3 rounded-md border border-border p-1 text-text-muted hover:bg-surface-2 md:hidden"
          >
            <CloseIcon size={16} />
          </button>
          <GeniusDebugWordmark size={24} />
          <a
            href="https://xgenious.com"
            target="_blank"
            rel="noreferrer"
            className="ml-[34px] mt-0.5 text-caption text-text-faint hover:text-accent"
          >
            by Xgenious
          </a>
        </div>
        <div className="px-3 py-2">
          <ProjectSwitcher projects={list} />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md border-l-2 px-2.5 py-1.5 text-small ${
                  isActive
                    ? 'border-accent bg-accent/10 text-text'
                    : 'border-transparent text-text-muted hover:bg-surface-2 hover:text-text'
                }`
              }
            >
              <n.Icon size={16} className="shrink-0" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          {/* Hover the user block → account menu opens to the right (brief §3). */}
          <div className="group relative">
            <button
              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface-2 group-hover:bg-surface-2"
              title="Account"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-caption font-semibold text-white">
                {(user?.name ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-small text-text">{user?.name}</div>
                <div className="truncate text-caption text-text-faint">{user?.role}</div>
              </div>
              <span className="text-text-faint">›</span>
            </button>
            {/* Bridge padding (pl-2) keeps hover alive while moving cursor rightward. */}
            <div className="invisible absolute bottom-0 left-full z-30 pl-2 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100">
              <div className="w-44 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg">
                <button
                  onClick={() => navigate('/account/profile')}
                  className="block w-full px-3 py-1.5 text-left text-small text-text-muted hover:bg-surface-2 hover:text-text"
                >
                  Edit profile
                </button>
                <button
                  onClick={() => navigate('/account/password')}
                  className="block w-full px-3 py-1.5 text-left text-small text-text-muted hover:bg-surface-2 hover:text-text"
                >
                  Change password
                </button>
              </div>
            </div>
          </div>
          <div className="mt-2 flex gap-1">
            <button
              onClick={toggleTheme}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-1 text-caption text-text-muted hover:bg-surface-2"
            >
              {theme === 'dark' ? <MoonIcon size={13} /> : <SunIcon size={13} />}
              {theme === 'dark' ? 'Dark' : 'Light'}
            </button>
            <button
              onClick={() => {
                signOut();
                navigate('/login');
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-1 text-caption text-text-muted hover:bg-surface-2"
            >
              <SignOutIcon size={13} />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-bg px-3 sm:gap-3 sm:px-5">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="shrink-0 rounded-md border border-border p-1.5 text-text-muted hover:bg-surface-2 md:hidden"
          >
            <MenuIcon size={18} />
          </button>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1.5 text-small text-text"
          >
            <option value="all">All Envs</option>
            {envs.data?.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
          <GlobalSearch />
          <div className="flex-1" />
          {showRange && (
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as IssueRange)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-small text-text"
              title="Time range — filters the issues feed by last-seen"
            >
              {(Object.keys(RANGE_LABELS) as IssueRange[]).map((r) => (
                <option key={r} value={r}>
                  {RANGE_LABELS[r]}
                </option>
              ))}
            </select>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
