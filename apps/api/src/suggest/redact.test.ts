import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, REDACT_PATH } from './redact';

test('masks API-key-shaped tokens', () => {
  assert.match(redact('const k = "sk-407823e85a884c3bbd66dacfd560f97b"'), /«REDACTED»/);
  assert.match(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123'), /«REDACTED»/);
  assert.match(redact('AKIAIOSFODNN7EXAMPLE'), /«REDACTED»/);
});

test('masks key=value secret assignments', () => {
  assert.match(redact('password: "hunter2secret"'), /«REDACTED»/);
  assert.match(redact('API_KEY=abcdef123456'), /«REDACTED»/);
});

test('masks PEM private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(pem).includes('MIIEabc'), false);
});

test('leaves ordinary source untouched', () => {
  const src = 'function add(a, b) { return a + b; }';
  assert.equal(redact(src), src);
});

test('REDACT_PATH blocks env/pem/key files, allows source', () => {
  assert.equal(REDACT_PATH.test('.env'), true);
  assert.equal(REDACT_PATH.test('config/.env.production'), true); // env variants also blocked
  assert.equal(REDACT_PATH.test('certs/server.pem'), true);
  assert.equal(REDACT_PATH.test('id_rsa.key'), true);
  assert.equal(REDACT_PATH.test('src/app.ts'), false);
});
