import { z } from 'zod';

/** Boundary validation (API DTOs). Ingest does its own shallow byte-level checks. */

export const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  orgName: z.string().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const issueActionSchema = z.object({
  action: z.enum(['resolve', 'unresolve', 'archive', 'unarchive', 'mute', 'unmute', 'assign']),
  assigneeUserId: z.string().uuid().optional(),
});
export type IssueActionInput = z.infer<typeof issueActionSchema>;

export const issueListQuerySchema = z.object({
  environment: z.string().optional(),
  status: z.enum(['unresolved', 'resolved', 'archived', 'muted', 'all']).optional(),
  category: z.enum(['error', 'warning', 'performance', 'security', 'network', 'ui', 'other', 'all']).optional(),
  query: z.string().optional(),
  sort: z.enum(['lastSeen', 'firstSeen', 'events', 'users']).optional(),
  // Time window on last-seen (FR-UI-2): 'all' = Since First Seen (no bound).
  range: z.enum(['24h', '7d', '14d', '30d', 'all']).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});
export type IssueListQuery = z.infer<typeof issueListQuerySchema>;
