import * as React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GeniusDebugWordmark } from '../brand/GeniusDebugIcon';
import { useUi } from '../store/ui';
import { api } from '../lib/api';
import {
  IssuesIcon,
  TracesIcon,
  ReplaysIcon,
  AlertsIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  SignOutIcon,
  SearchIcon,
} from './icons';

const NAV = [
  { to: '/issues', label: 'Issues', Icon: IssuesIcon },
  { to: '/traces', label: 'Traces', Icon: TracesIcon },
  { to: '/replays', label: 'Replays', Icon: ReplaysIcon },
  { to: '/alerts', label: 'Alerts', Icon: AlertsIcon },
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
    <form onSubmit={submit} className="relative w-full max-w-md">
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

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut, theme, toggleTheme, environment, setEnvironment } = useUi();
  const navigate = useNavigate();

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ id: string; name: string }[]>('/projects'),
  });
  const projectId = projects.data?.[0]?.id;
  const envs = useQuery({
    queryKey: ['envs', projectId],
    enabled: !!projectId,
    queryFn: () => api<{ name: string }[]>(`/projects/${projectId}/environments`),
  });

  return (
    <div className="flex h-full">
      {/* Left sidebar (brief §3) */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex flex-col px-4 pt-3 pb-2">
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
          <div className="flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-small text-text-muted">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="truncate text-text">{projects.data?.[0]?.name ?? 'Taskip'}</span>
            <span className="ml-auto text-text-faint">▾</span>
          </div>
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
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-caption font-semibold text-white">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-small text-text">{user?.name}</div>
              <div className="truncate text-caption text-text-faint">{user?.role}</div>
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
        <header className="flex h-14 items-center gap-3 border-b border-border bg-bg px-5">
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-small text-text"
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
          <span className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-small text-text-muted">
            Since First Seen ▾
          </span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
