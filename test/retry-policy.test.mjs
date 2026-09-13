import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRetry,
  nextRetryDelayMs
} from '../src/router/retry-policy.mjs';

test('transient errors are retryable within the retry limit', () => {
  const error = {
    type: 'transient',
    retryable: true
  };

  assert.equal(
    canRetry(error, 0, 2),
    true
  );

  assert.equal(
    canRetry(error, 1, 2),
    true
  );

  assert.equal(
    canRetry(error, 2, 2),
    false
  );
});

test('non-retryable errors never retry', () => {
  const error = {
    type: 'quota',
    retryable: false
  };

  assert.equal(
    canRetry(error, 0, 2),
    false
  );
});

test('retry delays are bounded exponential backoff', () => {
  assert.equal(nextRetryDelayMs(0, 100), 100);
  assert.equal(nextRetryDelayMs(1, 100), 200);
  assert.equal(nextRetryDelayMs(2, 100), 400);
});

test('retry delay respects the maximum delay', () => {
  assert.equal(
    nextRetryDelayMs(10, 100, 1000),
    1000
  );
});