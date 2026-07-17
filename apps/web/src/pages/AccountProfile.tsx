import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AuthUserDto } from '@geniusdebug/shared';
import { api, ApiError } from '../lib/api';
import { useUi } from '../store/ui';
import { Button, Card } from '../components/ui';
import { AccountLayout } from '../components/AccountLayout';

export function AccountProfile() {
  const user = useUi((s) => s.user);
  const setAuth = useUi((s) => s.setAuth);
  const [name, setName] = React.useState(user?.name ?? '');
  const [email, setEmail] = React.useState(user?.email ?? '');
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () => api<{ token: string; user: AuthUserDto }>('/auth/profile', { method: 'PATCH', body: JSON.stringify({ name, email }) }),
    onSuccess: (res) => {
      setAuth(res.token, res.user); // refresh token (email claim) + stored user
      setMsg({ ok: true, text: 'Profile updated.' });
    },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'update failed' }),
  });

  const inp = 'h-9 w-full rounded-md border border-border bg-bg px-2.5 text-small text-text';
  return (
    <AccountLayout>
      <Card className="p-5">
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-caption text-text-faint">Name</span>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-faint">Email</span>
          <input className={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {msg && <div className={`mt-3 text-caption ${msg.ok ? 'text-status-resolved' : 'text-level-error'}`}>{msg.text}</div>}
        <div className="mt-4">
          <Button variant="primary" size="sm" disabled={save.isPending || (!name.trim() && !email.trim())} onClick={() => { setMsg(null); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </Card>
    </AccountLayout>
  );
}
