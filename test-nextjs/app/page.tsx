'use client';
import * as Sentry from '@sentry/nextjs';
import { useState } from 'react';

export default function Home() {
  const [boom, setBoom] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [form, setForm] = useState({
    name: '',
    workEmail: '',
    pass: '',
    phone: '',
    company: '',
    role: 'developer',
    plan: 'pro',
    message: '',
    subscribe: false,
    agree: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const dsnSet = !!process.env.NEXT_PUBLIC_SENTRY_DSN;

  const note = (m: string) => setLog((l) => [`${m}`, ...l].slice(0, 8));
  const setF = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Fill the whole form → submit → the "server" call blows up. The entire flow
  // (typing every field, selecting, checking boxes, the submit click, the error)
  // is what the replay should capture.
  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    note(`submitting: ${form.name} <${form.workEmail}> · ${form.company}`);
    Sentry.addBreadcrumb({ category: 'ui.submit', message: 'signup form submitted', level: 'info' });
    setTimeout(() => {
      try {
        // Simulated API response that doesn't have the shape we expect → TypeError.
        const apiResponse: { data?: { user?: { profile?: { id: string } } } } = {};
        const id = (apiResponse.data as { user: { profile: { id: string } } }).user.profile.id;
        note(`ok id=${id}`);
      } catch (err) {
        Sentry.captureException(err, { extra: { form: { ...form, pass: '[redacted]' } } });
        note('form submit failed → error captured');
      } finally {
        setSubmitting(false);
      }
    }, 400);
  };

  // Render-time crash → global-error.tsx → captureException.
  if (boom) throw new Error('TEST render crash: Cannot read properties of undefined (reading "json")');

  return (
    <main style={s.wrap}>
      <h1 style={s.h1}>geniusDebug — local test app</h1>
      <p style={s.sub}>
        Fires errors + records a session replay into your locally running geniusDebug.
      </p>

      <div style={dsnSet ? s.ok : s.warn}>
        {dsnSet
          ? 'NEXT_PUBLIC_SENTRY_DSN is set → events tunnel through /monitoring → ingest.'
          : 'NEXT_PUBLIC_SENTRY_DSN is NOT set. Copy .env.local.example → .env.local, paste your DSN, restart.'}
      </div>

      <section style={s.card}>
        <h2 style={s.h2}>1 · Trigger errors</h2>
        <div style={s.row}>
          <button style={s.btn} onClick={() => setBoom(true)}>
            Render crash
          </button>
          <button
            style={s.btn}
            onClick={() => {
              Sentry.captureException(new Error('TEST handled: manual captureException'));
              note('captured handled error');
            }}
          >
            Handled error
          </button>
          <button
            style={s.btn}
            onClick={() => {
              setTimeout(() => {
                throw new Error('TEST unhandled: async setTimeout throw');
              }, 0);
              note('threw unhandled async error');
            }}
          >
            Unhandled async
          </button>
          <button
            style={s.btn}
            onClick={() => {
              void Promise.reject(new Error('TEST unhandled promise rejection'));
              note('rejected a promise');
            }}
          >
            Promise rejection
          </button>
        </div>
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>2 · Replay masking check</h2>
        <p style={s.p}>
          Type in both fields, then trigger an error. In the replay the email stays
          <b> readable</b>; the password renders <b>masked</b>.
        </p>
        <div style={s.form}>
          <input
            style={s.input}
            placeholder="email (visible in replay)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            style={s.input}
            type="password"
            placeholder="password (masked in replay)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>3 · Generate replay activity</h2>
        <p style={s.p}>Click around to give the replay some DOM to render, then fire an error.</p>
        <div style={s.row}>
          <button style={s.btn} onClick={() => note(`clicked at ${log.length}`)}>
            Click me
          </button>
          <button style={s.btn} onClick={() => note('another interaction')}>
            And me
          </button>
        </div>
        <ul style={s.log}>
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>

      <section style={s.card}>
        <h2 style={s.h2}>4 · Full form → submit → error</h2>
        <p style={s.p}>
          Fill every field and submit. The whole flow — typing, selecting, checkboxes, the submit
          click, then the error — is captured in one replay. Passwords render masked; everything else
          is readable so you can reproduce the exact input.
        </p>
        <form style={s.form} onSubmit={submitForm}>
          <div style={s.grid2}>
            <label style={s.field}>
              <span style={s.label}>Full name</span>
              <input style={s.input} value={form.name} onChange={(e) => setF('name', e.target.value)} placeholder="Ada Lovelace" />
            </label>
            <label style={s.field}>
              <span style={s.label}>Work email</span>
              <input style={s.input} type="email" value={form.workEmail} onChange={(e) => setF('workEmail', e.target.value)} placeholder="ada@acme.com" />
            </label>
            <label style={s.field}>
              <span style={s.label}>Password (masked)</span>
              <input style={s.input} type="password" value={form.pass} onChange={(e) => setF('pass', e.target.value)} placeholder="••••••••" />
            </label>
            <label style={s.field}>
              <span style={s.label}>Phone</span>
              <input style={s.input} value={form.phone} onChange={(e) => setF('phone', e.target.value)} placeholder="+1 555 0100" />
            </label>
            <label style={s.field}>
              <span style={s.label}>Company</span>
              <input style={s.input} value={form.company} onChange={(e) => setF('company', e.target.value)} placeholder="Acme Inc" />
            </label>
            <label style={s.field}>
              <span style={s.label}>Role</span>
              <select style={s.input} value={form.role} onChange={(e) => setF('role', e.target.value)}>
                <option value="developer">Developer</option>
                <option value="designer">Designer</option>
                <option value="pm">Product Manager</option>
                <option value="founder">Founder</option>
              </select>
            </label>
          </div>

          <div>
            <span style={s.label}>Plan</span>
            <div style={{ ...s.row, marginTop: 6 }}>
              {['free', 'pro', 'enterprise'].map((p) => (
                <label key={p} style={s.radio}>
                  <input type="radio" name="plan" checked={form.plan === p} onChange={() => setF('plan', p)} /> {p}
                </label>
              ))}
            </div>
          </div>

          <label style={s.field}>
            <span style={s.label}>Message</span>
            <textarea style={{ ...s.input, minHeight: 70, resize: 'vertical' }} value={form.message} onChange={(e) => setF('message', e.target.value)} placeholder="What are you building?" />
          </label>

          <label style={s.check}>
            <input type="checkbox" checked={form.subscribe} onChange={(e) => setF('subscribe', e.target.checked)} /> Subscribe to product updates
          </label>
          <label style={s.check}>
            <input type="checkbox" checked={form.agree} onChange={(e) => setF('agree', e.target.checked)} /> I agree to the terms
          </label>

          <button type="submit" disabled={submitting} style={{ ...s.btn, background: '#111', color: '#fff', borderColor: '#111', flex: '0 0 auto', minWidth: 160 }}>
            {submitting ? 'Submitting…' : 'Create account'}
          </button>
        </form>
      </section>
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 640, margin: '0 auto', padding: '32px 20px', fontFamily: 'system-ui, sans-serif', color: '#111' },
  h1: { fontSize: 24, fontWeight: 700, margin: '0 0 4px' },
  sub: { color: '#555', margin: '0 0 20px' },
  h2: { fontSize: 15, fontWeight: 600, margin: '0 0 10px' },
  p: { color: '#555', fontSize: 14, margin: '0 0 12px' },
  card: { border: '1px solid #e5e5e5', borderRadius: 12, padding: 18, margin: '0 0 16px', background: '#fafafa' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  btn: { padding: '9px 14px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 14, flex: '1 1 auto', minWidth: 120 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14, width: '100%', boxSizing: 'border-box' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, color: '#666', fontWeight: 500 },
  radio: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, textTransform: 'capitalize', border: '1px solid #ddd', borderRadius: 8, padding: '6px 12px', background: '#fff' },
  check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#333' },
  log: { margin: '12px 0 0', paddingLeft: 18, color: '#666', fontSize: 13 },
  ok: { padding: '10px 12px', borderRadius: 8, background: '#e7f6ec', color: '#1a7f3c', fontSize: 13, margin: '0 0 20px' },
  warn: { padding: '10px 12px', borderRadius: 8, background: '#fdecea', color: '#b3261e', fontSize: 13, margin: '0 0 20px' },
};
