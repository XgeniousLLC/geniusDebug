/**
 * geniusDebug Drizzle schema — single source of truth (SRS §7).
 * Blobs (replay segments, source maps, attachments) live in R2; Postgres stores
 * metadata + r2Key pointers only. Tokens are stored hashed (NFR-SEC-5).
 * `events` is time-partitioned — Drizzle emits the base table; the
 * PARTITION BY RANGE (timestamp) + partitions are hand-authored (see migrations).
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

/* ---------------------------------- enums --------------------------------- */
export const memberRole = pgEnum('member_role', ['admin', 'member']);
export const issueStatus = pgEnum('issue_status', ['unresolved', 'resolved', 'archived', 'muted']);
export const issueLevel = pgEnum('issue_level', ['fatal', 'error', 'warning', 'info', 'debug']);
export const repoProvider = pgEnum('repo_provider', ['github']);
export const alertChannel = pgEnum('alert_channel', ['email']);

/* ------------------------------- org & auth ------------------------------- */
export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    // Password reset (brief §5). Token stored hashed; never plaintext.
    resetTokenHash: text('reset_token_hash'),
    resetExpires: timestamp('reset_expires', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ emailUq: uniqueIndex('users_email_uq').on(t.email) }),
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
  },
  (t) => ({ orgUserUq: uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId) }),
);

/* -------------------------------- projects -------------------------------- */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    slug: varchar('slug', { length: 160 }).notNull(),
    platform: varchar('platform', { length: 64 }).notNull().default('javascript-nextjs'),
    // FR-SDK-8 / NFR-PERF-4 remote kill switch + sample overrides (server-controlled).
    ingestEnabled: boolean('ingest_enabled').notNull().default(true),
    config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ orgSlugUq: uniqueIndex('projects_org_slug_uq').on(t.orgId, t.slug) }),
);

/** write-only ingest key (NFR-SEC-1). */
export const dsnKeys = pgTable(
  'dsn_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    publicKey: varchar('public_key', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    rateLimit: integer('rate_limit').notNull().default(3000),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({ pubKeyUq: uniqueIndex('dsn_keys_public_key_uq').on(t.publicKey) }),
);

/** secret CI/deploy uploader token — stored HASHED (NFR-SEC-2/5). */
export const orgTokens = pgTable('org_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  scope: varchar('scope', { length: 64 }).notNull().default('source-map-upload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
  },
  (t) => ({ projNameUq: uniqueIndex('environments_project_name_uq').on(t.projectId, t.name) }),
);

/* ------------------------ source control & releases ----------------------- */
export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  provider: repoProvider('provider').notNull().default('github'),
  owner: varchar('owner', { length: 160 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  defaultBranch: varchar('default_branch', { length: 160 }).notNull().default('main'),
  installationId: varchar('installation_id', { length: 120 }),
  tokenRef: text('token_ref'), // encrypted reference, never plaintext (NFR-SEC-5)
  connectedByUserId: uuid('connected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * GitHub App created via the Coolify-style manifest flow (FR-GH-1). One app per
 * org (v1), created against a personal or org GitHub account. Secrets (PEM,
 * client secret, webhook secret) are stored ENCRYPTED at rest (NFR-SEC-5).
 */
export const githubApps = pgTable(
  'github_apps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    slug: varchar('slug', { length: 160 }).notNull(),
    appId: varchar('app_id', { length: 64 }).notNull(),
    clientId: varchar('client_id', { length: 128 }).notNull(),
    clientSecretEnc: text('client_secret_enc').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    webhookSecretEnc: text('webhook_secret_enc'),
    // GitHub account the app was created under (personal login or org).
    ownerLogin: varchar('owner_login', { length: 160 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ orgUq: uniqueIndex('github_apps_org_uq').on(t.orgId) }),
);

export const releases = pgTable(
  'releases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    version: varchar('version', { length: 200 }).notNull(),
    commitSha: varchar('commit_sha', { length: 64 }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ projVerUq: uniqueIndex('releases_project_version_uq').on(t.projectId, t.version) }),
);

export const sourceMapArtifacts = pgTable(
  'source_map_artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    releaseId: uuid('release_id').notNull().references(() => releases.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    debugId: varchar('debug_id', { length: 64 }).notNull(),
    artifactUrl: text('artifact_url'),
    r2Key: text('r2_key').notNull(),
    checksum: varchar('checksum', { length: 128 }),
    size: bigint('size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // symbolication lookup — debug_id is the primary match key (FR-MAP-2/3)
    projDebugIdx: index('sma_project_debug_idx').on(t.projectId, t.debugId),
  }),
);

/* --------------------------------- issues --------------------------------- */
export const issues = pgTable(
  'issues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    shortId: varchar('short_id', { length: 64 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    title: text('title').notNull(),
    culprit: text('culprit'),
    type: varchar('type', { length: 160 }),
    level: issueLevel('level').notNull().default('error'),
    status: issueStatus('status').notNull().default('unresolved'),
    isRegressed: boolean('is_regressed').notNull().default(false),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
    timesSeen: integer('times_seen').notNull().default(0),
    usersAffected: integer('users_affected').notNull().default(0),
    firstReleaseId: uuid('first_release_id').references(() => releases.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // issue list feed (FR-UI-1..3)
    listIdx: index('issues_list_idx').on(t.projectId, t.status, t.lastSeen),
    fingerprintUq: uniqueIndex('issues_project_fingerprint_uq').on(t.projectId, t.fingerprint),
    firstSeenIdx: index('issues_first_seen_idx').on(t.projectId, t.firstSeen),
    shortIdUq: uniqueIndex('issues_project_short_id_uq').on(t.projectId, t.shortId),
  }),
);

