import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';
import {
  buildAgentMarkdown,
  inferPlatform,
  scrubHeaders,
  redactValue,
  renderBreadcrumbs,
} from './agentMarkdown.js';

const issue: IssueDto = {
  id: 'i1',
  shortId: 'TASKIP-API-A0BC85',
  projectId: 'p1',
  title: 'Attempt to read property "id" on string',
  culprit: 'Modules/Invoice/app/Transformers/RecurringResource.php',
  type: 'ErrorException',
  level: 'warning',
  category: 'network',
  status: 'unresolved',
  isRegressed: true,
  assigneeUserId: null,
  firstSeen: '2026-08-07T13:48:00.911Z',
  lastSeen: '2026-09-14T08:12:53.389Z',
  timesSeen: 28,
  usersAffected: 0,
};

const vendorFrame = (over: Partial<NormalizedFrame>): NormalizedFrame => ({
  filename: '/vendor/laravel/framework/src/Illuminate/Pipeline/Pipeline.php',
  function: 'Illuminate\\Pipeline\\Pipeline::carry',
  lineno: 219,
  inApp: false,
  preContext: ['$x = 1;'],
  contextLine: '$pipe->{$this->method}(...$parameters)',
  postContext: ['return $x;'],
  ...over,
});

const laravelEvent: EventDto = {
  id: 'evt-1',
  issueId: 'i1',
  timestamp: '2026-09-14T08:12:53.389Z',
  level: 'warning',
  handled: true,
  transaction: '/api/v1/recurring/invoice/list',
  url: 'https://api.taskip.net/api/v1/recurring/invoice/list?payment_gateway=stripe_payment',
  message: null,
  release: 'abc123',
  environment: 'production',
  exception: {
    type: 'ErrorException',
    value: 'Trying to access array offset on null',
    frames: [
      vendorFrame({}),
      vendorFrame({ lineno: 180 }),
      {
        filename: '/Modules/Invoice/app/Transformers/RecurringResource.php',
        function: 'Modules\\Invoice\\Transformers\\RecurringResource::toArray',
        lineno: 44,
        inApp: true,
        preContext: ['"subject" => $invoice?->subject ?? $customerLabel,'],
        contextLine: '"price" => $this->resource[\'plan\'][\'amount\'],',
        postContext: ['"interval" => $this->resource[\'plan\'][\'interval\'],'],
      },
      vendorFrame({ lineno: 103 }),
    ],
  },
  contexts: {
    os: { name: 'Linux', version: '6.8.0' },
    culture: { timezone: 'UTC' },
    trace: { trace_id: 'abc', status: 'ok' },
  },
  request: {
    method: 'GET',
    url: 'https://api.taskip.net/api/v1/recurring/invoice/list?payment_gateway=stripe_payment',
    query_string: 'payment_gateway=stripe_payment',
    headers: {
      'User-Agent': 'Mozilla/5.0 Test',
      Accept: 'application/json',
      Cookie: 'session=secret-value',
      Authorization: 'Bearer super-secret',
    },
    data: { payment_gateway: 'stripe_payment', password: 'hunter2', nested: { api_key: 'k' } },
  },
  user: { id: 'u-7', email: 'user@example.com' },
  tags: { command: 'queue:work database', 'os.name': 'Linux' },
  breadcrumbs: [
    { category: 'db.sql.query', message: 'select * from t where id = ?' },
    { category: 'db.sql.query', message: 'select * from t where id = ?' },
    { category: 'db.sql.query', message: 'select * from t where id = ?' },
    { category: 'cache', message: 'Missed: some-key' },
  ],
  sdk: { name: 'sentry.php', version: '4.0' },
  traceId: '25456741d0484cc38fbf4b417565dc82',
  spanId: null,
};

test('inferPlatform detects php / javascript / fallbacks', () => {
  assert.equal(inferPlatform(laravelEvent), 'php');
  assert.equal(inferPlatform({ ...laravelEvent, sdk: { name: '@sentry/nextjs' } }), 'javascript');
  assert.equal(inferPlatform({ ...laravelEvent, sdk: null, tags: {} }), 'unknown');
  // fallback clues when sdk is missing
  assert.equal(inferPlatform({ ...laravelEvent, sdk: null }), 'php'); // command tag
  assert.equal(
    inferPlatform({ ...laravelEvent, sdk: null, tags: {}, contexts: { browser: { name: 'Chrome' } } }),
    'javascript',
  );
});

