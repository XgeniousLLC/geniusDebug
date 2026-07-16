import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from './normalize';
import { computeFingerprint } from './fingerprint';
import type { SentryEventPayload } from '@geniusdebug/shared';

/**
 * v2 (Laravel/PHP) readiness — SRS §12. Proves the two cheap v1 hygiene decisions
 * hold so adding `sentry/sentry-laravel` is pure client config, no backend change:
 *   FR-WRK-7  — pipeline is platform-agnostic (php events normalize + group)
 *   FR-MAP-10 — symbolication is skipped when platform !== javascript
 */
const phpEvent: SentryEventPayload = {
  event_id: 'p'.repeat(32),
  platform: 'php',
  level: 'error',
  transaction: 'GET /api/users',
  exception: {
    values: [
      {
        type: 'RuntimeException',
        value: 'Undefined array key "id"',
        stacktrace: {
          frames: [
            {
              filename: '/var/www/app/Http/Controllers/UserController.php',
              abs_path: '/var/www/app/Http/Controllers/UserController.php',
              function: 'App\\Http\\Controllers\\UserController::show',
              lineno: 42,
              in_app: true,
            },
          ],
        },
      },
    ],
  },
};

test('php event normalizes with native frames intact (FR-WRK-7)', () => {
  const n = normalizeEvent(phpEvent);
  assert.equal(n.platform, 'php');
  assert.equal(n.exceptionType, 'RuntimeException');
  assert.equal(n.culprit, '/var/www/app/Http/Controllers/UserController.php');
  assert.equal(n.frames[0].lineno, 42);
});

test('php event groups deterministically like any other platform (FR-WRK-7)', () => {
  const a = computeFingerprint(normalizeEvent(phpEvent));
  const b = computeFingerprint(normalizeEvent({ ...phpEvent, event_id: 'q'.repeat(32) }));
  assert.equal(a, b, 'same php stack → same fingerprint');
});

test('symbolication is a no-op for non-JS platforms (FR-MAP-10)', async () => {
  // symbolicate() early-returns for platform !== javascript without touching R2/DB.
  const { symbolicate } = await import('./symbolicate');
  const n = normalizeEvent(phpEvent);
  const out = await symbolicate(n, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(out.frames, n.frames, 'frames unchanged — symbolication skipped');
});
