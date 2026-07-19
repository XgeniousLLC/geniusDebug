import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    // Auto-dismiss (errors linger longer so they can be read).
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Past-tense verb per issue action, for success toasts. */
export const ACTION_PAST: Record<string, string> = {
  resolve: 'resolved',
  unresolve: 'reopened',
  archive: 'archived',
  unarchive: 'unarchived',
  mute: 'muted',
  unmute: 'unmuted',
  assign: 'assignee updated',
};

/** Fire-and-forget helpers usable from anywhere (mutations, event handlers). */
export const toast = {
  success: (m: string) => useToasts.getState().push('success', m),
  error: (m: string) => useToasts.getState().push('error', m),
  info: (m: string) => useToasts.getState().push('info', m),
};
