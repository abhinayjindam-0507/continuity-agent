import {
  ProviderError,
  PROVIDER_ERROR_TYPES
} from '../src/providers/provider-error.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ollamaChat } from '../src/providers/ollama.mjs';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('ollamaChat returns a successful response', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(
      url,
      'http://ollama.test/api/chat'
    );

    assert.equal(options.method, 'POST');

    const body = JSON.parse(options.body);

    assert.equal(body.model, 'qwen3:4b');
    assert.deepEqual(body.messages, [
      {
        role: 'user',
        content: 'Hello'
      }
    ]);
    assert.deepEqual(body.tools, []);

    return new Response(
      JSON.stringify({
        message: {
          role: 'assistant',
          content: 'Hello back.'
        }
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  };

  const result = await ollamaChat(
    'http://ollama.test',
    'qwen3:4b',
    [
      {
        role: 'user',
        content: 'Hello'
      }
    ],
    []
  );

  assert.deepEqual(result, {
    message: {
      role: 'assistant',
      content: 'Hello back.'
    }
  });
});

test('ollamaChat reports non-success responses', async () => {
  globalThis.fetch = async () =>
    new Response('model not found', {
      status: 404
    });

  await assert.rejects(
    () =>
      ollamaChat(
        'http://ollama.test',
        'missing-model',
        [],
        []
      ),
    /Ollama returned 404: model not found/
  );
});

test('ollamaChat propagates transport failures', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    () =>
      ollamaChat(
        'http://ollama.test',
        'qwen3:4b',
        [],
        []
      ),
    /fetch failed/
  );
});
test('ProviderError preserves failure classification metadata', () => {
  const error = new ProviderError('Rate limited', {
    type: PROVIDER_ERROR_TYPES.quota,
    provider: 'ollama',
    status: 429,
    retryable: false
  });

  assert.equal(error.name, 'ProviderError');
  assert.equal(error.message, 'Rate limited');
  assert.equal(error.type, 'quota');
  assert.equal(error.provider, 'ollama');
  assert.equal(error.status, 429);
  assert.equal(error.retryable, false);
});

test('ollamaChat classifies rate limits as quota errors', async () => {
  globalThis.fetch = async () =>
    new Response('too many requests', {
      status: 429
    });

  await assert.rejects(
    () =>
      ollamaChat(
        'http://ollama.test',
        'qwen3:4b',
        [],
        []
      ),
    error => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.provider, 'ollama');
      assert.equal(error.status, 429);
      assert.equal(error.type, PROVIDER_ERROR_TYPES.quota);
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test('ollamaChat classifies server failures as transient errors', async () => {
  globalThis.fetch = async () =>
    new Response('temporary server failure', {
      status: 503
    });

  await assert.rejects(
    () =>
      ollamaChat(
        'http://ollama.test',
        'qwen3:4b',
        [],
        []
      ),
    error => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.type, PROVIDER_ERROR_TYPES.transient);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test('ollamaChat classifies missing models as unavailable', async () => {
  globalThis.fetch = async () =>
    new Response('model not found', {
      status: 404
    });

  await assert.rejects(
    () =>
      ollamaChat(
        'http://ollama.test',
        'missing-model',
        [],
        []
      ),
    error => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.type, PROVIDER_ERROR_TYPES.unavailable);
      assert.equal(error.status, 404);
      assert.equal(error.retryable, false);
      return true;
    }
  );
});