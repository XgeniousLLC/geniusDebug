import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { GeniusDebugIcon } from '../brand/GeniusDebugIcon';
import { Button } from '../components/ui';
import { api, ApiError } from '../lib/api';

/** Reset via tokenized link (brief §5). */
export function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const email = params.get('email') ?? '';
  const token = params.get('token') ?? '';
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api('/auth/reset', { method: 'POST', body: JSON.stringify({ email, token, password }) });
      navigate('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GeniusDebugIcon size={44} />
          <div className="text-h1 font-semibold">Set a new password</div>
          <div className="text-small text-text-muted">{email}</div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6">
          {error && (
            <div className="rounded-md border border-level-error/40 bg-level-error/10 px-3 py-2 text-small text-level-error">{error}</div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-caption font-medium text-text-muted">New password (min 8)</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text"
            />
          </label>
          <Button type="submit" variant="primary" disabled={loading || !token}>
            {loading ? 'Saving…' : 'Reset password'}
          </Button>
          <Link to="/login" className="text-center text-caption text-text-muted hover:text-accent">← Back to sign in</Link>
        </form>
      </div>
    </div>
  );
}
