import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint } from './fingerprint';
import type { NormalizedEvent } from '@geniusdebug/shared';

function evt(over: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    eventId: 'e1',
    platform: 'javascript',
    level: 'error',
    handled: true,
    timestamp: new Date().toISOString(),
    environment: 'production',
    exceptionType: 'TypeError',
    exceptionValue: "Cannot read properties of undefined (reading 'json')",
    frames: [],
    tags: {},
    breadcrumbs: [],
    contexts: {},
    debugIds: [],
    ...over,
  };
}

test('same in-app frames → same fingerprint (FR-GRP-1)', () => {
  const frames = [{ module: 'stores/inbox/useInboxConversations', function: 'fetchConversations', inApp: true, lineno: 42 }];
  const a = computeFingerprint(evt({ frames }));
  const b = computeFingerprint(evt({ frames, eventId: 'e2' }));
  assert.equal(a, b);
});

test('different function → different fingerprint', () => {
  const a = computeFingerprint(evt({ frames: [{ module: 'm', function: 'f1', inApp: true }] }));
  const b = computeFingerprint(evt({ frames: [{ module: 'm', function: 'f2', inApp: true }] }));
  assert.notEqual(a, b);
});

test('no frames → falls back to type + normalized message', () => {
  const a = computeFingerprint(evt({ frames: [], exceptionValue: 'timeout after 500ms' }));
  const b = computeFingerprint(evt({ frames: [], exceptionValue: 'timeout after 900ms' }));
  assert.equal(a, b, 'numbers normalized so both group');
});

test('client fingerprint override wins (FR-GRP-6)', () => {
  const a = computeFingerprint(evt({ fingerprintOverride: ['custom-group'] }));
  const b = computeFingerprint(evt({ fingerprintOverride: ['custom-group'], exceptionType: 'Other' }));
  assert.equal(a, b);
});
