import * as React from 'react';
import { Link } from 'react-router-dom';
import { GeniusDebugIcon } from '../brand/GeniusDebugIcon';
import { Button } from '../components/ui';
import { api } from '../lib/api';

/** Forgot password (brief §5). Dev returns the reset link inline (SES sends it in prod). */
export function Forgot() {
  const [email, setEmail] = React.useState('');
  const [done, setDone] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api<{ ok: true; devLink?: string }>('/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setDone(res.devLink ?? 'If that email exists, a reset link was sent.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <GeniusDebugIcon size={44} />
          <div className="text-h1 font-semibold">Reset password</div>
        </div>
        {done ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-small">
            {done.startsWith('http') ? (
              <>
                <div className="mb-2 text-text-muted">Dev reset link:</div>
                <a href={done} className="break-all font-mono text-caption text-accent hover:underline">{done}</a>
              </>
            ) : (
              <span className="text-text">{done}</span>
            )}
            <Link to="/login" className="mt-4 block text-caption text-text-muted hover:text-accent">← Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6">
            <label className="flex flex-col gap-1">
              <span className="text-caption font-medium text-text-muted">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text"
              />
            </label>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </Button>
            <Link to="/login" className="text-center text-caption text-text-muted hover:text-accent">← Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
