import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry } from '../src/router/capability-registry.mjs';

test('registers and retrieves model capabilities', () => {
  const registry = createCapabilityRegistry([
    {
      provider: 'ollama',
      modelId: 'qwen3:4b',
      version: 'qwen3:4b',
      capabilities: ['text', 'code', 'tools'],
      contextLimit: 32768,
      privacyTier: 'local_only',
      health: 'healthy',
      routingClass: 'primary'
    }
  ]);

  const model = registry.get('ollama', 'qwen3:4b', 'qwen3:4b');

  assert.ok(model);
  assert.equal(model.provider, 'ollama');
  assert.equal(model.modelId, 'qwen3:4b');
});

test('lists models by provider', () => {
  const registry = createCapabilityRegistry([
    {
      provider: 'ollama',
      modelId: 'qwen3:4b',
      capabilities: ['text', 'code'],
      health: 'healthy'
    },
    {
      provider: 'ollama',
      modelId: 'gemma3:4b',
      capabilities: ['text'],
      health: 'healthy'
    },
    {
      provider: 'other',
      modelId: 'model-a',
      capabilities: ['text'],
      health: 'healthy'
    }
  ]);

  assert.equal(registry.getByProvider('ollama').length, 2);
  assert.equal(registry.getByProvider('other').length, 1);
});

test('upsert replaces an existing model version', () => {
  const registry = createCapabilityRegistry();

  registry.upsert({
    provider: 'ollama',
    modelId: 'qwen3:4b',
    version: 'qwen3:4b',
    capabilities: ['text'],
    health: 'degraded'
  });

  registry.upsert({
    provider: 'ollama',
    modelId: 'qwen3:4b',
    version: 'qwen3:4b',
    capabilities: ['text', 'code', 'tools'],
    health: 'healthy'
  });

  assert.equal(registry.getAll().length, 1);
  assert.deepEqual(
    registry.get('ollama', 'qwen3:4b', 'qwen3:4b').capabilities,
    ['text', 'code', 'tools']
  );
});

test('health updates are recorded', () => {
  const registry = createCapabilityRegistry([
    {
      provider: 'ollama',
      modelId: 'qwen3:4b',
      version: 'qwen3:4b',
      capabilities: ['text', 'code'],
      health: 'healthy'
    }
  ]);

  const updated = registry.markHealth('ollama', 'qwen3:4b', 'degraded');

  assert.equal(updated.length, 1);
  assert.equal(
    registry.get('ollama', 'qwen3:4b', 'qwen3:4b').health,
    'degraded'
  );
  assert.ok(
    registry.get('ollama', 'qwen3:4b', 'qwen3:4b').lastCheckedAt
  );
});

test('missing model lookup returns null', () => {
  const registry = createCapabilityRegistry();

  assert.equal(
    registry.get('ollama', 'does-not-exist', 'does-not-exist'),
    null
  );
});

test('registers a probed Ollama model without granting automatic fallback', () => {
  const registry = createCapabilityRegistry();

  const probedModel = {
    provider: 'ollama',
    modelId: 'qwen3:4b',
    version: 'qwen3:4b',
    capabilities: ['text', 'tools'],
    contextLimit: 262144,
    privacyTier: 'local_only',
    health: 'healthy',
    routingClass: 'support_only',
    automaticFallbackAllowed: false
  };

  const registered = registry.upsert(probedModel);

  assert.equal(registered.provider, 'ollama');
  assert.equal(registered.modelId, 'qwen3:4b');
  assert.equal(registered.contextLimit, 262144);
  assert.equal(registered.privacyTier, 'local_only');
  assert.equal(registered.routingClass, 'support_only');
  assert.equal(registered.automaticFallbackAllowed, false);

  assert.deepEqual(
    registry.get('ollama', 'qwen3:4b', 'qwen3:4b'),
    registered
  );
});