/**
 * events — time-partitioned by `timestamp` (declared in a hand-authored migration).
 * Composite PK (id, timestamp) is required by Postgres for a partitioned table.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').notNull(), // event_id
    issueId: uuid('issue_id').notNull(),
    projectId: uuid('project_id').notNull(),
    environmentId: uuid('environment_id'),
    releaseId: uuid('release_id'),
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
    level: issueLevel('level').notNull().default('error'),
    handled: boolean('handled').notNull().default(true),
    transaction: text('transaction'),
    url: text('url'),
    message: text('message'),
    platform: varchar('platform', { length: 64 }).notNull().default('javascript'),
    exception: jsonb('exception').$type<Record<string, unknown>>(),
    contexts: jsonb('contexts').$type<Record<string, unknown>>(),
    request: jsonb('request').$type<Record<string, unknown>>(),
    user: jsonb('user').$type<Record<string, unknown>>(),
    tags: jsonb('tags').$type<Record<string, string>>(),
    breadcrumbs: jsonb('breadcrumbs').$type<Array<Record<string, unknown>>>(),
    sdk: jsonb('sdk').$type<Record<string, unknown>>(),
    traceId: varchar('trace_id', { length: 64 }),
    spanId: varchar('span_id', { length: 64 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.timestamp] }),
    issueTsIdx: index('events_issue_ts_idx').on(t.issueId, t.timestamp),
    projectTsIdx: index('events_project_ts_idx').on(t.projectId, t.timestamp),
    traceIdx: index('events_trace_idx').on(t.traceId),
  }),
);

/** aggregate/time-series counts so we don't store every duplicate at full fidelity (FR-RET-2). */
export const issueCounts = pgTable(
  'issue_counts',
  {
    issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.issueId, t.bucket] }) }),
);

/* -------------------------------- tracing --------------------------------- */
export const traces = pgTable('traces', {
  traceId: varchar('trace_id', { length: 64 }).primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  rootTransaction: text('root_transaction'),
  startTs: timestamp('start_ts', { withTimezone: true }),
  endTs: timestamp('end_ts', { withTimezone: true }),
  environmentId: uuid('environment_id'),
  releaseId: uuid('release_id'),
  platform: varchar('platform', { length: 64 }).notNull().default('javascript'),
});

export const spans = pgTable(
  'spans',
  {
    id: varchar('span_id', { length: 64 }).primaryKey(),
    traceId: varchar('trace_id', { length: 64 }).notNull(),
    parentSpanId: varchar('parent_span_id', { length: 64 }),
    op: varchar('op', { length: 160 }),
    description: text('description'),
    startTs: timestamp('start_ts', { withTimezone: true }),
    endTs: timestamp('end_ts', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    status: varchar('status', { length: 64 }),
  },
  (t) => ({ traceIdx: index('spans_trace_idx').on(t.traceId) }),
);

/* --------------------------------- replay --------------------------------- */
export const replays = pgTable(
  'replays',
  {
    id: uuid('id').defaultRandom().primaryKey(), // replay_id
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    eventId: uuid('event_id'),
    traceId: varchar('trace_id', { length: 64 }),
    user: jsonb('user').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    segmentCount: integer('segment_count').notNull().default(0),
    r2Prefix: text('r2_prefix').notNull(),
    size: bigint('size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    issueIdx: index('replays_issue_idx').on(t.issueId),
    traceIdx: index('replays_trace_idx').on(t.traceId),
  }),
);

/* ------------------------------ alerting ---------------------------------- */
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull(),
  environmentFilter: varchar('environment_filter', { length: 120 }),
  levelFilter: issueLevel('level_filter'),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  channel: alertChannel('channel').notNull().default('email'),
  throttleWindow: integer('throttle_window').notNull().default(3600), // seconds (FR-ALR-4)
  isActive: boolean('is_active').notNull().default(true),
  mutedUntil: timestamp('muted_until', { withTimezone: true }), // snooze window (FR-ALR-7)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
    channel: alertChannel('channel').notNull().default('email'),
    status: varchar('status', { length: 64 }).notNull().default('sent'),
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
  },
  (t) => ({ dedupeIdx: index('notifications_dedupe_idx').on(t.dedupeKey, t.sentAt) }),
);

export const issueActivity = pgTable('issue_activity', {
  id: uuid('id').defaultRandom().primaryKey(),
  issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 64 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const schema = {
  organizations,
  users,
  memberships,
  projects,
  dsnKeys,
  orgTokens,
  environments,
  githubApps,
  repositories,
  releases,
  sourceMapArtifacts,
  issues,
  events,
  issueCounts,
  traces,
  spans,
  replays,
  alertRules,
  notifications,
  issueActivity,
};
