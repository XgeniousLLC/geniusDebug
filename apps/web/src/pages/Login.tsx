import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GeniusDebugIcon } from '../brand/GeniusDebugIcon';
import { Button } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useUi } from '../store/ui';
import type { AuthUserDto } from '@geniusdebug/shared';

type Mode = 'login' | 'register';

/**
 * Auth page (brief §5 / FR-ADM-4). Supports first-time login: on a fresh install
 * (no users yet) it opens in "Create your account" mode and the first user
 * becomes org admin (auth.service provisions the default project + DSN).
 */
export function Login() {
  const navigate = useNavigate();
  const setAuth = useUi((s) => s.setAuth);
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => api<{ firstRun: boolean }>('/auth/status'),
    staleTime: 0,
  });

  const [mode, setMode] = React.useState<Mode>('login');
  React.useEffect(() => {
    if (status.data?.firstRun) setMode('register');
  }, [status.data?.firstRun]);

  const [name, setName] = React.useState('');
  const [orgName, setOrgName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const firstRun = status.data?.firstRun === true;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = mode === 'register' ? '/auth/register' : '/auth/login';
      const body = mode === 'register' ? { name, email, password, orgName: orgName || undefined } : { email, password };
      const res = await api<{ token: string; user: AuthUserDto }>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setAuth(res.token, res.user);
      navigate('/issues');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GeniusDebugIcon size={48} />
          <div>
            <div className="text-h1 font-semibold">
              genius<span className="text-text-faint">Debug</span>
            </div>
            <div className="text-small text-text-muted">
              {mode === 'register'
                ? firstRun
                  ? 'Create the first account — you become the admin'
                  : 'Create your account'
                : 'Sign in to triage errors'}
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6">
          {error && (
            <div className="rounded-md border border-level-error/40 bg-level-error/10 px-3 py-2 text-small text-level-error">
              {error}
            </div>
          )}

          {mode === 'register' && (
            <>
              <Field label="Name">
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
              <Field label="Organization" hint="optional">
                <input
                  className={inputCls}
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Xgenious"
                />
              </Field>
            </>
          )}

          <Field label="Email">
            <input
              type="email"
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </Field>

          <Field label="Password" hint={mode === 'register' ? 'min 8 characters' : undefined}>
            <input
              type="password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </Field>

          <Button type="submit" variant="primary" disabled={loading} className="mt-1">
            {loading ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </Button>

          {!firstRun && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode((m) => (m === 'login' ? 'register' : 'login'));
              }}
              className="text-center text-caption text-text-muted hover:text-accent"
            >
              {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text placeholder:text-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between">
        <span className="text-caption font-medium text-text-muted">{label}</span>
        {hint && <span className="text-caption text-text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
