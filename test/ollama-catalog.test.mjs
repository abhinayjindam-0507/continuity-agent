import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverOllamaModels,
  probeOllamaModel
} from '../src/providers/ollama-catalog.mjs';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('discoverOllamaModels returns installed model metadata', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://ollama.test/api/tags');

    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'qwen3:4b',
            digest: 'sha256-test-digest',
            size: 123456789
          },
          {
            name: 'other-model',
            digest: 'sha256-other',
            size: 987654321
          }
        ]
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  };

  const models = await discoverOllamaModels('http://ollama.test');

  assert.deepEqual(models, [
    {
      modelId: 'qwen3:4b',
      version: 'sha256-test-digest',
      sizeBytes: 123456789
    },
    {
      modelId: 'other-model',
      version: 'sha256-other',
      sizeBytes: 987654321
    }
  ]);
});

test('probeOllamaModel maps runtime capabilities and context length', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://ollama.test/api/show');
    assert.equal(options.method, 'POST');

    return new Response(
      JSON.stringify({
        details: {
          digest: 'sha256-qwen-test'
        },
        capabilities: [
          'completion',
          'tools'
        ],
        model_info: {
          'qwen3.context_length': 262144
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

  const model = await probeOllamaModel(
    'http://ollama.test',
    'qwen3:4b'
  );

  assert.equal(model.provider, 'ollama');
  assert.equal(model.modelId, 'qwen3:4b');
  assert.equal(model.version, 'sha256-qwen-test');
  assert.deepEqual(model.capabilities, [
    'text',
    'tools'
  ]);
  assert.equal(model.contextLimit, 262144);
  assert.equal(model.privacyTier, 'local_only');
  assert.equal(model.health, 'healthy');
  assert.equal(model.routingClass, 'support_only');
  assert.equal(model.automaticFallbackAllowed, false);
});

test('probeOllamaModel defaults context length to zero when unavailable', async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        details: {},
        capabilities: ['completion'],
        model_info: {}
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  };

  const model = await probeOllamaModel(
    'http://ollama.test',
    'test-model'
  );

  assert.equal(model.contextLimit, 0);
  assert.deepEqual(model.capabilities, ['text']);
});

test('discoverOllamaModels rejects non-success responses', async () => {
  globalThis.fetch = async () => {
    return new Response('Ollama unavailable', {
      status: 503
    });
  };

  await assert.rejects(
    () => discoverOllamaModels('http://ollama.test'),
    /Ollama model catalogue returned 503/
  );
});

test('probeOllamaModel rejects non-success responses', async () => {
  globalThis.fetch = async () => {
    return new Response('Model unavailable', {
      status: 404
    });
  };

  await assert.rejects(
    () => probeOllamaModel('http://ollama.test', 'missing-model'),
    /Ollama model probe returned 404/
  );
});