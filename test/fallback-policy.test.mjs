import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldRetryProviderError,
  shouldFallbackProviderError,
  shouldPauseProviderError
} from '../src/router/fallback-policy.mjs';

import { ProviderError, PROVIDER_ERROR_TYPES } from '../src/providers/provider-error.mjs';

test('transient provider errors are retryable', () => {
  const error = new ProviderError('temporary failure', {
    type: PROVIDER_ERROR_TYPES.transient,
    provider: 'ollama',
    status: 503,
    retryable: true
  });

  assert.equal(shouldRetryProviderError(error), true);
  assert.equal(shouldFallbackProviderError(error), true);
  assert.equal(shouldPauseProviderError(error), false);
});

test('unavailable provider errors permit fallback but not retry', () => {
  const error = new ProviderError('model unavailable', {
    type: PROVIDER_ERROR_TYPES.unavailable,
    provider: 'ollama',
    status: 404,
    retryable: false
  });

  assert.equal(shouldRetryProviderError(error), false);
  assert.equal(shouldFallbackProviderError(error), true);
  assert.equal(shouldPauseProviderError(error), false);
});

test('quota errors do not retry or fallback', () => {
  const error = new ProviderError('rate limited', {
    type: PROVIDER_ERROR_TYPES.quota,
    provider: 'ollama',
    status: 429,
    retryable: false
  });

  assert.equal(shouldRetryProviderError(error), false);
  assert.equal(shouldFallbackProviderError(error), false);
  assert.equal(shouldPauseProviderError(error), true);
});

test('authentication errors pause execution', () => {
  const error = new ProviderError('authentication failed', {
    type: PROVIDER_ERROR_TYPES.authentication,
    provider: 'ollama',
    status: 401,
    retryable: false
  });

  assert.equal(shouldRetryProviderError(error), false);
  assert.equal(shouldFallbackProviderError(error), false);
  assert.equal(shouldPauseProviderError(error), true);
});

test('invalid requests pause execution', () => {
  const error = new ProviderError('invalid request', {
    type: PROVIDER_ERROR_TYPES.invalid_request,
    provider: 'ollama',
    status: 400,
    retryable: false
  });

  assert.equal(shouldRetryProviderError(error), false);
  assert.equal(shouldFallbackProviderError(error), false);
  assert.equal(shouldPauseProviderError(error), true);
});

test('unknown provider errors fail closed', () => {
  const error = new ProviderError('unknown failure', {
    type: PROVIDER_ERROR_TYPES.unknown,
    provider: 'ollama',
    retryable: false
  });

  assert.equal(shouldRetryProviderError(error), false);
  assert.equal(shouldFallbackProviderError(error), false);
  assert.equal(shouldPauseProviderError(error), true);
});