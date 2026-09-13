import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapability } from '../src/router/model-capability.mjs';

test('creates a valid local model capability record', () => {
  const model = createModelCapability({
    provider: 'ollama',
    modelId: 'qwen3:4b',
    version: 'qwen3:4b',
    capabilities: ['text', 'code', 'tools', 'unknown'],
    contextLimit: 32768,
    privacyTier: 'local_only',
    health: 'healthy',
    routingClass: 'primary'
  });

  assert.equal(model.provider, 'ollama');
  assert.equal(model.modelId, 'qwen3:4b');
  assert.deepEqual(model.capabilities, ['text', 'code', 'tools']);
  assert.equal(model.contextLimit, 32768);
  assert.equal(model.privacyTier, 'local_only');
  assert.equal(model.health, 'healthy');
  assert.equal(model.routingClass, 'primary');
});

test('applies safe defaults', () => {
  const model = createModelCapability({
    provider: 'ollama',
    modelId: 'qwen3:4b'
  });

  assert.deepEqual(model.capabilities, []);
  assert.equal(model.contextLimit, 0);
  assert.equal(model.privacyTier, 'local_only');
  assert.equal(model.health, 'unavailable');
  assert.equal(model.routingClass, 'support_only');
  assert.ok(model.lastCheckedAt);
});

test('rejects a missing provider', () => {
  assert.throws(
    () => createModelCapability({ modelId: 'qwen3:4b' }),
    /Model provider is required/
  );
});

test('rejects a missing model ID', () => {
  assert.throws(
    () => createModelCapability({ provider: 'ollama' }),
    /Model ID is required/
  );
});