test('scrubHeaders drops cookie/authorization', () => {
  const out = scrubHeaders((laravelEvent.request as Record<string, unknown>)['headers']);
  const keys = out.map(([k]) => k.toLowerCase());
  assert.ok(keys.includes('user-agent'));
  assert.ok(!keys.includes('cookie'));
  assert.ok(!keys.includes('authorization'));
});

test('redactValue redacts secret keys at any depth', () => {
  const out = redactValue(null, { a: 'x', password: 'hunter2', nested: { api_key: 'k', ok: 1 } }) as Record<string, unknown>;
  assert.equal(out['password'], '[redacted]');
  assert.equal((out['nested'] as Record<string, unknown>)['api_key'], '[redacted]');
  assert.equal((out['nested'] as Record<string, unknown>)['ok'], 1);
});

test('renderBreadcrumbs dedupes consecutive repeats', () => {
  const lines = renderBreadcrumbs(laravelEvent.breadcrumbs);
  assert.ok(lines.some((l) => l.includes('(×3 repeated)')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('Missed: some-key')));
});

test('laravel export has request, user, suspect, collapsed trace, command', () => {
  const md = buildAgentMarkdown(issue, laravelEvent, {
    occurrenceLabel: 'Event 1 of 28',
    links: { issueUrl: 'https://gd/issues/X', traceUrl: 'https://gd/traces/T', replayUrl: null },
  });
  // prime suspect first-class
  assert.ok(md.includes('## 🎯 Prime suspect'));
  assert.ok(md.includes('RecurringResource.php:44'));
  // request
  assert.ok(md.includes('## HTTP Request'));
  assert.ok(md.includes('GET https://api.taskip.net'));
  assert.ok(md.includes('**User-Agent**'));
  assert.ok(md.includes('payment_gateway=stripe_payment'));
  assert.ok(!md.includes('super-secret'), 'auth header must not leak');
  assert.ok(!md.includes('session=secret-value'), 'cookie must not leak');
  assert.ok(md.includes('"password": "[redacted]"'), 'body secrets redacted');
  // user
  assert.ok(md.includes('## Affected user'));
  assert.ok(md.includes('user@example.com'));
  // collapsed vendor run, full in-app context kept
  assert.ok(md.includes('framework frames collapsed'));
  assert.ok(md.includes('"price" => $this->resource'));
  // php environment: artisan command + runtime/os
  assert.ok(md.includes('**Artisan command**: `queue:work database`'));
  // all contexts dumped (not just browser/os/device)
  assert.ok(md.includes('### culture'));
  assert.ok(md.includes('### trace'));
  // derived + stored tags
  assert.ok(md.includes('command: queue:work database'));
  // occurrence + links
  assert.ok(md.includes('Event 1 of 28'));
  assert.ok(md.includes('https://gd/issues/X'));
  assert.ok(md.includes('platform `php-laravel`'));
});

test('next.js export has browser env, component stack, links', () => {
  const jsEvent: EventDto = {
    ...laravelEvent,
    id: 'evt-2',
    sdk: { name: 'sentry.javascript.nextjs', version: '8.0' },
    tags: {},
    request: null,
    user: null,
    contexts: {
      browser: { name: 'Chrome', version: '120.0' },
      os: { name: 'macOS', version: '14.0' },
      device: { family: 'Mac' },
    },
    exception: {
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'json')",
      frames: [
        { filename: 'app/page.tsx', function: 'Page', lineno: 10, inApp: true, contextLine: 'const x = data.json();' },
      ],
      componentStackFrames: [
        { filename: 'components/List.tsx', function: 'List', lineno: 5, inApp: true, contextLine: '<Item/>' },
      ],
    },
  };
  const md = buildAgentMarkdown(issue, jsEvent, {
    links: { replayUrl: 'https://gd/replays/R' },
  });
  assert.ok(md.includes('platform `javascript`'));
  assert.ok(md.includes('**Browser**: Chrome 120.0'));
  assert.ok(md.includes('## React component stack'));
  assert.ok(md.includes('List.tsx'));
  assert.ok(md.includes('https://gd/replays/R'));
  assert.ok(!md.includes('## HTTP Request'), 'no request section when nothing captured');
  assert.ok(!md.includes('## Affected user'), 'no user section when nothing captured');
});
