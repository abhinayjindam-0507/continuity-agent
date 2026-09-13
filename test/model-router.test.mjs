import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry } from '../src/router/capability-registry.mjs';
import { createModelRouter } from '../src/router/model-router.mjs';

function makeRegistry() {
  return createCapabilityRegistry([
    {
      provider: 'ollama',
      modelId: 'qwen3:4b',
      version: 'qwen3:4b',
      capabilities: ['text', 'code', 'tools'],
      contextLimit: 32768,
      privacyTier: 'local_only',
      health: 'healthy',
      routingClass: 'primary',
      automaticFallbackAllowed: true
    },
    {
      provider: 'ollama',
      modelId: 'small-support',
      version: 'small-support',
      capabilities: ['text'],
      contextLimit: 8192,
      privacyTier: 'local_only',
      health: 'healthy',
      routingClass: 'support_only'
    },
    {
      provider: 'ollama',
      modelId: 'unavailable-code',
      version: 'unavailable-code',
      capabilities: ['text', 'code', 'tools'],
      contextLimit: 32768,
      privacyTier: 'local_only',
      health: 'unavailable',
      routingClass: 'fallback',
      automaticFallbackAllowed: true
    },
    {
      provider: 'remote-code',
      modelId: 'cloud-code',
      version: 'cloud-code',
      capabilities: ['text', 'code', 'tools'],
      contextLimit: 65536,
      privacyTier: 'cloud_approved',
      health: 'healthy',
      routingClass: 'fallback',
      automaticFallbackAllowed: true
    }
  ]);
}

test('filters unavailable models', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['unavailable-code', 'qwen3:4b'] }
  });

  const models = router.getEligibleModels({
    capabilities: ['code']
  });

  assert.deepEqual(
    models.map(model => model.modelId),
    ['qwen3:4b', 'cloud-code']
  );
});

test('filters by required capabilities', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['qwen3:4b', 'small-support'] }
  });

  const models = router.getEligibleModels({
    capabilities: ['tools']
  });

  assert.deepEqual(
    models.map(model => model.modelId),
    ['qwen3:4b', 'cloud-code']
  );
});

test('filters by privacy tier', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['cloud-code', 'qwen3:4b'] }
  });

  const models = router.getEligibleModels({
    capabilities: ['code'],
    privacyTier: 'local_only'
  });

  assert.deepEqual(
    models.map(model => model.modelId),
    ['qwen3:4b']
  );
});

test('filters by minimum context limit', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['small-support', 'qwen3:4b'] }
  });

  const models = router.getEligibleModels({
    minContextLimit: 16000
  });

  assert.deepEqual(
    models.map(model => model.modelId),
    ['qwen3:4b', 'cloud-code']
  );
});

test('filters automatic fallback eligibility', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['small-support', 'qwen3:4b'] }
  });

  const models = router.getEligibleModels({
    requireAutomaticFallback: true
  });

  assert.deepEqual(
    models.map(model => model.modelId),
    ['qwen3:4b', 'unavailable-code', 'cloud-code']
      .filter(modelId => modelId !== 'unavailable-code')
  );
});

test('selection respects configured fallback order', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['cloud-code', 'qwen3:4b'] }
  });

  const selected = router.select({
    capabilities: ['code']
  });

  assert.ok(selected);
  assert.equal(selected.modelId, 'cloud-code');
});

test('selection returns null when no model is eligible', () => {
  const registry = makeRegistry();
  const router = createModelRouter({
    registry,
    config: { fallbackOrder: ['small-support'] }
  });

  const selected = router.select({
    capabilities: ['vision']
  });

  assert.equal(selected, null);
});

test('discovered Ollama models remain ineligible for automatic fallback by default', () => {
  const registry = createCapabilityRegistry([
    {
      provider: 'ollama',
      modelId: 'qwen3:4b',
      version: 'qwen3:4b',
      capabilities: ['text', 'tools'],
      contextLimit: 262144,
      privacyTier: 'local_only',
      health: 'healthy',
      routingClass: 'support_only',
      automaticFallbackAllowed: false
    }
  ]);

  const router = createModelRouter({
    registry,
    config: {
      fallbackOrder: ['qwen3:4b']
    }
  });

  const eligible = router.getEligibleModels({
    capabilities: ['text', 'tools'],
    privacyTier: 'local_only',
    requireAutomaticFallback: true
  });

  assert.deepEqual(eligible, []);
  assert.equal(
    router.select({
      capabilities: ['text', 'tools'],
      privacyTier: 'local_only',
      requireAutomaticFallback: true
    }),
    null
  );
});