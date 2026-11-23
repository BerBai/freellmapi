import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPermanentModelRejection,
  parseNonNegativeInteger,
  resolveDiscoveryPlatforms,
} from '../src/prepare-lib.mjs';

test('discovers only existing platforms by default', () => {
  assert.deepEqual(
    resolveDiscoveryPlatforms({
      available: new Set(['groq', 'cerebras', 'new-provider']),
      existing: new Set(['groq', 'cerebras']),
      setting: 'existing',
    }),
    ['cerebras', 'groq'],
  );
});

test('supports all, none and explicit platform lists', () => {
  const input = {
    available: new Set(['groq', 'cerebras']),
    existing: new Set(['groq']),
  };
  assert.deepEqual(resolveDiscoveryPlatforms({ ...input, setting: 'all' }), ['cerebras', 'groq']);
  assert.deepEqual(resolveDiscoveryPlatforms({ ...input, setting: 'none' }), []);
  assert.deepEqual(
    resolveDiscoveryPlatforms({ ...input, setting: 'groq, cerebras, groq' }),
    ['groq', 'cerebras'],
  );
});

test('only permanent model rejections are disable candidates', () => {
  assert.equal(isPermanentModelRejection('HTTP 404: model not found'), true);
  assert.equal(isPermanentModelRejection('403 forbidden: unsupported model'), true);
  assert.equal(isPermanentModelRejection('429 rate limit exceeded'), false);
  assert.equal(isPermanentModelRejection('quota exhausted for this model'), false);
  assert.equal(isPermanentModelRejection('fetch failed: ETIMEDOUT'), false);
  assert.equal(isPermanentModelRejection('503 temporarily overloaded'), false);
});

test('parses non-negative integer limits', () => {
  assert.equal(parseNonNegativeInteger(undefined, 20, 'LIMIT'), 20);
  assert.equal(parseNonNegativeInteger('0', 20, 'LIMIT'), 0);
  assert.equal(parseNonNegativeInteger('7', 20, 'LIMIT'), 7);
  assert.throws(() => parseNonNegativeInteger('-1', 20, 'LIMIT'), />= 0/);
  assert.throws(() => parseNonNegativeInteger('1.5', 20, 'LIMIT'), />= 0/);
});
