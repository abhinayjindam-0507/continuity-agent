import { createModelCapability } from './model-capability.mjs';

export function createCapabilityRegistry(initialModels = []) {
  const models = new Map();

  function upsert(input) {
    const record = createModelCapability(input);
    const key = `${record.provider}:${record.modelId}:${record.version}`;
    models.set(key, record);
    return record;
  }

  function getAll() {
    return [...models.values()];
  }

  function getByProvider(provider) {
    return getAll().filter(model => model.provider === provider);
  }

  function get(provider, modelId, version = modelId) {
    return models.get(`${provider}:${modelId}:${version}`) || null;
  }

  function markHealth(provider, modelId, health) {
    const matches = getByProvider(provider)
      .filter(model => model.modelId === modelId);

    for (const model of matches) {
      model.health = health;
      model.lastCheckedAt = new Date().toISOString();
    }

    return matches;
  }

  for (const model of initialModels) upsert(model);

  return {
    upsert,
    getAll,
    getByProvider,
    get,
    markHealth
  };
}
