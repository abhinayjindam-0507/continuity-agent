import { createModelCapability } from '../router/model-capability.mjs';

function normalizeCapabilities(rawCapabilities = []) {
  const capabilities = new Set();

  for (const capability of rawCapabilities) {
    if (capability === 'completion') capabilities.add('text');
    if (capability === 'tools') capabilities.add('tools');
    if (capability === 'vision') capabilities.add('vision');
    if (capability === 'browser') capabilities.add('browser');
  }

  return [...capabilities];
}

export async function discoverOllamaModels(endpoint) {
  const response = await fetch(`${endpoint}/api/tags`, {
    signal: AbortSignal.timeout(5_000)
  });

  if (!response.ok) {
    throw new Error(
      `Ollama model catalogue returned ${response.status}: ${(await response.text()).slice(0, 400)}`
    );
  }

  const body = await response.json();

  return Array.isArray(body.models)
    ? body.models.map(model => ({
        modelId: model.name,
        version: model.digest || model.name,
        sizeBytes: Number.isFinite(model.size) ? model.size : 0
      }))
    : [];
}

export async function probeOllamaModel(endpoint, modelId) {
  const response = await fetch(`${endpoint}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: modelId }),
    signal: AbortSignal.timeout(5_000)
  });

  if (!response.ok) {
    throw new Error(
      `Ollama model probe returned ${response.status}: ${(await response.text()).slice(0, 400)}`
    );
  }

  const body = await response.json();

  const contextKey = Object.keys(body.model_info ?? {})
    .find((key) => key.endsWith('.context_length'));

  const contextLimit =
    contextKey && Number.isInteger(body.model_info[contextKey])
      ? body.model_info[contextKey]
      : 0;

  return createModelCapability({
    provider: 'ollama',
    modelId,
    version: body.details?.digest || modelId,
    capabilities: normalizeCapabilities(body.capabilities),
    contextLimit,
    privacyTier: 'local_only',
    health: 'healthy',
    routingClass: 'support_only',
    automaticFallbackAllowed: false,
    lastCheckedAt: new Date().toISOString()
  });
}