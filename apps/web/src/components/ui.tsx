import * as React from "react";

/* ------------------------------- Button ---------------------------------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none";
  const sizes =
    size === "sm" ? "h-7 px-2.5 text-caption" : "h-9 px-3.5 text-body";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-white hover:bg-accent-strong",
    secondary: "bg-surface border border-border text-text hover:bg-surface-2",
    ghost: "text-text-muted hover:bg-surface-2 hover:text-text",
    danger: "bg-level-error text-white hover:opacity-90",
  };
  return (
    <button
      className={`${base} ${sizes} ${variants[variant]} ${className}`}
      {...rest}
    />
  );
}

/* ------------------------------ Level pill -------------------------------- */
const LEVEL_COLORS: Record<string, string> = {
  fatal: "bg-level-fatal",
  error: "bg-level-error",
  warning: "bg-level-warning",
  info: "bg-level-info",
  debug: "bg-level-debug",
};
export function LevelPill({ level }: { level: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-text-muted uppercase tracking-wide">
      <span
        className={`h-2 w-2 rounded-full ${LEVEL_COLORS[level] ?? "bg-level-debug"}`}
        aria-hidden
      />
      {level}
    </span>
  );
}

/* ------------------------------ Status chip ------------------------------- */
const STATUS_STYLE: Record<string, string> = {
  unresolved: "text-status-unresolved border-status-unresolved/40",
  resolved: "text-status-resolved border-status-resolved/40",
  archived: "text-status-muted border-status-muted/40",
  muted: "text-status-muted border-status-muted/40",
};
export function StatusChip({
  status,
  regressed,
}: {
  status: string;
  regressed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`rounded-full border px-2 py-0.5 text-caption font-medium capitalize ${STATUS_STYLE[status] ?? ""}`}
      >
        {status}
      </span>
      {regressed && (
        <span className="rounded-full border border-regressed/40 px-2 py-0.5 text-caption font-medium text-regressed">
          regressed
        </span>
      )}
    </span>
  );
}

/* ---------------------------- Local dev badge ------------------------------ */
/** True when an event/issue URL is a local dev origin, not real traffic. Works for
 *  any platform (JS or PHP/Laravel) since `url` is populated on every request. */
export function isLocalUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function LocalDevBadge() {
  return (
    <span
      className="rounded-full border border-level-warning/40 px-2 py-0.5 text-caption font-medium text-level-warning"
      title="This event's URL is a localhost origin — likely a developer's local run, not real traffic"
    >
      Local Dev
    </span>
  );
}

/* --------------------------------- Tag ------------------------------------ */
export function Tag({
  k,
  v,
  onClick,
}: {
  k: string;
  v: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-caption hover:bg-surface-2"
    >
      <span className="text-text-faint">{k}</span>
      <span className="font-mono text-text">{v}</span>
    </button>
  );
}

/* ------------------------------- ID chip ---------------------------------- */
export function IdChip({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-caption text-text-muted hover:bg-surface-2"
    >
      {label && <span className="text-text-faint">{label}</span>}
      <span className="max-w-[220px] truncate">{value}</span>
      <span className="text-text-faint">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

/* --------------------------------- Card ----------------------------------- */
export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border border-border bg-surface ${className}`}>
      {children}
    </div>
  );
}

/* ------------------------------ Feed states ------------------------------- */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} />
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface/50 py-16 text-center">
      {icon && <div className="mb-1 text-text-faint">{icon}</div>}
      <div className="text-h2 font-semibold text-text">{title}</div>
      {hint && (
        <div className="max-w-md text-small text-text-muted">{hint}</div>
      )}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-level-error/30 bg-level-error/5 py-12 text-center">
      <div className="text-body text-level-error">{message}</div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
