import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, logSummary } from '../lib/policy.js';
test('redacts structured secrets, query strings, error causes and circular references', () => {
  const circular = { password: 'SECRET-1', nested: { apiKey: 'SECRET-2' }, url: 'https://u:p@example.org/path?token=SECRET-3', auth: 'Bearer SECRET-4', key: 'sk-proj-SECRET-5' };
  circular.self = circular;
  const error = new Error('password=SECRET-6', { cause: circular });
  const output = logSummary([error, circular, '{"token":"SECRET-7"}']);
  for (let i = 1; i <= 7; i++) assert.ok(!output.includes(`SECRET-${i}`));
  assert.ok(output.includes('[REDACTED]'));
});
test('source policy omits model/tool bodies and getters without executing them', () => {
  const value = { arguments: 'private arguments', content: 'private prompt', usage: { inputTokens: 3 }, get token() { throw new Error('must not execute'); } };
  const output = JSON.stringify(redact(value, true));
  assert.ok(!output.includes('private'));
  assert.ok(output.includes('inputTokens'));
  assert.ok(output.includes('Accessor omitted'));
});

test('quoted secrets and UTF-8 log budget remain bounded', () => {
  const output = logSummary(['api_key="secret phrase" password=\'another secret\'', '中'.repeat(10000)]);
  assert.ok(!output.includes('secret phrase'));
  assert.ok(!output.includes('another secret'));
  assert.ok(Buffer.byteLength(output) <= 8192);
});
