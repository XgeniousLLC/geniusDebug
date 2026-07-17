import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card } from '../components/ui';
import { AccountLayout } from '../components/AccountLayout';

export function AccountPassword() {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const change = useMutation({
    mutationFn: () => api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ ok: true, text: 'Password changed.' });
    },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'change failed' }),
  });

  function submit() {
    setMsg(null);
    if (next.length < 8) return setMsg({ ok: false, text: 'New password must be at least 8 characters.' });
    if (next !== confirm) return setMsg({ ok: false, text: 'Passwords do not match.' });
    change.mutate();
  }

  const inp = 'h-9 w-full rounded-md border border-border bg-bg px-2.5 text-small text-text';
  return (
    <AccountLayout>
      <Card className="p-5">
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-caption text-text-faint">Current password</span>
          <input className={inp} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-caption text-text-faint">New password</span>
          <input className={inp} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">Confirm new password</span>
          <input className={inp} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {msg && <div className={`mt-3 text-caption ${msg.ok ? 'text-status-resolved' : 'text-level-error'}`}>{msg.text}</div>}
        <div className="mt-4">
          <Button variant="primary" size="sm" disabled={change.isPending || !current || !next || !confirm} onClick={submit}>
            {change.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </Card>
    </AccountLayout>
  );
}
