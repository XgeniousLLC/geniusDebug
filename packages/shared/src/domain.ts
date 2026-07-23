/**
 * Internal domain DTOs — the contract between workers, api, and web.
 * Distinct from the Sentry wire types in envelope.ts.
 */

export type IssueLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';
export type IssueStatus = 'unresolved' | 'resolved' | 'archived' | 'muted';

/** A normalized event produced by the worker normalize step (FR-WRK-6). */
export interface NormalizedEvent {
  eventId: string;
  platform: string;
  level: IssueLevel;
  handled: boolean;
  timestamp: string; // ISO
  transaction?: string;
  url?: string;
  release?: string;
  environment: string;
  message?: string;
  exceptionType?: string;
  exceptionValue?: string;
  culprit?: string;
  frames: NormalizedFrame[];
  fingerprintOverride?: string[];
  contexts: {
    browser?: { name?: string; version?: string };
    os?: { name?: string; version?: string };
    device?: { family?: string; model?: string; brand?: string };
  };
  request?: Record<string, unknown>;
  user?: Record<string, unknown>;
  tags: Record<string, string>;
  breadcrumbs: Array<Record<string, unknown>>;
  sdk?: { name?: string; version?: string };
  traceId?: string;
  spanId?: string;
  replayId?: string;
  debugIds: string[];
}

export interface NormalizedFrame {
  filename?: string;
  absPath?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  inApp: boolean;
  preContext?: string[];
  contextLine?: string;
  postContext?: string[];
  /** Set by symbolication when GitHub is linked (FR-MAP-6 / FR-GH-3). */
  githubUrl?: string;
}

/** Issue as returned by the dashboard API (FR-UI-1/5). */
export interface IssueDto {
  id: string;
  shortId: string;
  projectId: string;
  title: string;
  culprit: string | null;
  type: string | null;
  level: IssueLevel;
  category: string;
  status: IssueStatus;
  isRegressed: boolean;
  assigneeUserId: string | null;
  firstSeen: string;
  lastSeen: string;
  timesSeen: number;
  usersAffected: number;
  environment?: string;
  /** Recent per-bucket event counts for the feed sparkline (oldest → newest). */
  spark?: number[];
  /** Display name of the assignee (for the avatar), when assigned. */
  assigneeName?: string | null;
}

/** Paginated issue feed response (FR-UI-2). */
export interface IssueListResponse {
  items: IssueDto[];
  total: number;
}

export interface EventDto {
  id: string;
  issueId: string;
  timestamp: string;
  level: IssueLevel;
  handled: boolean;
  transaction: string | null;
  url: string | null;
  message: string | null;
  release: string | null;
  environment: string;
  exception: { type?: string; value?: string; frames: NormalizedFrame[] } | null;
  contexts: Record<string, unknown>;
  request: Record<string, unknown> | null;
  user: Record<string, unknown> | null;
  tags: Record<string, string>;
  breadcrumbs: Array<Record<string, unknown>>;
  sdk: Record<string, unknown> | null;
  traceId: string | null;
  spanId: string | null;
}

export interface AuthUserDto {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: 'admin' | 'member';
}
