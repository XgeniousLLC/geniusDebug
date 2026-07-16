/**
 * Sentry envelope protocol types (the pinned ingest contract — golden rule 3).
 * We reuse the stock @sentry/nextjs SDK; the envelope shape is an external
 * interface. Keep these platform-agnostic (FR-WRK-7): `platform` may be
 * `javascript` (v1) or `php` (v2) etc.
 *
 * Ref: develop.sentry.dev/sdk/foundations/envelopes / data-model/envelope-items
 */

/** Item types we route in workers (FR-WRK-5). Unknown types are ignored safely. */
export type EnvelopeItemType =
  | 'event'
  | 'transaction'
  | 'replay_event'
  | 'replay_recording'
  | 'attachment'
  | 'session'
  | 'client_report';

export interface EnvelopeHeader {
  event_id?: string;
  dsn?: string;
  sent_at?: string;
  sdk?: { name?: string; version?: string };
  trace?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface EnvelopeItemHeader {
  type: EnvelopeItemType | string;
  length?: number;
  content_type?: string;
  filename?: string;
  [k: string]: unknown;
}

export interface RawEnvelopeItem {
  header: EnvelopeItemHeader;
  /** Raw payload bytes; parsed lazily in workers, never in the hot path. */
  payload: Buffer;
}

export interface ParsedEnvelope {
  header: EnvelopeHeader;
  items: RawEnvelopeItem[];
}

/** ---- Sentry event item payload (subset we map — FR-WRK-6) ---- */

export interface SentryStackFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
}

export interface SentryStacktrace {
  frames?: SentryStackFrame[];
}

export interface SentryException {
  type?: string;
  value?: string;
  module?: string;
  stacktrace?: SentryStacktrace;
  mechanism?: { handled?: boolean; type?: string };
}

export interface SentryEventPayload {
  event_id?: string;
  timestamp?: number | string;
  platform?: string; // 'javascript' | 'php' | ...
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  logger?: string;
  transaction?: string;
  release?: string;
  environment?: string;
  message?: string | { formatted?: string; message?: string };
  fingerprint?: string[];
  exception?: { values?: SentryException[] };
  request?: { url?: string; method?: string; headers?: Record<string, string> };
  user?: { id?: string; email?: string; username?: string; ip_address?: string; [k: string]: unknown };
  tags?: Record<string, string>;
  contexts?: {
    browser?: { name?: string; version?: string };
    os?: { name?: string; version?: string };
    device?: { family?: string; model?: string; brand?: string };
    trace?: { trace_id?: string; span_id?: string; op?: string };
    [k: string]: unknown;
  };
  breadcrumbs?: { values?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  sdk?: { name?: string; version?: string };
  debug_meta?: { images?: Array<{ debug_id?: string; code_file?: string; type?: string }> };
}

/** ---- Transaction (trace) item payload (FR-TRC-1) ---- */
export interface SentrySpan {
  span_id: string;
  parent_span_id?: string;
  trace_id: string;
  op?: string;
  description?: string;
  start_timestamp: number;
  timestamp: number;
  status?: string;
}

export interface SentryTransactionPayload extends SentryEventPayload {
  type?: 'transaction';
  start_timestamp?: number;
  spans?: SentrySpan[];
  contexts?: SentryEventPayload['contexts'] & {
    trace?: { trace_id?: string; span_id?: string; op?: string; description?: string };
  };
}
