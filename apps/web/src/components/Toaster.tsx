import { useToasts, type ToastKind } from '../store/toast';

const tone: Record<ToastKind, { dot: string; ring: string }> = {
  success: { dot: 'bg-level-info', ring: 'border-l-level-info' },
  error: { dot: 'bg-level-error', ring: 'border-l-level-error' },
  info: { dot: 'bg-accent', ring: 'border-l-accent' },
};

/** Global toast stack (FR-UI): action success/failure feedback. Mounted in Shell. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border ${tone[t.kind].ring} border-l-4 bg-surface px-3 py-2.5 text-small text-text shadow-lg`}
        >
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone[t.kind].dot}`} />
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-text-faint hover:text-text"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
