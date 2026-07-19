const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4002';

const TOKEN_KEY = 'gd_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Human-readable message from a thrown ApiError/Error (for toasts). */
export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'request failed';
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.message ?? body.error ?? msg;
    } catch {
      /* ignore */
    }
    // Session expired/invalid → clear token and bounce to login (once).
    if (res.status === 401 && getToken()) {
      setToken(null);
      if (!location.pathname.startsWith('/login')) {
        location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
      }
    }
    throw new ApiError(res.status, typeof msg === 'string' ? msg : 'request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
